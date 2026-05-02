/**
 * Bot Telegram principal — registro de handlers e inicialização.
 *
 * P3 FIX: /start durante pagamento preserva sessão PIX em andamento.
 * FEAT-DEPOSIT: comando /depositar e handlers de recarga de saldo.
 * FEAT-PRICING: handlers de cupom e referral.
 * FIX-COUPON-DISCOUNT: remove_coupon limpa pendingCoupon e pendingCouponDiscount.
 * FEAT-MULTI-QTY: select_product → showQuantityScreen; nova action set_qty_:id_:n.
 */
import { Telegraf, Markup } from 'telegraf';
import { apiClient } from './services/apiClient';
import { getSession, saveSession, clearSession } from './services/session';
import { logger } from './lib/logger';
import { captureError } from './lib/sentry';
import {
  initPaymentHandlers,
  executePayment,
  handleCheckPayment,
  handleCancelPayment,
  showPaymentMethodScreen,
  showQuantityScreen,
  showCouponInputScreen,
  schedulePIXExpiry,
  cancelPIXTimer,
} from './handlers/payments';

type ProductDTO = Awaited<ReturnType<typeof apiClient.getProducts>>[number];

const BOT_TOKEN = process.env.BOT_TOKEN!;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN não definido');

const bot = new Telegraf(BOT_TOKEN);

initPaymentHandlers();

// ─── /start ───────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await getSession(userId);
    const referralCode = ctx.startPayload || undefined;

    if (referralCode && referralCode !== String(userId)) {
      try {
        await apiClient.registerReferral(String(userId), referralCode);
      } catch { /**/ }
    }

    // P3 FIX: se há PIX pendente, re-agenda expiry e avisa
    if (session.step === 'awaiting_payment' && session.paymentId && session.pixExpiresAt) {
      await ctx.reply(
        `⏳ Você tem um PIX pendente. Use o botão abaixo para verificar.`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${session.paymentId}`)],
            [Markup.button.callback('❌ Cancelar PIX', `cancel_payment_${session.paymentId}`)],
          ]).reply_markup,
        }
      );
      await schedulePIXExpiry(ctx, session.paymentId, userId, session.pixExpiresAt);
      return;
    }

    session.firstName = ctx.from.first_name;
    await saveSession(userId, session);

    const welcomeMsg = await apiClient.getSetting?.('welcome_message').catch(() => null)
      ?? process.env.BOT_WELCOME_MESSAGE
      ?? `Olá, <b>${ctx.from.first_name}</b>! Bem-vindo(a). Use /produtos para ver o catálogo.`;

    await ctx.reply(
      welcomeMsg.replace('{nome}', ctx.from.first_name),
      {
        parse_mode: 'HTML',
        reply_markup: Markup.keyboard([
          ['🛋️ Produtos', '💰 Meu Saldo'],
          ['💳 Depositar', '💬 Suporte'],
        ]).resize().reply_markup,
      }
    );
  } catch (err) {
    captureError(err, { handler: 'start' });
    logger.error('[/start] Erro:', err);
  }
});

// ─── /produtos ──────────────────────────────────────────────────────────
async function showProducts(ctx: Parameters<typeof bot.command>[1]) {
  try {
    const products = await apiClient.getProducts();
    if (!products.length) {
      await ctx.reply('🛋️ Nenhum produto disponível no momento.', { parse_mode: 'HTML' });
      return;
    }

    const buttons = products.map((p) => [
      Markup.button.callback(
        `${p.name} — R$ ${Number(p.price).toFixed(2)}${
          p.stock != null ? ` (${p.stock} em estoque)` : ''
        }`,
        `select_product_${p.id}`
      ),
    ]);

    await ctx.reply('🛋️ <b>Produtos disponíveis:</b>\n\nEscolha um produto:', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (err) {
    captureError(err, { handler: 'showProducts' });
    await ctx.reply('❌ Erro ao buscar produtos. Tente novamente.', { parse_mode: 'HTML' });
  }
}

bot.command('produtos', showProducts);
bot.hears('🛋️ Produtos', showProducts);

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showProducts(ctx as never);
});

// ─── /saldo ──────────────────────────────────────────────────────────────
async function showBalance(ctx: Parameters<typeof bot.command>[1]) {
  try {
    const userId = ctx.from!.id;
    const data = await apiClient.getBalance(String(userId));
    await ctx.reply(
      `💰 <b>Seu saldo:</b> R$ ${Number(data.balance).toFixed(2)}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    captureError(err, { handler: 'showBalance' });
    await ctx.reply('❌ Erro ao buscar saldo.', { parse_mode: 'HTML' });
  }
}

