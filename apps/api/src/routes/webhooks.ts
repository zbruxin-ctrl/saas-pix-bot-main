// webhooks.ts
// FIX RACE: create atomico com status=PROCESSING garante que apenas UM processo executa entrega.
// Se o create falhar por unique constraint, o concorrente verifica o status existente:
//   - RECEIVED: tenta assumir o lock com updateMany WHERE status=RECEIVED
//   - qualquer outro: aborta
// FIX WEBHOOK-KEY: eventType agora usa `action` (ex: "payment.updated") quando disponível,
//   evitando colisão de unique constraint entre payment.created e payment.updated.
// FIX LEGACY-WEBHOOK: MP envia DOIS requests por evento:
//   1. Novo (V2): ?data.id=...&type=payment — inclui x-signature, processado normalmente
//   2. Legacy (V1): ?id=...&topic=payment — NÃO inclui x-signature
//   O formato legacy é ignorado silenciosamente (200 imediato) antes de qualquer
//   validação HMAC, eliminando o log "assinatura inválida" que era falso-positivo.
// AUDIT #3: Webhook retorna 503 em produção quando HMAC não está configurado —
//   antes, aceitava silenciosamente qualquer request sem assinatura, permitindo fraude.
// AUDIT #10: validateWebhookSignature valida que o timestamp `ts` está dentro de
//   ±5 minutos da hora atual — proteção anti-replay attack.
// VARREDURA2-FIX #5: fallback de busca de pagamento usa metadata.externalReference
//   em vez de payment.id, corrigindo caso onde mercadoPagoId não estava salvo.
// FIX-BUILD: processApprovedPayment renomeado para confirmApproval no paymentService.
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
    '\uD83D\uDEA8 [CRÍTICO] MERCADO_PAGO_WEBHOOK_SECRET não configurado ou inválido. ' +
    'Validação HMAC DESABILITADA — configure a variável no Railway imediatamente.'
  );
}

webhooksRouter.post(
  '/mercadopago',
  webhookRateLimit,
  async (req: Request, res: Response) => {
    // FIX LEGACY-WEBHOOK: formato legacy (V1) usa ?topic=payment e NÃO inclui x-signature.
    // Ignorado silenciosamente para evitar falso "assinatura inválida" nos logs.
    if (req.query.topic) {
      res.status(200).json({ status: 'legacy_ignored' });
      return;
    }

    const rawBody = req.body as Buffer;
    const bodyString = rawBody.toString('utf-8');

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyString);
    } catch {
      logger.warn('Webhook: payload inválido recebido');
      res.status(400).json({ error: 'Payload inválido' });
      return;
    }

    // AUDIT #3: em produção, rejeita com 503 se HMAC não estiver configurado.
    // Antes, aceitava silenciosamente qualquer POST sem assinatura — vetor de fraude.
    if (!isWebhookSignatureEnabled) {
      if (env.NODE_ENV === 'production') {
        logger.error('[webhook] BLOQUEADO: HMAC não configurado em produção. Configure MERCADO_PAGO_WEBHOOK_SECRET.');
        res.status(503).json({ error: 'Webhook desabilitado: configure MERCADO_PAGO_WEBHOOK_SECRET no Railway' });
        return;
      }
      // dev: passa sem validação (aviso já logado na inicialização)
    } else {
      if (!validateWebhookSignature(req, bodyString)) {
        logger.warn('Webhook: assinatura inválida', { ip: req.ip });
        res.status(200).json({ status: 'ignored' });
        return;
      }
    }

    const eventType = payload.type as string | undefined;
    const dataId = (payload.data as { id?: string })?.id;
    const action = payload.action as string | undefined;

    // Usa action como chave de evento quando disponível (ex: "payment.updated"),
    // pois o eventType ("payment") é o mesmo para created e updated.
    const resolvedEventType = action || eventType || 'unknown';

    logger.info(`Webhook recebido: tipo=${eventType} | action=${action} | id=${dataId}`);

    // Responde 200 imediatamente para o MP não retentar por timeout
    res.status(200).json({ status: 'received' });

    processWebhookAsync(resolvedEventType, dataId, payload).catch((error) => {
      logger.error('Erro no processamento assíncrono do webhook:', error);
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
      logger.warn(`Webhook ${externalId}: registro desapareceu após conflito, abortando`);
      return;
    }

    if (existing.status !== WebhookEventStatus.RECEIVED) {
      logger.info(`Webhook ${externalId}: status=${existing.status}, já em processamento/concluído. Ignorando.`);
      return;
    }

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

    // VARREDURA2-FIX #5: corrige fallback de busca do pagamento interno.
    let internalPayment = await prisma.payment.findUnique({ where: { mercadoPagoId: externalId } });

    if (!internalPayment && mpPayment.external_reference) {
      internalPayment = await prisma.payment.findFirst({
        where: {
          metadata: {
            path: ['externalReference'],
            equals: mpPayment.external_reference,
          },
        },
      });
    }

    if (!internalPayment) {
      logger.error(`Webhook: pagamento interno não encontrado para MP ID ${externalId} | external_reference=${mpPayment.external_reference}`);
      await prisma.webhookEvent.update({
        where: { id: webhookEventId },
        data: {
          status: WebhookEventStatus.FAILED,
          error: 'Pagamento interno não encontrado',
          processedAt: new Date(),
        },
      });
      return;
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { paymentId: internalPayment.id },
    });

    // FIX-BUILD: método renomeado de processApprovedPayment para confirmApproval
    await paymentService.confirmApproval(internalPayment.id);

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

    // AUDIT #10: valida que o timestamp está dentro de ±5 minutos.
    const tsMs = parseInt(ts, 10) * 1000;
    if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
      logger.warn('Webhook rejeitado: timestamp expirado ou inválido (possível replay attack)', { ts });
      return false;
    }

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
  } catch {
    return false;
  }
}
