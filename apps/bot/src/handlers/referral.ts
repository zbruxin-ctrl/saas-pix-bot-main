/**
 * Handler do programa de indicação.
 *
 * FIX-REFERRAL-BOTUSERNAME: BOT_USERNAME agora lido de env validado
 *   (apps/bot/src/config/env.ts) em vez de process.env direto.
 *   Previne links quebrados silenciosos quando a variável não está definida.
 *
 * REFACTOR: extrai buildReferralPayload() eliminando duplicação entre
 *   showReferralMenu (callback) e handleReferral (comando /indicar).
 *
 * FIX-HANDLEREFERRAL-DEDUP: handleReferral reutiliza buildReferralButtons()
 *   em vez de duplicar shareUrl e teclado inline localmente.
 */
import { Context, Markup } from 'telegraf';
import { editOrReply } from '../utils/helpers';
import { registerReferral, getReferralStats } from '../services/referralClient';
import { env } from '../config/env';

// ─── Helpers internos ───────────────────────────────────────────────────────────────────────────────

function getRefLink(telegramId: string): string {
  const username = env.BOT_USERNAME;
  if (!username) {
    console.warn('[referral] BOT_USERNAME não configurado — links de indicação estarão quebrados!');
  }
  return `https://t.me/${username ?? ''}?start=ref_${telegramId}`;
}

interface ReferralStats {
  totalIndicados: number;
  totalCompraram: number;
  totalGanho: number;
}

async function fetchStats(telegramId: string): Promise<ReferralStats> {
  try {
    const stats = await getReferralStats(telegramId);
    return {
      totalIndicados: stats.totalReferred ?? 0,
      totalCompraram: stats.totalConverted ?? 0,
      totalGanho: stats.totalEarned ?? 0,
    };
  } catch (err) {
    console.warn('[referral] Erro ao buscar stats:', err);
    return { totalIndicados: 0, totalCompraram: 0, totalGanho: 0 };
  }
}

function buildReferralText(refLink: string, stats: ReferralStats): string {
  const statsBlock =
    `\n\n📊 <b>Suas estatísticas</b>\n` +
    `👥 Amigos indicados: <b>${stats.totalIndicados}</b>\n` +
    `✅ Amigos que compraram: <b>${stats.totalCompraram}</b>\n` +
    `💰 Total ganho em saldo: <b>R$ ${stats.totalGanho.toFixed(2)}</b>`;

  return (
    `🎁 <b>Indique e Ganhe</b>\n\n` +
    `Compartilhe seu link e ganhe saldo toda vez que um amigo fizer o <b>primeiro pedido</b>!\n\n` +
    `🔗 <b>Seu link de indicação:</b>\n` +
    `<code>${refLink}</code>` +
    statsBlock +
    `\n\n<i>O crédito cai automaticamente no seu saldo após o pagamento do indicado ser aprovado. 🚀</i>`
  );
}

function buildReferralButtons(refLink: string) {
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Use meu link e ganhe desconto!')}`;
  return [
    [Markup.button.url('📤 Compartilhar link', shareUrl)],
    [Markup.button.callback('◀️ Voltar ao Menu', 'show_home')],
  ];
}

// ─── Menu inline de Indicação (callback show_referral) ──────────────────────────────────────────

export async function showReferralMenu(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id);
  if (!telegramId || telegramId === 'undefined') return;

  const refLink = getRefLink(telegramId);
  const stats = await fetchStats(telegramId);

  await editOrReply(ctx, buildReferralText(refLink, stats), {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard(buildReferralButtons(refLink)).reply_markup,
  });
}

// ─── Comando /indicar (mensagem nova, sem edição) ────────────────────────────────────────────────

export async function handleReferral(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id);
  if (!telegramId || telegramId === 'undefined') return;

  const refLink = getRefLink(telegramId);
  const stats = await fetchStats(telegramId);

  // FIX-HANDLEREFERRAL-DEDUP: reutiliza buildReferralButtons() em vez de
  // duplicar shareUrl e teclado inline. O botão "Voltar ao Menu" é omitido
  // aqui pois /indicar é um comando que abre nova mensagem (não há contexto
  // de menu a voltar), então usa apenas o primeiro botão do array.
  const [shareButton] = buildReferralButtons(refLink);

  await ctx.reply(buildReferralText(refLink, stats), {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([shareButton]).reply_markup,
  });
}

// ─── Processa deep link ref_XXX no /start ───────────────────────────────────────────────────

export async function processReferralStart(
  ctx: Context,
  startPayload: string
): Promise<void> {
  if (!startPayload.startsWith('ref_')) return;

  const referrerTelegramId = startPayload.replace('ref_', '');
  const referredTelegramId = String(ctx.from?.id);

  if (
    !referredTelegramId ||
    referredTelegramId === 'undefined' ||
    referrerTelegramId === referredTelegramId
  ) return;

  const result = await registerReferral(referrerTelegramId, referredTelegramId);
  if (result.success) {
    console.info(`[referral] Novo indicado ${referredTelegramId} via ${referrerTelegramId}`);
  }
}
