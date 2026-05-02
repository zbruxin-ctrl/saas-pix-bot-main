// referralService.ts — programa de indicação
// FIX: payReferralReward agora aceita (tx, paymentId, rewardCallback) para ser
//      chamado dentro de prisma.$transaction no paymentService
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getSetting } from '../routes/admin/settings';
import type { Prisma } from '@prisma/client';

const DEFAULT_REWARD = 5.0; // R$ 5,00 por indicação

type TransactionClient = Prisma.TransactionClient;

type RewardCallback = (
  userId: string,
  amount: number,
  description: string,
  tx: TransactionClient
) => Promise<void>;

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

  const [referrer, referred] = await Promise.all([
    prisma.telegramUser.findUnique({ where: { telegramId: referrerTelegramId }, select: { id: true } }),
    prisma.telegramUser.findUnique({ where: { telegramId: referredTelegramId }, select: { id: true } }),
  ]);

  if (!referrer) return { registered: false, reason: 'Indicador não encontrado.' };
  if (!referred) return { registered: false, reason: 'Usuário indicado não encontrado.' };

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
 * Paga a recompensa ao indicador quando um pagamento do indicado é aprovado.
 * Deve ser chamado DENTRO de um prisma.$transaction existente.
 *
 * @param tx      - TransactionClient da transação em andamento
 * @param paymentId - ID do pagamento aprovado
 * @param onReward  - Callback que executa o crédito de saldo + WalletTransaction dentro da tx
 */
export async function payReferralReward(
  tx: TransactionClient,
  paymentId: string,
  onReward: RewardCallback
): Promise<void> {
  // Busca o pagamento para obter o telegramUserId
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { telegramUserId: true },
  });
  if (!payment) return;

  // Verifica se este usuário foi indicado e se a recompensa ainda não foi paga
  const referral = await tx.referral.findUnique({
    where: { referredId: payment.telegramUserId },
  });
  if (!referral || referral.rewardPaid) return;

  // Lê o valor de recompensa configurado no painel admin (fora da tx para não bloquear)
  const rewardRaw = await getSetting('referral_reward_amount');
  const rewardAmount = rewardRaw ? parseFloat(rewardRaw) : DEFAULT_REWARD;
  if (isNaN(rewardAmount) || rewardAmount <= 0) return;

  // Delega o crédito ao callback (quem chama decide o tipo de WalletTransaction)
  await onReward(
    referral.referrerId,
    rewardAmount,
    'Recompensa por indicação',
    tx
  );

  // Marca recompensa como paga
  await tx.referral.update({
    where: { id: referral.id },
    data: { rewardPaid: true, rewardAmount, paymentId },
  });

  logger.info(`[referral] Recompensa R$${rewardAmount} paga ao indicador userId=${referral.referrerId} paymentId=${paymentId}`);
}
