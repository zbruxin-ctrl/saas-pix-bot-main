// webhooks.ts
// FIX RACE: create atomico com status=PROCESSING garante que apenas UM processo executa entrega.
// Se o create falhar por unique constraint, o concorrente verifica o status existente:
//   - RECEIVED: tenta assumir o lock com updateMany WHERE status=RECEIVED
//   - qualquer outro: aborta
// FIX WEBHOOK-KEY: eventType agora usa `action` (ex: "payment.updated") quando disponível,
//   evitando colisão de unique constraint entre payment.created e payment.updated.
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma, WebhookEventStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { paymentService } from '../services/paymentService';
import { mercadoPagoService } from '../services/mercadoPagoService';
import { webhookRateLimit } from '../middleware/rateLimit';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export const webhooksRouter = Router();

const HANDLED_ACTIONS = ['payment.updated', 'payment.created', 'payment'];
const APPROVED_STATUS = 'approved';

const WEBHOOK_SECRET_PLACEHOLDER = 'dev_placeholder_troque_em_producao';
const isWebhookSignatureEnabled =
  env.MERCADO_PAGO_WEBHOOK_SECRET !== undefined &&
  env.MERCADO_PAGO_WEBHOOK_SECRET !== WEBHOOK_SECRET_PLACEHOLDER &&
  env.MERCADO_PAGO_WEBHOOK_SECRET.length >= 16;

if (!isWebhookSignatureEnabled && env.NODE_ENV === 'production') {
  logger.error(
    '\uD83D\uDEA8 [CR\u00cdTICO] MERCADO_PAGO_WEBHOOK_SECRET n\u00e3o configurado ou inv\u00e1lido. ' +
    'Valida\u00e7\u00e3o HMAC DESABILITADA \u2014 configure a vari\u00e1vel no Railway imediatamente.'
  );
}

webhooksRouter.post(
  '/mercadopago',
  webhookRateLimit,
  async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const bodyString = rawBody.toString('utf-8');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyString);
    } catch {
      logger.warn('Webhook: payload inv\u00e1lido recebido');
      res.status(400).json({ error: 'Payload inv\u00e1lido' });
      return;
    }

    const isValid = isWebhookSignatureEnabled
      ? validateWebhookSignature(req, bodyString)
      : true;

    if (!isValid) {
      logger.warn('Webhook: assinatura inv\u00e1lida', { ip: req.ip });
      res.status(200).json({ status: 'ignored' });
      return;
    }

    if (!isWebhookSignatureEnabled && env.NODE_ENV === 'production') {
      logger.warn('Webhook aceito SEM valida\u00e7\u00e3o HMAC \u2014 configure MERCADO_PAGO_WEBHOOK_SECRET');
    }

    const eventType = payload.type as string | undefined;
    const dataId = (payload.data as { id?: string })?.id;
    const action = payload.action as string | undefined;

    // Usa action como chave de evento quando dispon\u00edvel (ex: "payment.updated"),
    // pois o eventType ("payment") \u00e9 o mesmo para created e updated.
    const resolvedEventType = action || eventType || 'unknown';

    logger.info(`Webhook recebido: tipo=${eventType} | action=${action} | id=${dataId}`);

    // Responde 200 imediatamente para o MP n\u00e3o retentar por timeout
    res.status(200).json({ status: 'received' });

    processWebhookAsync(resolvedEventType, dataId, payload).catch((error) => {
      logger.error('Erro no processamento ass\u00edncrono do webhook:', error);
    });
  }
);

