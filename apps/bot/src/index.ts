/**
 * Ponto de entrada do bot — inicialização, registro de handlers e servidor webhook.
 * Toda a lógica de negócio está nos módulos em handlers/ e services/.
 *
 * FIX #1: ao receber /start, re-agenda o timer de expiração do PIX para
 *         usuários com pagamento em aberto (resistência a restarts via Redis).
 * BUG FIX: todos os handlers têm try/catch global para nunca silenciar o bot.
 */

// Sentry DEVE ser o primeiro import — captura erros desde o início
import { initSentry, captureError } from './config/sentry';
initSentry();

import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { env } from './config/env';
import { apiClient, invalidateProductCache, invalidateBotConfigCache } from './services/apiClient';
import { getSession, saveSession, clearSession } from './services/session';
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
  schedulePIXExpiry,
} from './handlers/payments';

import type { ProductDTO } from '@saas-pix/shared';

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
initPaymentHandlers(bot);

// ─── Middleware global ────────────────────────────────────────────────────────
bot.use(globalMiddleware);

// ─── Comandos ─────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const existing = await getSession(userId).catch(() => ({ step: 'idle' as const, lastActivityAt: Date.now() }));

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
        '⚠️ Você tem um *pagamento PIX em andamento*\!\n\n' +
        'Use os botões acima para verificar ou cancelar\.\n' +
        'Ou aguarde expirar automaticamente em 30 minutos\.',
        { parse_mode: 'MarkdownV2' }
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
    await ctx.reply('Olá\! Use /start para começar\.', { parse_mode: 'MarkdownV2' }).catch(() => {});
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

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const session = await getSession(ctx.from!.id);
    session.step = 'awaiting_deposit_amount';
    await saveSession(ctx.from!.id, session);
    await ctx.reply(
      '💳 *Adicionar Saldo*\n\n' +
        'Digite o valor em reais que deseja depositar:\n' +
        '_\(mínimo R\$ 1,00 \| máximo R\$ 10\.000,00\)_\n\n' +
        'Exemplo: `25` ou `50.00`',
      { parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    captureError(err, { handler: 'deposit_balance' });
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
      await ctx.reply('❌ Erro ao buscar produto\. Tente novamente\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    if (!product) {
      await ctx.reply('❌ Produto não encontrado\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    if (product.stock != null && product.stock <= 0) {
      await ctx.reply('⚠️ Este produto está esgotado no momento\.', { parse_mode: 'MarkdownV2' });
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
  // answerCbQuery é feito dentro de executePayment
  await executePayment(ctx, ctx.match[1], 'PIX');
});

bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await executePayment(ctx, ctx.match[1], 'BALANCE');
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await executePayment(ctx, ctx.match[1], 'MIXED');
});

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  // answerCbQuery é feito DENTRO de handleCheckPayment (primeiro passo)
  await handleCheckPayment(ctx, ctx.match[1]);
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  // answerCbQuery é feito DENTRO de handleCancelPayment (primeiro passo)
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

    // Mensagem de texto não reconhecida
    await ctx.reply(
      'Use /start para acessar o menu principal\.',
      { parse_mode: 'MarkdownV2' }
    );
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

// Endpoint para invalidar cache (chamado pela API após mudanças)
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
  // Validação do secret_token do Telegram
  if (env.TELEGRAM_BOT_SECRET) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== env.TELEGRAM_BOT_SECRET) {
      console.warn('[webhook] Secret token inválido — request ignorado');
      res.status(403).send('Forbidden');
      return;
    }
  }

  const update = req.body as { update_id?: number };

  // Idempotência: ignora updates duplicados
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
