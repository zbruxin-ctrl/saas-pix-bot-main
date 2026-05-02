// referral.ts — handler do comando /indicar
import { Context } from 'grammy';
import { registerReferral, getReferralStats } from '../services/referralClient';
import { logger } from '../lib/logger';

const BOT_USERNAME = process.env.BOT_USERNAME ?? '';

/**
 * Handler do comando /indicar
 * Exibe o link de indicação personalizado do usuário e suas estatísticas.
 */
export async function handleReferral(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id);
  if (!telegramId) return;

  // Link de indicação usa deep link do Telegram: t.me/BOT?start=ref_TELEGRAMID
  const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;

  let statsText = '';
  try {
    const stats = await getReferralStats(telegramId);
    if (stats.totalReferred > 0) {
      statsText =
        `\n\n📊 *Suas indicações*\n` +
        `• Amigos indicados: *${stats.totalReferred}*\n` +
        `• Total ganho: *R$ ${stats.totalEarned.toFixed(2)}*`;
    }
  } catch (err) {
    logger.warn('[referral] Erro ao buscar stats:', err);
  }

  await ctx.reply(
    `🎁 *Programa de Indicação*\n\n` +
    `Indique amigos e ganhe saldo toda vez que eles fizerem o primeiro pedido!\n\n` +
    `🔗 *Seu link personalizado:*\n` +
    `\`${refLink}\`` +
    statsText +
    `\n\nCompartilhe esse link e o crédito cai automaticamente no seu saldo. 🚀`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Processa o deep link de indicação quando um novo usuário abre o bot com ?start=ref_XXX
 * Deve ser chamado no handler de /start antes de exibir o menu principal.
 */
export async function processReferralStart(
  ctx: Context,
  startPayload: string
): Promise<void> {
  if (!startPayload.startsWith('ref_')) return;

  const referrerTelegramId = startPayload.replace('ref_', '');
  const referredTelegramId = String(ctx.from?.id);

  if (!referredTelegramId || referrerTelegramId === referredTelegramId) return;

  const result = await registerReferral(referrerTelegramId, referredTelegramId);
  if (result.success) {
    logger.info(`[referral] Novo indicado ${referredTelegramId} via ${referrerTelegramId}`);
  }
}