async function processWebhookAsync(
  resolvedEventType: string,
  externalId: string | undefined,
  rawPayload: Record<string, unknown>
): Promise<void> {
  if (!externalId) {
    logger.warn('Webhook sem ID de pagamento, ignorando');
    return;
  }

  if (!HANDLED_ACTIONS.includes(resolvedEventType)) {
    logger.info(`Webhook: tipo ${resolvedEventType} ignorado`);
    return;
  }

  // FIX RACE: tenta CREATE com status=PROCESSING diretamente.
  // Se unique constraint falhar (j\u00e1 existe), tenta assumir o lock
  // s\u00f3 se o registro ainda estiver em RECEIVED.
  let webhookEventId: string;

  try {
    const created = await prisma.webhookEvent.create({
      data: {
        provider: 'mercado_pago',
        eventType: resolvedEventType,
        externalId,
        rawPayload: rawPayload as unknown as Prisma.InputJsonValue,
        status: WebhookEventStatus.PROCESSING,
      },
      select: { id: true },
    });
    webhookEventId = created.id;
  } catch {
    // Unique constraint: registro j\u00e1 existe. Verifica se ainda est\u00e1 em RECEIVED.
    const existing = await prisma.webhookEvent.findUnique({
      where: {
        provider_externalId_eventType: {
          provider: 'mercado_pago',
          externalId,
          eventType: resolvedEventType,
        },
      },
      select: { id: true, status: true },
    });

    if (!existing) {
      logger.warn(`Webhook ${externalId}: registro desapareceu ap\u00f3s conflito, abortando`);
      return;
    }

    if (existing.status !== WebhookEventStatus.RECEIVED) {
      logger.info(`Webhook ${externalId}: status=${existing.status}, j\u00e1 em processamento/conclu\u00eddo. Ignorando.`);
      return;
    }

    // Tenta transi\u00e7\u00e3o at\u00f4mica RECEIVED \u2192 PROCESSING
    const locked = await prisma.webhookEvent.updateMany({
      where: { id: existing.id, status: WebhookEventStatus.RECEIVED },
      data: { status: WebhookEventStatus.PROCESSING },
    });

    if (locked.count === 0) {
      logger.info(`Webhook ${externalId}: outro processo assumiu o lock, abortando`);
      return;
    }

    webhookEventId = existing.id;
  }

  // Apenas UM processo chega aqui por externalId+resolvedEventType
  try {
    const mpPayment = await mercadoPagoService.getPaymentById(externalId);

    if (mpPayment.status !== APPROVED_STATUS) {
      logger.info(`Webhook: pagamento ${externalId} com status ${mpPayment.status}. Ignorando.`);
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: { status: WebhookEventStatus.IGNORED, processedAt: new Date() },
      });
      return;
    }

    const internalPayment =
      await prisma.payment.findUnique({ where: { mercadoPagoId: externalId } }) ||
      await prisma.payment.findUnique({ where: { id: mpPayment.external_reference } });

    if (!internalPayment) {
      logger.error(`Webhook: pagamento interno n\u00e3o encontrado para MP ID ${externalId}`);
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          status: WebhookEventStatus.FAILED,
          error: 'Pagamento interno n\u00e3o encontrado',
          processedAt: new Date(),
        },
      });
      return;
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { paymentId: internalPayment.id },
    });

    await paymentService.processApprovedPayment(internalPayment.id);

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date() },
    });

    logger.info(`Webhook processado com sucesso: pagamento ${internalPayment.id}`);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error(`Erro ao processar webhook ${externalId}:`, error);
    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { status: WebhookEventStatus.FAILED, error: errorMsg, processedAt: new Date() },
    }).catch(() => {});
  }
}

function validateWebhookSignature(req: Request, body: string): boolean {
  try {
    if (env.NODE_ENV === 'development') return true;

    const xSignature = req.headers['x-signature'] as string | undefined;
    const xRequestId = req.headers['x-request-id'] as string | undefined;

    if (!xSignature || !xRequestId) return false;

    const parts = xSignature.split(',');
    const tsPart = parts.find((p) => p.startsWith('ts='));
    const v1Part = parts.find((p) => p.startsWith('v1='));
    if (!tsPart || !v1Part) return false;

    const ts = tsPart.split('=')[1];
    const signature = v1Part.split('=')[1];

    let dataId = (req.query['data.id'] as string) || (req.query['id'] as string) || '';
    if (!dataId) {
      try { dataId = (JSON.parse(body)?.data?.id as string) || ''; } catch { /* ignore */ }
    }

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

    const expectedSignature = crypto
      .createHmac('sha256', env.MERCADO_PAGO_WEBHOOK_SECRET!)
      .update(manifest)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== receivedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch (error) {
    logger.error('Erro ao validar assinatura do webhook:', error);
    return false;
  }
}
