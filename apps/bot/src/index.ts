/**
 * Ponto de entrada do bot — inicialização, registro de handlers e servidor webhook.
 * Toda a lógica de negócio está nos módulos em handlers/ e services/.
 *
 * PADRÃO: parse_mode HTML em todas as mensagens de texto.
 * FIX #1: ao receber /start, re-agenda o timer de expiração do PIX para
 *         usuários com pagamento em aberto (resistência a restarts via Redis).
 * BUG FIX: todos os handlers têm try/catch global para nunca silenciar o bot.
 * FIX-COUPON: remove .catch() silencioso na validação de cupom; corrige ordem
 *             do guard result.data (deve vir ANTES do saveSession); corrige
 *             typos "cupão" → "cupom".
 * FIX-COUPON-DISCOUNT: salva discountAmount na sessão para uso na tela de pagamento.
 * FEAT-REMOVE-COUPON: action remove_coupon_ limpa cupom da sessão e volta para
 *                     tela de método de pagamento sem desconto.
 * FIX-START-BUTTONS: /start com PIX pendente agora envia botões de Verificar/Cancelar.
 */

import { initSentry, captureError } from './config/sentry';
initSentry();

import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { env } from './config/env';
import { apiClient, invalidateProductCache, invalidateBotConfigCache } from './services/apiClient';
import { getSession, saveSession } from './services/session';
import type { UserSession } from './services/session';
import { markUpdateProcessed } from './services/locks';

// Handlers
import { globalMiddleware } from './handlers/middleware';
import { showHome, showProducts, showOrders, showHelp } from './handlers/navigation';
import { showBalance, handleDepositAmount } from './handlers/balance';
import {
  initPaymentHandlers,
  executePayment,
  handleCheckPayment,
  handleCancelPayment,
  showPaymentMethodScreen,
  showCouponInputScreen,
  schedulePIXExpiry,
} from './handlers/payments';
import { handleReferral, showReferralMenu, processReferralStart } from './handlers/referral';

import type { ProductDTO } from '@saas-pix/shared';

const emptySession = (): UserSession => ({ step: 'idle', lastActivityAt: Date.now() });

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
initPaymentHandlers(bot);

// ─── Middleware global ────────────────────────────────────────────────────────
bot.use(globalMiddleware);

