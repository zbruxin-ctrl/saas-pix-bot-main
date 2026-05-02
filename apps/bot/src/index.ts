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
 */

import { initSentry, captureError } from './config/sentry';
initSentry();

import express from 'express';
import { Telegraf } from 'telegraf';
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

      await ctx.reply(
        '⚠️ Você tem um <b>pagamento PIX em andamento</b>!\n\n' +
        'Use os botões acima para verificar ou cancelar.\n' +
        'Ou aguarde expirar automaticamente em 30 minutos.',
        { parse_mode: 'HTML' }
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
    // Volta para tela de método de pagamento sem cupom
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

// ─── Seleção de produto ───────────────────────────────────────────────────────
bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produto...').catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId = ctx.from!.id;
    const session = await getSession(userId);

    let product: ProductDTO | undefined;
    let balanceResult = 0;

    try {
      const [products, walletData] = await Promise.all([
        apiClient.getProducts(),
        apiClient.getBalance(String(userId)).catch(() => ({ balance: 0, transactions: [] })),
      ]);
      product = products.find((p) => p.id === productId);
      session.products = products as never;
      balanceResult = Number(walletData.balance);
      await saveSession(userId, session);
    } catch (err) {
      captureError(err, { handler: 'select_product', productId, userId });
      await ctx.reply('❌ Erro ao buscar produto. Tente novamente.', { parse_mode: 'HTML' });
      return;
    }

    if (!product) {
      await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' });
      return;
    }

    if (product.stock != null && product.stock <= 0) {
      await ctx.reply('⚠️ Este produto está esgotado no momento.', { parse_mode: 'HTML' });
      return;
    }

    session.selectedProductId = productId;
    session.step = 'selecting_product';
    await saveSession(userId, session);

    await showPaymentMethodScreen(ctx, product, balanceResult);
  } catch (err) {
    captureError(err, { handler: 'select_product_action' });
    console.error('[select_product] Erro inesperado:', err);
  }
});

// ─── Ações de pagamento ───────────────────────────────────────────────────────
bot.action(/^pay_pix_(.+)$/, async (ctx) => {
  await executePayment(ctx, ctx.match[1], 'PIX');
});

bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await executePayment(ctx, ctx.match[1], 'BALANCE');
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await executePayment(ctx, ctx.match[1], 'MIXED');
});

bot.action(/^pay_mixed_coupon_(.+)$/, async (ctx) => {
  await executePayment(ctx, ctx.match[1], 'MIXED');
});

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await handleCheckPayment(ctx, ctx.match[1]);
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  await handleCancelPayment(ctx, ctx.match[1]);
});

// ─── Mensagens de texto ───────────────────────────────────────────────────────
bot.on(message('text'), async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const text = ctx.message.text.trim();
    const session = await getSession(userId);

    if (session.step === 'awaiting_deposit_amount') {
      await handleDepositAmount(ctx, text);
      return;
    }

    // Usuário digitou o código do cupom
    if (session.step === 'awaiting_coupon' && session.pendingProductId) {
      const productId = session.pendingProductId;
      const couponCode = text.toUpperCase().trim();

      const { validateCoupon } = await import('./services/couponClient');
      const products = await apiClient.getProducts();
      const product = products.find((p) => p.id === productId);
      const price = product ? Number(product.price) : 0;

      // FIX: sem .catch() silencioso — erros reais de rede são capturados pelo
      // try/catch externo e logados pelo Sentry. O .catch() anterior engolia
      // falhas de conexão e retornava "inválido" sem nunca chamar a API.
      const result = await validateCoupon(couponCode, String(userId), price, productId);

      if (!result.valid) {
        await ctx.reply(
          `❌ <b>${result.error ?? 'Cupom inválido ou expirado.'}</b>\n\nDigite outro código ou clique em Pular.`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⏭️ Pular', callback_data: `skip_coupon_${productId}` }],
                [{ text: '◀️ Voltar', callback_data: `select_product_${productId}` }],
              ],
            },
          }
        );
        return;
      }

      // FIX: guard ANTES do saveSession para não sujar a sessão em caso de
      // result.data ausente (não deveria ocorrer, mas defesa extra).
      if (!result.data) {
        captureError(new Error('validateCoupon retornou valid=true mas sem data'), { couponCode, productId });
        await ctx.reply('❌ Erro ao processar cupom. Tente novamente.', { parse_mode: 'HTML' });
        return;
      }

      const d = result.data;

      // Salva na sessão somente após validar tudo
      session.pendingCoupon = couponCode;
      session.pendingCouponDiscount = d.discountAmount; // FIX-COUPON-DISCOUNT
      session.mainMessageId = undefined;
      session.step = 'selecting_product';
      await saveSession(userId, session);

      await ctx.reply(
        `✅ <b>Cupom aplicado!</b>\n\n` +
        `🏷️ Código: <code>${couponCode}</code>\n` +
        `💰 Desconto: <b>R$ ${d.discountAmount.toFixed(2)}</b>\n` +
        `✅ Total com desconto: <b>R$ ${d.finalAmount.toFixed(2)}</b>\n\n` +
        `Agora escolha como pagar ⬇️`,
        { parse_mode: 'HTML' }
      );

      if (product) await showPaymentMethodScreen(ctx, product);
      return;
    }

    await ctx.reply('Use /start para acessar o menu principal.', { parse_mode: 'HTML' });
  } catch (err) {
    captureError(err, { handler: 'text_message' });
    console.error('[text] Erro inesperado:', err);
  }
});

