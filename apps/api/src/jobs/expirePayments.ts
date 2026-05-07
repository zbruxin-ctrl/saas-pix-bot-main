// Job agendado: expira pagamentos pendentes cujo PIX já passou do prazo
// FIX B4/L2/M10: usa pixExpiresAt < now (campo correto do PIX) ao invés de createdAt < cutoff
//   Isso garante que apenas PIX realmente vencidos sejam expirados.
// FIX-BUILD: findExpiredPaymentIds e cancelExpiredPayment não existem no paymentService;
//   substituidos por query direta no prisma e cancelPayment respectivamente.
import { PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { paymentService } from '../services/paymentService';
import { stockService } from '../services/stockService';
import { logger } from '../lib/logger';

const JOB_INTERVAL_MS = 60 * 1000; // roda a cada 1 minuto

let jobTimer: ReturnType<typeof setInterval> | null = null;

async function runExpireJob(): Promise<void> {
  try {
    const now = new Date();

    // FIX B4: busca por pixExpiresAt < now — não por createdAt
    // Isso respeita o prazo real do QR Code (definido pelo Mercado Pago, geralmente 30min)
    // e evita expirar pagamentos criados há 31min mas cujo PIX ainda é válido.
    const expiredPayments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        pixExpiresAt: { lt: now },
      },
      select: { id: true },
    });

    const expiredIds = expiredPayments.map((p) => p.id);

    if (expiredIds.length > 0) {
      logger.info(`[ExpireJob] ${expiredIds.length} pagamentos a expirar`);
      await Promise.allSettled(
        expiredIds.map((id) => paymentService.cancelPayment(id))
      );
    }

    // Libera reservas de estoque com expiresAt no passado
    await stockService.releaseExpiredReservations();

  } catch (err) {
    logger.error('[ExpireJob] Erro durante execução:', err);
  }
}

export function startExpireJob(): void {
  if (jobTimer) return;
  logger.info(`[ExpireJob] Iniciado — intervalo: ${JOB_INTERVAL_MS / 1000}s`);
  void runExpireJob();
  jobTimer = setInterval(() => { void runExpireJob(); }, JOB_INTERVAL_MS);
}

export function stopExpireJob(): void {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
    logger.info('[ExpireJob] Parado');
  }
}