bot.command('saldo', showBalance);
bot.hears('💰 Meu Saldo', showBalance);

// ─── Suporte ──────────────────────────────────────────────────────────────
async function showSupport(ctx: Parameters<typeof bot.command>[1]) {
  try {
    const phone = process.env.SUPPORT_PHONE_NUMBER ?? '';
    const msg = phone
      ? `💬 <b>Suporte:</b>\n\n<a href="https://wa.me/${phone}">Falar com suporte via WhatsApp</a>`
      : `💬 Entre em contato com o suporte pelo administrador do bot.`;
    await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true } as never);
  } catch (err) {
    captureError(err, { handler: 'showSupport' });
  }
}

bot.command('suporte', showSupport);
bot.hears('💬 Suporte', showSupport);

// ─── Depositar ────────────────────────────────────────────────────────────
async function showDeposit(ctx: Parameters<typeof bot.command>[1]) {
  try {
    const userId = ctx.from!.id;
    const session = await getSession(userId);
    session.step = 'awaiting_deposit_amount';
    await saveSession(userId, session);
    await ctx.reply(
      `💳 <b>Depositar saldo</b>\n\nDigite o valor que deseja depositar (mínimo R$ 1,00):`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    captureError(err, { handler: 'showDeposit' });
  }
}

bot.command('depositar', showDeposit);
bot.hears('💳 Depositar', showDeposit);

// ─── Seleção de produto → tela de quantidade ──────────────────────────────────────
bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produto...').catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId = ctx.from!.id;
    const session = await getSession(userId);

    let product: ProductDTO | undefined;

    try {
      const products = await apiClient.getProducts();
      product = products.find((p) => p.id === productId);
      session.products = products as never;
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

    // FEAT-MULTI-QTY: vai para tela de quantidade antes do pagamento
    await showQuantityScreen(ctx, product);
  } catch (err) {
    captureError(err, { handler: 'select_product_action' });
    logger.error('[select_product] Erro inesperado:', err);
  }
});

// ─── Seleção de quantidade → tela de pagamento ──────────────────────────────────
bot.action(/^set_qty_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const productId = ctx.match[1];
    const qty = parseInt(ctx.match[2], 10);
    const userId = ctx.from!.id;

    const session = await getSession(userId);
    session.pendingQty = qty;
    session.selectedProductId = productId;
    session.step = 'selecting_product';
    await saveSession(userId, session);

    const [products, walletData] = await Promise.all([
      apiClient.getProducts(),
      apiClient.getBalance(String(userId)).catch(() => ({ balance: 0, transactions: [] })),
    ]);
    const product = products.find((p) => p.id === productId);
    if (!product) {
      await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' });
      return;
    }

    await showPaymentMethodScreen(ctx, product, Number(walletData.balance));
  } catch (err) {
    captureError(err, { handler: 'set_qty' });
    logger.error('[set_qty] Erro:', err);
  }
});

// ─── Métodos de pagamento ───────────────────────────────────────────────────────
bot.action(/^pay_pix_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await executePayment(ctx, ctx.match[1], 'PIX');
});

bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await executePayment(ctx, ctx.match[1], 'BALANCE');
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await executePayment(ctx, ctx.match[1], 'MIXED');
});

// ─── Verificar / cancelar pagamento ────────────────────────────────────────────
bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCheckPayment(ctx, ctx.match[1]);
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCancelPayment(ctx, ctx.match[1]);
});

bot.action('cancel_payment', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  cancelPIXTimer(userId);
  await clearSession(userId, session.firstName);
  await ctx.reply('❌ Pedido cancelado. Use /produtos para começar novamente.', { parse_mode: 'HTML' });
});

// ─── Cupom ───────────────────────────────────────────────────────────────
bot.action(/^coupon_input_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showCouponInputScreen(ctx, ctx.match[1]);
});

bot.action(/^back_to_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId = ctx.from!.id;
    const [products, walletData] = await Promise.all([
      apiClient.getProducts(),
      apiClient.getBalance(String(userId)).catch(() => ({ balance: 0 })),
    ]);
    const product = products.find((p) => p.id === productId);
    if (!product) { await ctx.reply('❌ Produto não encontrado.'); return; }
    await showPaymentMethodScreen(ctx, product, Number(walletData.balance));
  } catch (err) {
    captureError(err, { handler: 'back_to_payment' });
  }
});