// ─── Servidor Express (Webhook) ───────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', bot: bot.botInfo?.username ?? 'loading' });
});

app.post('/invalidate-cache', (req, res) => {
  const secret = req.headers['x-bot-secret'];
  if (secret !== env.TELEGRAM_BOT_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { type, telegramId } = req.body as { type?: string; telegramId?: string };
  if (type === 'products') invalidateProductCache();
  if (type === 'bot-config') invalidateBotConfigCache(telegramId);
  res.json({ ok: true });
});

const webhookPath = '/telegram-webhook';

app.post(webhookPath, async (req, res) => {
  if (env.TELEGRAM_BOT_SECRET) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== env.TELEGRAM_BOT_SECRET) {
      console.warn('[webhook] Secret token inválido — request ignorado');
      res.status(403).send('Forbidden');
      return;
    }
  }

  const update = req.body as { update_id?: number };

  if (update.update_id) {
    const isNew = await markUpdateProcessed(update.update_id).catch(() => true);
    if (!isNew) {
      res.sendStatus(200);
      return;
    }
  }

  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    captureError(err, { handler: 'webhook' });
    console.error('[webhook] Erro ao processar update:', err);
  }

  res.sendStatus(200);
});

const PORT = Number(process.env.PORT) || 8080;

async function start() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🏠 Menu principal' },
      { command: 'produtos', description: '🛒 Ver produtos disponíveis' },
      { command: 'saldo', description: '💰 Ver meu saldo' },
      { command: 'meus_pedidos', description: '📦 Ver meus pedidos' },
      { command: 'indicar', description: '🎁 Indicar amigos e ganhar bônus' },
      { command: 'ajuda', description: '❓ Ajuda e suporte' },
    ]);
    console.log('✅ Menu de comandos registrado no Telegram');

    const webhookUrl = env.BOT_WEBHOOK_URL
      ? `${env.BOT_WEBHOOK_URL}${webhookPath}`
      : null;

    if (webhookUrl) {
      await bot.telegram.setWebhook(webhookUrl, {
        secret_token: env.TELEGRAM_BOT_SECRET || undefined,
      });
      console.log(`🤖 Webhook registrado: ${webhookUrl}`);
    } else {
      console.warn('⚠️  BOT_WEBHOOK_URL não configurado — bot não receberá updates!');
    }

    const botInfo = await bot.telegram.getMe();
    console.log(`📌 Bot username: @${botInfo.username}`);

    app.listen(PORT, () => {
      console.log(`🚀 Servidor webhook escutando na porta ${PORT}`);
    });
  } catch (err) {
    captureError(err, { handler: 'start' });
    console.error('❌ Falha ao iniciar o bot:', err);
    process.exit(1);
  }
}

start();
