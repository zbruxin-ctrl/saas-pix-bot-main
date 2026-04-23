// Rota de webhook do Mercado Pago
// Recebe notificações de pagamentos aprovados/rejeitados
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { paymentService } from '../services/paymentService';
import { mercadoPagoService } from '../services/mercadoPagoService';
import { webhookRateLimit } from '../middleware/rateLimit';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export const webhooksRouter = Router();

// Tipos de eventos que processamos
const HANDLED_EVENTS = ['payment'];
const APPROVED_STATUS = 'approved';

// POST /api/webhooks/mercadopago
webhooksRouter.post(
  '/mercadopago',
  webhookRateLimit,
  async (req: Request, res: Response) => {
    // O body vem como Buffer (definido no index.ts)
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

    // Valida assinatura HMAC do Mercado Pago
    const isValid = validateWebhookSignature(req, bodyString);
    if (!isValid) {
      logger.warn('Webhook: assinatura inválida', {
        headers: req.headers,
        ip: req.ip,
      });
      // Retorna 200 para evitar reenvios, mas não processa
      res.status(200).json({ status: 'ignored' });
      return;
    }

    // Extrai dados do evento
    const eventType = payload.type as string;
    const dataId = (payload.data as { id?: string })?.id;
    const action = payload.action as string;

    logger.info(`Webhook recebido: tipo=${eventType} | action=${action} | id=${dataId}`);

    // Retorna 200 imediatamente (MP exige resposta rápida)
    res.status(200).json({ status: 'received' });

    // Processa assincronamente (não bloqueia a resposta)
    processWebhookAsync(eventType, dataId, payload).catch((error) => {
      logger.error('Erro no processamento assíncrono do webhook:', error);
    });
  }
);

// Processa o webhook de forma assíncrona
async function processWebhookAsync(
  eventType: string,
  externalId: string | undefined,
  rawPayload: Record<string, unknown>
): Promise<void> {
  if (!externalId) {
    logger.warn('Webhook sem ID de pagamento, ignorando');
    return;
  }

  // Apenas processa eventos de pagamento
  if (!HANDLED_EVENTS.includes(eventType)) {
    logger.info(`Webhook: tipo ${eventType} ignorado`);
    return;
  }

  // Verifica idempotência: ignora se já processamos este evento
  const existingEvent = await prisma.webhookEvent.findUnique({
    where: {
      provider_externalId_eventType: {
        provider: 'mercado_pago',
        externalId,
        eventType,
      },
    },
  });

  if (existingEvent && existingEvent.status === 'PROCESSED') {
    logger.info(`Webhook já processado: ${externalId}. Ignorando.`);
    return;
  }

  // Cria ou atualiza o evento de webhook
  const webhookEvent = await prisma.webhookEvent.upsert({
    where: {
      provider_externalId_eventType: {
        provider: 'mercado_pago',
        externalId,
        eventType,
      },
    },
    update: { status: 'PROCESSING' },
    create: {
      provider: 'mercado_pago',
      eventType,
      externalId,
      rawPayload: rawPayload as unknown as Prisma.InputJsonValue,
      status: 'PROCESSING',
    },
  });

  try {
    // Busca detalhes do pagamento no Mercado Pago
    const mpPayment = await mercadoPagoService.getPaymentById(externalId);

    // Só processa pagamentos aprovados
    if (mpPayment.status !== APPROVED_STATUS) {
      logger.info(`Webhook: pagamento ${externalId} com status ${mpPayment.status}. Ignorando.`);

      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'IGNORED', processedAt: new Date() },
      });
      return;
    }

    // Busca o pagamento interno pela referência externa do MP
    const internalPayment = await prisma.payment.findUnique({
      where: { mercadoPagoId: externalId },
    });

    // Tenta também pela external_reference (ID interno)
    const paymentByRef = internalPayment || await prisma.payment.findUnique({
      where: { id: mpPayment.external_reference },
    });

    if (!paymentByRef) {
      logger.error(`Webhook: pagamento interno não encontrado para MP ID ${externalId}`);
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: 'FAILED', error: 'Pagamento interno não encontrado', processedAt: new Date() },
      });
      return;
    }

    // Vincula o evento ao pagamento interno
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { paymentId: paymentByRef.id },
    });

    // Processa o pagamento aprovado
    await paymentService.processApprovedPayment(paymentByRef.id);

    // Marca evento como processado
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(`Webhook processado com sucesso: pagamento ${paymentByRef.id}`);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error(`Erro ao processar webhook ${externalId}:`, error);

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: 'FAILED', error: errorMsg, processedAt: new Date() },
    });
  }
}

// Valida a assinatura HMAC do Mercado Pago
// Documentação: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
function validateWebhookSignature(req: Request, body: string): boolean {
  try {
    // Em desenvolvimento, aceita sem validar
    if (env.NODE_ENV === 'development') {
      return true;
    }

    const xSignature = req.headers['x-signature'] as string;
    const xRequestId = req.headers['x-request-id'] as string;

    if (!xSignature || !xRequestId) {
      return false;
    }

    // Extrai ts e v1 da header x-signature
    const parts = xSignature.split(',');
    const tsPart = parts.find((p) => p.startsWith('ts='));
    const v1Part = parts.find((p) => p.startsWith('v1='));

    if (!tsPart || !v1Part) {
      return false;
    }

    const ts = tsPart.split('=')[1];
    const signature = v1Part.split('=')[1];

    // Monta a string para verificação conforme documentação do MP
    const manifest = `id:${(req.query.id as string) || ''};request-id:${xRequestId};ts:${ts};`;

    const expectedSignature = crypto
      .createHmac('sha256', env.MERCADO_PAGO_WEBHOOK_SECRET)
      .update(manifest)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    );
  } catch (error) {
    logger.error('Erro ao validar assinatura do webhook:', error);
    return false;
  }
}
