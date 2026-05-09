// routes/kyc.ts
// Recebe webhooks do Socure e do Veriff, detecta o provider pelo header/payload
// e salva no kycLogStore para exibição no painel admin.
//
// Socure:  POST /api/kyc/webhook/socure
//          Header: X-Socure-Event-Token (opcional, validação futura)
//          Payload: { event: string, data: { referenceId: string, ... } }
//
// Veriff:  POST /api/kyc/webhook/veriff
//          Header: X-HMAC-SIGNATURE (opcional, validação futura)
//          Payload: { status: string, verification: { id: string, ... } }

import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';
import { appendKycLog } from '../lib/kycLogStore';

export const kycRouter = Router();

// --- Socure ---
kycRouter.post('/webhook/socure', (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;

    const event = (body.event as string) || 'unknown';
    const data = (body.data as Record<string, unknown>) || {};
    const referenceId =
      (data.referenceId as string) ||
      (data.customerId as string) ||
      (body.referenceId as string) ||
      'n/a';
    const status =
      (data.decision as string) ||
      (data.status as string) ||
      (body.status as string) ||
      'received';

    const log = appendKycLog({
      provider: 'socure',
      event,
      status,
      referenceId,
      rawPayload: body,
    });

    logger.info(`[KYC] Socure webhook recebido | event=${event} | status=${status} | ref=${referenceId} | id=${log.id}`);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[KYC] Erro ao processar webhook Socure:', err);
    res.status(200).json({ received: true }); // sempre 200 para não causar retry
  }
});

// --- Veriff ---
kycRouter.post('/webhook/veriff', (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;

    const verification = (body.verification as Record<string, unknown>) || {};
    const event = (body.action as string) || 'DECISION_UPDATE';
    const referenceId =
      (verification.id as string) ||
      (body.id as string) ||
      'n/a';
    const status =
      (verification.status as string) ||
      (verification.decision as string) ||
      (body.status as string) ||
      'received';

    const log = appendKycLog({
      provider: 'veriff',
      event,
      status,
      referenceId,
      rawPayload: body,
    });

    logger.info(`[KYC] Veriff webhook recebido | event=${event} | status=${status} | ref=${referenceId} | id=${log.id}`);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[KYC] Erro ao processar webhook Veriff:', err);
    res.status(200).json({ received: true });
  }
});
