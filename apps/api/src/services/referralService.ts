// referralService.ts — programa de indicação
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getSetting } from '../routes/admin/settings';

const DEFAULT_REWARD = 5.0; // R$ 5,00 por indicação

/**
 * Registra que referredTelegramId foi indicado por referrerId.
 * - Idempotente: se já existe Referral para referredId, ignora.
 * - Bloqueia auto-indicação.
 */
export async function registerReferral(
  referrerTelegramId: string,
  referredTelegramId: string
): Promise<{ registered: boolean; reason?: string }> {
  if (referrerTelegramId === referredTelegramId) {
    return { registered: false, reason: 'Auto-indicação não permitida.' };
  }

  // Garante que ambos existam (usuário novo pode não estar no DB ainda)
  const [referrer, referred] = await Promise.all([
    prisma.telegramUser.findUnique({ where: { telegramId: referrerTelegramId }, select: { id: true } }),
    prisma.telegramUser.findUnique({ where: { telegramId: referredTelegramId }, select: { id: true } }),
  ]);

  if (!referrer) return { registered: false, reason: 'Indicador não encontrado.' };
  if (!referred) return { registered: false, reason: 'Usuário indicado não encontrado.' };

  // Verifica se o indicado já tem uma indicação registrada (referredId é @unique)
  const existing = await prisma.referral.findUnique({
    where: { referredId: referred.id },
  });
  if (existing) {
    return { registered: false, reason: 'Este usuário já foi indicado anteriormente.' };
  }

  await prisma.referral.create({
    data: {
      referrerId: referrer.id,
      referredId: referred.id,
    },
  });

  logger.info(`[referral] Registrado: referrer=${referrerTelegramId} referred=${referredTelegramId}`);
  return { registered: true };
}

/**
 * Paga a recompensa ao indicador quando o pagamento de um indicado é aprovado.
 * Deve ser chamado no webhook de pagamento aprovado.
 * Idempotente: ignora se rewardPaid=true.
 */
export async function payReferralReward(paymentId: string): Promise<void> {
  // Busca o pagamento e o usuário
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { telegramUserId: true },
  });
  if (!payment) return;

  // Verifica se este usuário foi indicado e se a recompensa ainda não foi paga
  const referral = await prisma.referral.findUnique({
    where: { referredId: payment.telegramUserId },
  });
  if (!referral || referral.rewardPaid) return;

  // Lê o valor de recompensa configurado no painel admin
  const rewardRaw = await getSetting('referral_reward_amount');
  const rewardAmount = rewardRaw ? parseFloat(rewardRaw) : DEFAULT_REWARD;
  if (isNaN(rewardAmount) || rewardAmount <= 0) return;

  // Credita saldo do indicador e marca recompensa como paga atomicamente
  await prisma.$transaction([
    prisma.telegramUser.update({
      where: { id: referral.referrerId },
      data: { balance: { increment: rewardAmount } },
    }),
    prisma.walletTransaction.create({
      data: {
        telegramUserId: referral.referrerId,
        type: 'DEPOSIT',
        amount: rewardAmount,
        description: 'Recompensa por indicação',
        paymentId,
      },
    }),
    prisma.referral.update({
      where: { id: referral.id },
      data: { rewardPaid: true, rewardAmount, paymentId },
    }),
  ]);

  logger.info(`[referral] Recompensa R$${rewardAmount} paga ao indicador userId=${referral.referrerId} paymentId=${paymentId}`);
}