bot.action(/^remove_coupon_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId = ctx.from!.id;
    const session = await getSession(userId);
    session.pendingCoupon = null;
    session.pendingCouponDiscount = 0;
    await saveSession(userId, session);
    const [products, walletData] = await Promise.all([
      apiClient.getProducts(),
      apiClient.getBalance(String(userId)).catch(() => ({ balance: 0 })),
    ]);
    const product = products.find((p) => p.id === productId);
    if (!product) { await ctx.reply('❌ Produto não encontrado.'); return; }
    await showPaymentMethodScreen(ctx, product, Number(walletData.balance));
  } catch (err) {
    captureError(err, { handler: 'remove_coupon' });
  }
});

// ─── Mensagens de texto (cupom / depósito) ──────────────────────────────────
bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await getSession(userId);
    const text = ctx.message.text.trim();

    if (session.step === 'awaiting_coupon' && session.pendingProductId) {
      const couponCode = text.toUpperCase();
      try {
        const result = await apiClient.validateCoupon(couponCode, session.pendingProductId);
        if (result.valid) {
          session.pendingCoupon = couponCode;
          session.pendingCouponDiscount = result.discountAmount ?? 0;
          session.step = 'selecting_product';
          await saveSession(userId, session);

          const [products, walletData] = await Promise.all([
            apiClient.getProducts(),
            apiClient.getBalance(String(userId)).catch(() => ({ balance: 0 })),
          ]);
          const product = products.find((p) => p.id === session.pendingProductId);
          if (product) {
            await ctx.reply(
              `✅ Cupom <code>${couponCode}</code> aplicado! Desconto: R$ ${(result.discountAmount ?? 0).toFixed(2)}`,
              { parse_mode: 'HTML' }
            );
            await showPaymentMethodScreen(ctx as never, product, Number(walletData.balance));
          }
        } else {
          await ctx.reply(`❌ Cupom inválido: ${result.message ?? 'Código não encontrado.'}`, { parse_mode: 'HTML' });
        }
      } catch (err) {
        captureError(err, { handler: 'coupon_validate', couponCode, userId });
        await ctx.reply('❌ Erro ao validar cupom. Tente novamente.', { parse_mode: 'HTML' });
      }
      return;
    }

    if (session.step === 'awaiting_deposit_amount') {
      const amount = parseFloat(text.replace(',', '.'));
      if (isNaN(amount) || amount < 1) {
        await ctx.reply('❌ Valor inválido. Digite um valor mínimo de R$ 1,00.', { parse_mode: 'HTML' });
        return;
      }
      try {
        const payment = await apiClient.createDeposit({ telegramId: String(userId), amount });
        const qrText = payment.pixQrCode ?? payment.pixCopyPaste ?? '';
        session.step = 'awaiting_payment';
        session.depositPaymentId = payment.id;
        session.pixExpiresAt = payment.expiresAt
          ? new Date(payment.expiresAt).toISOString()
          : new Date(Date.now() + 30 * 60 * 1000).toISOString();
        session.pixQrCodeText = qrText;
        await saveSession(userId, session);

        await ctx.replyWithPhoto(
          { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrText)}` },
          {
            caption: `💳 *Depósito de R\$ ${amount.toFixed(2).replace('.', '\\.')}*\n\nEscaneie o QR ou copie o código abaixo:`,
            parse_mode: 'MarkdownV2',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Verificar Depósito', `check_payment_${payment.id}`)],
            ]).reply_markup,
          }
        );
        await ctx.reply(`<code>${qrText}</code>`, { parse_mode: 'HTML' });
        await schedulePIXExpiry(ctx as never, payment.id, userId, session.pixExpiresAt);
      } catch (err) {
        captureError(err, { handler: 'deposit', userId, amount });
        await ctx.reply('❌ Erro ao gerar PIX de depósito.', { parse_mode: 'HTML' });
      }
      return;
    }
  } catch (err) {
    captureError(err, { handler: 'on_text' });
    logger.error('[on_text] Erro:', err);
  }
});

// ─── Launch ──────────────────────────────────────────────────────────────
bot.launch({
  dropPendingUpdates: true,
}).then(() => {
  logger.info('Bot iniciado com sucesso');
}).catch((err) => {
  logger.error('Erro ao iniciar bot:', err);
  process.exit(1);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
