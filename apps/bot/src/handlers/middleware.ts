/**
 * Middleware global: rate limit + modo manutenção + bloqueio de usuário.
 *
 * SEC FIX #5: rate limit por userId (máx 2 req/s) para prevenir flood.
 * PERF FIX #4: BOT_CONFIG_CACHE_TTL aumentado para 30s em produção.
 * BUG FIX: updates sem ctx.from (edited_message, channel_post, etc.) são
 *          ignorados com segurança — antes causavam falha silenciosa no bot.
 * BUG FIX: try/catch total no middleware para nunca travar o pipeline.
 */
import { Context, Middleware } from 'telegraf';
import { escapeMd } from '../utils/escape';
import { editOrReply } from '../utils/helpers';
import { getSession, saveSession } from '../services/session';
import { apiClient } from '../services/apiClient';
import { showBlockedMessage } from './navigation';
import { env } from '../config/env';

const BLOCKED_ALLOWED_ACTIONS = new Set([
  'show_balance',
  'show_orders',
  'show_help',
  'show_home',
]);

// Rate limit: máx 1 request a cada 500ms por usuário (2 req/s)
const rateLimitMap = new Map<number, number>();
const RATE_LIMIT_MS = 500;

// Limpa entradas antigas do rate limit a cada 5 minutos para não vazar memória
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [uid, ts] of rateLimitMap.entries()) {
    if (ts < cutoff) rateLimitMap.delete(uid);
  }
}, 5 * 60 * 1000);

export const globalMiddleware: Middleware<Context> = async (ctx, next) => {
  // BUG FIX: updates sem from (edited_message, channel_post, inline_query, etc.)
  // não têm userId — ignorar silenciosamente em vez de travar o pipeline.
  const userId = ctx.from?.id;
  if (!userId) return next();

  try {
    // ── Rate limit ───────────────────────────────────────────────────────────
    const lastRequest = rateLimitMap.get(userId) ?? 0;
    const now = Date.now();
    if (now - lastRequest < RATE_LIMIT_MS) {
      if ('callbackQuery' in ctx && ctx.callbackQuery) {
        await ctx.answerCbQuery('⚠️ Devagar! Aguarde um instante.').catch(() => {});
      }
      return;
    }
    rateLimitMap.set(userId, now);

    let config: { maintenanceMode: boolean; maintenanceMessage: string; isBlocked: boolean };
    try {
      config = await apiClient.getBotConfig(String(userId));
    } catch {
      // Se a API estiver indisponível, deixa o update passar normalmente
      return next();
    }

    // ── Modo manutenção ──────────────────────────────────────────────────────
    if (config.maintenanceMode) {
      const session = await getSession(userId).catch(() => ({ step: 'idle' as const, lastActivityAt: Date.now() }));
      const firstName = escapeMd(session.firstName || ctx.from?.first_name || 'visitante');
      const maintMsg = config.maintenanceMessage || 'Estamos em manutenção. Voltamos em breve!';
      const text =
        `🛠️ *Manutenção em Andamento*\n\n` +
        `Olá, *${firstName}*\!\n\n` +
        `${escapeMd(maintMsg)}\n\n` +
        `_Pedimos desculpas pelo inconveniente\. Em breve estaremos de volta\!_ 😊`;

      if ('callbackQuery' in ctx && ctx.callbackQuery) {
        await ctx.answerCbQuery('🛠️ Bot em manutenção', { show_alert: true }).catch(() => {});
      }

      await editOrReply(ctx, text);
      return;
    }

    // ── Conta bloqueada ──────────────────────────────────────────────────────
    if (config.isBlocked) {
      const msgText = (ctx.message as { text?: string } | undefined)?.text;
      const isStartCommand = msgText === '/start';
      const isCallbackQuery = 'callbackQuery' in ctx && ctx.callbackQuery;
      const callbackData = isCallbackQuery ? ('data' in ctx.callbackQuery! ? ctx.callbackQuery!.data : '') : '';

      if (isStartCommand) {
        const session = await getSession(userId).catch(() => ({ step: 'idle' as const, lastActivityAt: Date.now(), mainMessageId: undefined, firstName: undefined }));
        session.firstName = ctx.from?.first_name;
        const chatId = ctx.chat?.id;
        if (session.mainMessageId && chatId) {
          await ctx.telegram.deleteMessage(chatId, session.mainMessageId).catch(() => {});
          session.mainMessageId = undefined;
        }
        await saveSession(userId, session as never).catch(() => {});
        await showBlockedMessage(ctx);
        return;
      }

      const isAllowedCommand = msgText && ['/ajuda', '/meus_pedidos', '/saldo'].some((cmd) => msgText.startsWith(cmd));
      if (isAllowedCommand) return next();

      if (isCallbackQuery) {
        if (BLOCKED_ALLOWED_ACTIONS.has(callbackData)) return next();
        await ctx.answerCbQuery('🚨 Conta suspensa — ação não permitida', { show_alert: true }).catch(() => {});
        await showBlockedMessage(ctx);
        return;
      }

      if (msgText) {
        await showBlockedMessage(ctx);
        return;
      }

      return next();
    }

    return next();
  } catch (err) {
    // Nunca deixar o middleware travar o pipeline inteiro
    console.error('[globalMiddleware] Erro inesperado — deixando passar:', err);
    return next();
  }
};