// ─── Comandos ─────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const existing = await getSession(userId).catch(emptySession);

    // Processar deep-link de indicação: /start ref_TELEGRAMID
    const payload = (ctx.message as { text?: string }).text?.split(' ')[1] ?? '';
    if (payload.startsWith('ref_')) {
      await processReferralStart(ctx, payload).catch((err) =>
        captureError(err, { handler: 'processReferralStart' })
      );
    }

    if (existing.step === 'awaiting_payment' && existing.paymentId) {
      // FIX #1: re-agenda o timer de expiração usando o tempo restante do Redis
      if (existing.pixExpiresAt) {
        const remaining = new Date(existing.pixExpiresAt).getTime() - Date.now();
        if (remaining > 0) {
          const chatId = ctx.chat?.id ?? userId;
          schedulePIXExpiry(userId, existing.paymentId, chatId, remaining);
          console.info(
            `[/start] PIX re-agendado para userId ${userId} | paymentId: ${existing.paymentId} | restam: ${Math.round(remaining / 1000)}s`
          );
        }
      }

      // FIX-START-BUTTONS: envia os botões de Verificar/Cancelar junto com o aviso
      await ctx.reply(
        '⚠️ Você tem um <b>pagamento PIX em andamento</b>!\n\n' +
        'Use os botões abaixo para verificar ou cancelar.\n' +
        'Ou aguarde expirar automaticamente em 30 minutos.',
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${existing.paymentId}`)],
            [Markup.button.callback('❌ Cancelar PIX', `cancel_payment_${existing.paymentId}`)],
          ]).reply_markup,
        }
      );
      return;
    }

    await saveSession(userId, {
      step: 'idle',
      firstName: ctx.from?.first_name || existing.firstName,
      lastActivityAt: Date.now(),
    });
    await showHome(ctx);
  } catch (err) {
    captureError(err, { handler: 'start' });
    console.error('[/start] Erro inesperado:', err);
    await ctx.reply('Olá! Use /start para começar.', { parse_mode: 'HTML' }).catch(() => {});
  }
});

bot.command('produtos', async (ctx) => {
  try { await showProducts(ctx); } catch (err) { captureError(err, { handler: 'produtos' }); }
});
bot.command('saldo', async (ctx) => {
  try { await showBalance(ctx); } catch (err) { captureError(err, { handler: 'saldo' }); }
});
bot.command('ajuda', async (ctx) => {
  try { await showHelp(ctx); } catch (err) { captureError(err, { handler: 'ajuda' }); }
});
bot.command('meus_pedidos', async (ctx) => {
  try { await showOrders(ctx); } catch (err) { captureError(err, { handler: 'meus_pedidos' }); }
});
bot.command('indicar', async (ctx) => {
  try { await handleReferral(ctx); } catch (err) { captureError(err, { handler: 'indicar' }); }
});

// ─── Actions de navegação ─────────────────────────────────────────────────────
bot.action('show_home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try { await showHome(ctx); } catch (err) { captureError(err, { handler: 'show_home' }); }
});

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produtos...').catch(() => {});
  try { await showProducts(ctx); } catch (err) { captureError(err, { handler: 'show_products' }); }
});

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try { await showHelp(ctx); } catch (err) { captureError(err, { handler: 'show_help' }); }
});

bot.action('show_orders', async (ctx) => {
  await ctx.answerCbQuery('📦 Carregando pedidos...').catch(() => {});
  try { await showOrders(ctx); } catch (err) { captureError(err, { handler: 'show_orders' }); }
});

bot.action('show_balance', async (ctx) => {
  await ctx.answerCbQuery('⏳ Buscando saldo...').catch(() => {});
  try { await showBalance(ctx); } catch (err) { captureError(err, { handler: 'show_balance' }); }
});

// ─── Action: Indique e Ganhe ──────────────────────────────────────────────────
bot.action('show_referral', async (ctx) => {
  await ctx.answerCbQuery('🎁 Carregando...').catch(() => {});
  try { await showReferralMenu(ctx); } catch (err) { captureError(err, { handler: 'show_referral' }); }
});

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const session = await getSession(ctx.from!.id);
    session.step = 'awaiting_deposit_amount';
    await saveSession(ctx.from!.id, session);
    await ctx.reply(
      '💳 <b>Adicionar Saldo</b>\n\n' +
        'Digite o valor em reais que deseja depositar:\n' +
        '<i>(mínimo R$ 1,00 | máximo R$ 10.000,00)</i>\n\n' +
        'Exemplo: <code>25</code> ou <code>50.00</code>',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    captureError(err, { handler: 'deposit_balance' });
  }
});

// ─── Cupom ───────────────────────────────────────────────────────────────────
bot.action(/^coupon_input_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🏷️ Cupom...').catch(() => {});
  try {
    await showCouponInputScreen(ctx, ctx.match[1]);
  } catch (err) {
    captureError(err, { handler: 'coupon_input' });
  }
});

bot.action(/^skip_coupon_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏭️ Pulando cupom...').catch(() => {});
  try {
    const productId = ctx.match[1];
    const session = await getSession(ctx.from!.id);
    delete session.pendingCoupon;
    delete session.pendingCouponDiscount;
    session.step = 'selecting_product';
    await saveSession(ctx.from!.id, session);
    const products = await apiClient.getProducts();
    const product = products.find((p) => p.id === productId);
    if (!product) {
      await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' });
      return;
    }
    await showPaymentMethodScreen(ctx, product);
  } catch (err) {
    captureError(err, { handler: 'skip_coupon' });
  }
});

// FEAT-REMOVE-COUPON: remove cupom aplicado e volta para tela de método sem desconto
bot.action(/^remove_coupon_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🗑️ Cupom removido!').catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId = ctx.from!.id;
    const session = await getSession(userId);
    delete session.pendingCoupon;
    delete session.pendingCouponDiscount;
    session.step = 'selecting_product';
    await saveSession(userId, session);
    const products = await apiClient.getProducts();
    const product = products.find((p) => p.id === productId);
    if (!product) {
      await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' });
      return;
    }
    await showPaymentMethodScreen(ctx, product);
  } catch (err) {
    captureError(err, { handler: 'remove_coupon' });
  }
});

// ─── Actions de produto ───────────────────────────────────────────────────────
bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando...').catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId = ctx.from!.id;
    const products = await apiClient.getProducts();
    const product = products.find((p: ProductDTO) => p.id === productId);
    if (!product) {
      await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' });
      return;
    }
    const session = await getSession(userId);
    session.step = 'selecting_product';
    session.pendingProductId = productId;
    await saveSession(userId, session);
    await showPaymentMethodScreen(ctx, product);
  } catch (err) {
    captureError(err, { handler: 'select_product' });
  }
});

bot.action(/^pay_pix_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Gerando PIX...').catch(() => {});
  try {
    await executePayment(ctx, ctx.match[1], 'PIX');
  } catch (err) {
    captureError(err, { handler: 'pay_pix' });
  }
});

bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Processando...').catch(() => {});
  try {
    await executePayment(ctx, ctx.match[1], 'BALANCE');
  } catch (err) {
    captureError(err, { handler: 'pay_balance' });
  }
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Processando...').catch(() => {});
  try {
    await executePayment(ctx, ctx.match[1], 'MIXED');
  } catch (err) {
    captureError(err, { handler: 'pay_mixed' });
  }
});

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  try {
    await handleCheckPayment(ctx, ctx.match[1]);
  } catch (err) {
    captureError(err, { handler: 'check_payment' });
  }
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  try {
    await handleCancelPayment(ctx, ctx.match[1]);
  } catch (err) {
    captureError(err, { handler: 'cancel_payment' });
  }
});

// ─── Mensagens de texto ───────────────────────────────────────────────────────
bot.on(message('text'), async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const session = await getSession(userId).catch(emptySession);

    if (session.step === 'awaiting_deposit_amount') {
      await handleDepositAmount(ctx);
      return;
    }

    if (session.step === 'awaiting_coupon') {
      const productId = session.pendingProductId;
      if (!productId) {
        await ctx.reply('❌ Sessão inválida. Use /start para recomeçar.', { parse_mode: 'HTML' });
        return;
      }

      const couponCode = ctx.message.text.trim().toUpperCase();

      try {
        const result = await apiClient.validateCoupon(couponCode, String(userId));

        if (!result.valid || !result.data) {
          await ctx.reply(
            `❌ <b>Cupom inválido:</b> ${result.message ?? 'Cupom não encontrado ou expirado.'}`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        const discountAmount = Number(result.data.discountAmount ?? 0);
        session.pendingCoupon = couponCode;
        session.pendingCouponDiscount = discountAmount;
        session.step = 'selecting_product';
        await saveSession(userId, session);

        const products = await apiClient.getProducts();
        const product = products.find((p: ProductDTO) => p.id === productId);
        if (!product) {
          await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' });
          return;
        }

        await ctx.reply(
          `✅ <b>Cupom aplicado!</b> Desconto de R$ ${discountAmount.toFixed(2)}`,
          { parse_mode: 'HTML' }
        );
        await showPaymentMethodScreen(ctx, product);
      } catch (err) {
        captureError(err, { handler: 'awaiting_coupon' });
        await ctx.reply('❌ Erro ao validar cupom. Tente novamente.', { parse_mode: 'HTML' });
      }
      return;
    }
  } catch (err) {
    captureError(err, { handler: 'on_text' });
    console.error('[on:text] Erro inesperado:', err);
  }
});

// ─── Webhook / Polling ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

if (env.WEBHOOK_URL) {
  const webhookPath = `/webhook/${env.TELEGRAM_BOT_TOKEN}`;
  app.use(bot.webhookCallback(webhookPath));

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, async () => {
    const webhookUrl = `${env.WEBHOOK_URL}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl);
    console.info(`[bot] Webhook registrado: ${webhookUrl}`);
    console.info(`[bot] Servidor ouvindo na porta ${port}`);
  });

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Invalidação de cache via webhook interno
  app.post('/internal/invalidate-cache', (req, res) => {
    const { type } = req.body ?? {};
    if (type === 'products') invalidateProductCache();
    if (type === 'bot-config') invalidateBotConfigCache();
    res.json({ ok: true });
  });
} else {
  bot.launch().then(() => console.info('[bot] Bot iniciado em modo polling'));
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
