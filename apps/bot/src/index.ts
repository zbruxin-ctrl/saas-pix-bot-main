/**
 * Bot Telegram principal — registro de handlers e inicialização.
 */
import { Telegraf, Markup, Context } from 'telegraf';
import { apiClient } from './services/apiClient';
import { getSession, saveSession, clearSession } from './services/session';
import { validateCoupon } from './services/couponClient';
import { registerReferral } from './services/referralClient';
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

// ─── showHome ─────────────────────────────────────────────────────────────────

async function showHome(ctx: any) {
  const firstName = ctx.from?.first_name || 'visitante';
  const text =
    `👋 Olá, <b>${firstName}</b>! Bem-vindo!\n\n` +
    `🛒 Aqui você pode adquirir nossos produtos de forma rápida e segura.\n\n` +
    `💳 Aceitamos pagamento via <b>PIX</b> (confirmação instantânea) ou via <b>saldo pré-carregado</b>.\n\n` +
    `Para ver nossos produtos, clique no botão abaixo:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
    [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
    [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
    [Markup.button.callback('👥 Indicações', 'show_referral')],
    [Markup.button.callback('❓ Ajuda', 'show_help')],
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
      return;
    } catch { /* mensagem idêntica — ignora */ }
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await getSession(userId);
    const referralCode = ctx.startPayload || undefined;

    if (referralCode && referralCode !== String(userId)) {
      try { await registerReferral(referralCode, String(userId)); } catch { /**/ }
    }

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
      await schedulePIXExpiry(ctx as unknown as Context, session.paymentId, userId, session.pixExpiresAt);
      return;
    }

    session.firstName = ctx.from.first_name;
    await saveSession(userId, session);
    await showHome(ctx);
  } catch (err) {
    console.error('[/start] Erro:', err);
  }
});

bot.action('show_home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showHome(ctx);
});

// ─── /produtos ────────────────────────────────────────────────────────────────

async function showProducts(ctx: any) {
  try {
    const products = await apiClient.getProducts();
    if (!products.length) {
      await ctx.reply('🛋️ Nenhum produto disponível no momento.', { parse_mode: 'HTML' });
      return;
    }

    const buttons = products.map((p: ProductDTO) => {
      // monta label com estoque
      let stockLabel = '';
      if (p.stock != null) {
        stockLabel = p.stock <= 0 ? ' ❌ Esgotado' : ` (${p.stock} restantes)`;
      }
      return [
        Markup.button.callback(
          `${p.name} — R$ ${Number(p.price).toFixed(2)}${stockLabel}`,
          `select_product_${p.id}`
        ),
      ];
    });
    buttons.push([Markup.button.callback('◀️ Voltar', 'show_home')]);

    const text = '🛒 <b>Produtos disponíveis:</b>\n\nEscolha um produto:';
    const replyMarkup = Markup.inlineKeyboard(buttons).reply_markup;

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: replyMarkup });
        return;
      } catch { /* ignora */ }
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: replyMarkup });
  } catch (err) {
    console.error('[showProducts] erro:', err);
    await ctx.reply('❌ Erro ao buscar produtos. Tente novamente.', { parse_mode: 'HTML' });
  }
}

bot.command('produtos', showProducts);

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produtos...').catch(() => {});
  await showProducts(ctx);
});

// ─── /saldo ───────────────────────────────────────────────────────────────────

async function showBalance(ctx: any) {
  try {
    const userId = ctx.from!.id;
    const data = await apiClient.getBalance(String(userId));

    // Histórico de transações
    let historyText = '';
    const txs: any[] = data.transactions ?? [];
    if (txs.length > 0) {
      const lines = txs.slice(0, 5).map((t: any) => {
        const sign = t.type === 'CREDIT' ? '+' : '-';
        const emoji = t.type === 'CREDIT' ? '🟢' : '🔴';
        const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString('pt-BR') : '';
        return `${emoji} ${sign}R$ ${Number(t.amount).toFixed(2)} — ${t.description ?? t.type}${date ? ` <i>(${date})</i>` : ''}`;
      });
      historyText = `\n\n📃 <b>Últimas transações:</b>\n${lines.join('\n')}`;
    } else {
      historyText = '\n\n<i>Nenhuma transação encontrada.</i>';
    }

    const text = `💰 <b>Seu saldo:</b> R$ ${Number(data.balance).toFixed(2)}${historyText}`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💳 Depositar', 'deposit_balance')],
      [Markup.button.callback('◀️ Voltar', 'show_home')],
    ]);
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
        return;
      } catch { /* ignora */ }
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } catch (err) {
    console.error('[showBalance] erro:', err);
    await ctx.reply('❌ Erro ao buscar saldo.', { parse_mode: 'HTML' });
  }
}

bot.command('saldo', showBalance);

bot.action('show_balance', async (ctx) => {
  await ctx.answerCbQuery('⏳ Buscando saldo...').catch(() => {});
  await showBalance(ctx);
});

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const userId = ctx.from!.id;
    const session = await getSession(userId);
    session.step = 'awaiting_deposit_amount';
    await saveSession(userId, session);
    const text = `💳 <b>Depositar saldo</b>\n\nDigite o valor que deseja depositar (mínimo R$ 1,00):\n\n<i>Para cancelar, clique no botão abaixo.</i>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancelar', 'cancel_deposit')],
    ]);
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
        return;
      } catch { /* ignora */ }
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } catch (err) {
    console.error('[deposit_balance] erro:', err);
  }
});

bot.action('cancel_deposit', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  session.step = 'idle';
  await saveSession(userId, session);
  await showBalance(ctx);
});

// ─── /pedidos ─────────────────────────────────────────────────────────────────

async function showOrders(ctx: any) {
  const userId = ctx.from!.id;
  try {
    const orders = await apiClient.getOrders(String(userId));

    if (!orders || orders.length === 0) {
      const text = '🔭 <b>Você ainda não tem pedidos.</b>\n\nFaça sua primeira compra!';
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
        [Markup.button.callback('◀️ Voltar', 'show_home')],
      ]);
      if (ctx.callbackQuery) {
        try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup }); return; } catch { /* ignora */ }
      }
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
      return;
    }

    const lines = orders.slice(0, 10).map((o: any, i: number) => {
      const status = o.status === 'DELIVERED' ? '✅' : o.status === 'PENDING' ? '⏳' : o.status === 'CANCELLED' ? '❌' : '❓';
      return `${i + 1}. ${status} <b>${o.productName}</b> — R$ ${Number(o.amount).toFixed(2)}`;
    });

    const text = `<b>📦 Seus Últimos Pedidos</b>\n\n${lines.join('\n')}\n\n<i>Exibindo até 10 pedidos mais recentes.</i>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🛒 Nova Compra', 'show_products')],
      [Markup.button.callback('◀️ Voltar', 'show_home')],
    ]);
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup }); return; } catch { /* ignora */ }
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } catch {
    await ctx.reply('⚠️ Erro ao carregar pedidos. Tente novamente!', { parse_mode: 'HTML' });
  }
}

bot.command('meus_pedidos', showOrders);

bot.action('show_orders', async (ctx) => {
  await ctx.answerCbQuery('📦 Carregando pedidos...').catch(() => {});
  await showOrders(ctx);
});

// ─── Indicações ────────────────────────────────────────────────────────────────

async function showReferral(ctx: any) {
  try {
    const userId = ctx.from!.id;
    let referralInfo: any = null;
    try {
      referralInfo = await apiClient.getReferralInfo(String(userId));
    } catch { /* ignora se endpoint não existir */ }

    const botUsername = (await bot.telegram.getMe()).username;
    const link = `https://t.me/${botUsername}?start=${userId}`;

    let statsText = '';
    if (referralInfo) {
      statsText =
        `\n\n📊 <b>Suas estatísticas:</b>\n` +
        `• Indicados: <b>${referralInfo.referralCount ?? 0}</b>\n` +
        `• Bônus acumulado: <b>R$ ${Number(referralInfo.bonusEarned ?? 0).toFixed(2)}</b>`;
    }

    const text =
      `👥 <b>Programa de Indicações</b>\n\n` +
      `Indique amigos e ganhe bônus quando eles realizarem a primeira compra!\n\n` +
      `🔗 <b>Seu link de indicação:</b>\n<code>${link}</code>` +
      statsText;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Voltar', 'show_home')],
    ]);

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
        return;
      } catch { /* ignora */ }
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
  } catch (err) {
    console.error('[showReferral] erro:', err);
    await ctx.reply('❌ Erro ao carregar indicações.', { parse_mode: 'HTML' });
  }
}

bot.command('indicacoes', showReferral);

bot.action('show_referral', async (ctx) => {
  await ctx.answerCbQuery('👥 Carregando indicações...').catch(() => {});
  await showReferral(ctx);
});

// ─── Ajuda ────────────────────────────────────────────────────────────────────

async function showHelp(ctx: any) {
  const phone = process.env.SUPPORT_PHONE_NUMBER ?? '';
  const whatsappLine = phone
    ? `\n📞 <a href="https://wa.me/${phone}">Falar com suporte no WhatsApp</a>`
    : '';

  const text =
    `<b>❓ Central de Ajuda</b>\n\n` +
    `<b>Como funciona?</b>\n` +
    `1. Escolha um produto em 🛒 <b>Ver Produtos</b>\n` +
    `2. Selecione a forma de pagamento (PIX ou Saldo)\n` +
    `3. Pague e receba seu produto automaticamente\n\n` +
    `<b>💬 Comandos disponíveis:</b>\n` +
    `/start — Mostra o menu inicial\n` +
    `/produtos — Lista de produtos disponíveis\n` +
    `/saldo — Consultar saldo e histórico\n` +
    `/meus_pedidos — Ver seus pedidos\n` +
    `/indicacoes — Seu link de indicação\n` +
    `/ajuda — Exibe esta mensagem de ajuda\n` +
    `/suporte — Contato com o suporte\n\n` +
    `<b>Problemas?</b>\n` +
    `• PIX não aprovado? Aguarde até 2 minutos e verifique novamente.\n` +
    `• Produto não entregue? Entre em contato com o suporte.` +
    whatsappLine;

  const keyboard = Markup.inlineKeyboard([
    ...(phone ? [[Markup.button.url('📞 Suporte WhatsApp', `https://wa.me/${phone}`)]] : []),
    [Markup.button.callback('◀️ Voltar', 'show_home')],
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
        link_preview_options: { is_disabled: true },
      });
      return;
    } catch { /* ignora */ }
  }
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard.reply_markup,
    link_preview_options: { is_disabled: true },
  });
}

bot.command('ajuda', showHelp);

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showHelp(ctx);
});

// ─── Suporte ──────────────────────────────────────────────────────────────────

bot.command('suporte', async (ctx) => {
  try {
    const phone = process.env.SUPPORT_PHONE_NUMBER ?? '';
    const msg = phone
      ? `💬 <b>Suporte:</b>\n\n<a href="https://wa.me/${phone}">Falar com suporte via WhatsApp</a>`
      : `💬 Entre em contato com o suporte pelo administrador do bot.`;
    await ctx.reply(msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  } catch (err) {
    console.error('[showSupport] erro:', err);
  }
});

// ─── Seleção de produto → tela de quantidade ──────────────────────────────────

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
      console.error('[select_product] erro:', err);
      await ctx.reply('❌ Erro ao buscar produto. Tente novamente.', { parse_mode: 'HTML' });
      return;
    }

    if (!product) { await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' }); return; }
    if (product.stock != null && product.stock <= 0) {
      await ctx.reply('⚠️ Este produto está esgotado no momento.', { parse_mode: 'HTML' });
      return;
    }
    await showQuantityScreen(ctx as unknown as Context, product);
  } catch (err) {
    console.error('[select_product_action] erro:', err);
  }
});

// ─── Seleção de quantidade → tela de pagamento ────────────────────────────────

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
    if (!product) { await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' }); return; }

    await showPaymentMethodScreen(ctx as unknown as Context, product, Number(walletData.balance));
  } catch (err) {
    console.error('[set_qty] erro:', err);
  }
});

// ─── Métodos de pagamento (com botão cancelar) ───────────────────────────────
// Nota: showPaymentMethodScreen já deve incluir o botão cancelar no handler/payments.ts
// Aqui garantimos que as actions de pix/balance/mixed passam o cancel action

bot.action(/^pay_pix_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await executePayment(ctx as unknown as Context, ctx.match[1], 'PIX');
});

bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await executePayment(ctx as unknown as Context, ctx.match[1], 'BALANCE');
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await executePayment(ctx as unknown as Context, ctx.match[1], 'MIXED');
});

// ─── Verificar / cancelar pagamento ──────────────────────────────────────────

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCheckPayment(ctx as unknown as Context, ctx.match[1]);
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCancelPayment(ctx as unknown as Context, ctx.match[1]);
});

bot.action('cancel_payment', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  cancelPIXTimer(userId);
  await clearSession(userId, session.firstName);
  await ctx.reply('❌ Pedido cancelado. Use /produtos para começar novamente.', { parse_mode: 'HTML' });
});

// ─── Cupom ────────────────────────────────────────────────────────────────────

bot.action(/^coupon_input_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showCouponInputScreen(ctx as unknown as Context, ctx.match[1]);
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
    await showPaymentMethodScreen(ctx as unknown as Context, product, Number(walletData.balance));
  } catch (err) {
    console.error('[back_to_payment] erro:', err);
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
    await showPaymentMethodScreen(ctx as unknown as Context, product, Number(walletData.balance));
  } catch (err) {
    console.error('[remove_coupon] erro:', err);
  }
});

// ─── Mensagens de texto (cupom / depósito) ────────────────────────────────────

bot.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const session = await getSession(userId);
    const text = ctx.message.text.trim();

    // ── Cupom
    if (session.step === 'awaiting_coupon' && session.pendingProductId) {
      const couponCode = text.toUpperCase();
      try {
        const products = await apiClient.getProducts();
        const product = products.find((p) => p.id === session.pendingProductId);
        const qty = session.pendingQty ?? 1;
        const orderAmount = Number(product?.price ?? 0) * qty;

        const result = await validateCoupon(couponCode, String(userId), orderAmount, session.pendingProductId);

        if (result.valid && result.data) {
          session.pendingCoupon = couponCode;
          session.pendingCouponDiscount = result.data.discountAmount ?? 0;
          session.step = 'selecting_product';
          await saveSession(userId, session);

          const [, walletData] = await Promise.all([
            Promise.resolve(),
            apiClient.getBalance(String(userId)).catch(() => ({ balance: 0 })),
          ]);

          if (product) {
            await ctx.reply(
              `✅ Cupom <code>${couponCode}</code> aplicado! Desconto: R$ ${(result.data.discountAmount ?? 0).toFixed(2)}`,
              { parse_mode: 'HTML' }
            );
            await showPaymentMethodScreen(ctx as unknown as Context, product, Number(walletData.balance));
          }
        } else {
          await ctx.reply(`❌ ${result.error ?? 'Cupom inválido.'}`, { parse_mode: 'HTML' });
        }
      } catch (err) {
        console.error('[coupon_validate] erro:', err);
        await ctx.reply('❌ Erro ao validar cupom. Tente novamente.', { parse_mode: 'HTML' });
      }
      return;
    }

    // ── Depósito
    if (session.step === 'awaiting_deposit_amount') {
      const amount = parseFloat(text.replace(',', '.'));
      if (isNaN(amount) || amount < 1) {
        await ctx.reply('❌ Valor inválido. Digite um valor mínimo de R$ 1,00.', { parse_mode: 'HTML' });
        return;
      }
      try {
        const deposit = await apiClient.createDeposit(
          String(userId),
          amount,
          ctx.from.first_name,
          ctx.from.username
        );
        const qrText = deposit.pixQrCodeText ?? deposit.pixQrCode ?? '';
        const expiresAt = deposit.expiresAt
          ? new Date(deposit.expiresAt).toISOString()
          : new Date(Date.now() + 30 * 60 * 1000).toISOString();

        session.step = 'awaiting_payment';
        session.depositPaymentId = deposit.paymentId;
        session.pixExpiresAt = expiresAt;
        session.pixQrCodeText = qrText;
        await saveSession(userId, session);

        await ctx.replyWithPhoto(
          { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrText)}` },
          {
            caption: `💳 *Depósito de R\\$ ${String(amount.toFixed(2)).replace('.', '\\.')}*\n\nEscaneie o QR ou copie o código abaixo:`,
            parse_mode: 'MarkdownV2',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Verificar Depósito', `check_payment_${deposit.paymentId}`)],
              [Markup.button.callback('❌ Cancelar Depósito', `cancel_payment_${deposit.paymentId}`)],
            ]).reply_markup,
          }
        );
        await ctx.reply(`<code>${qrText}</code>`, { parse_mode: 'HTML' });
        await schedulePIXExpiry(ctx as unknown as Context, deposit.paymentId, userId, expiresAt);
      } catch (err) {
        console.error('[deposit] erro:', err);
        await ctx.reply('❌ Erro ao gerar PIX de depósito.', { parse_mode: 'HTML' });
      }
      return;
    }
  } catch (err) {
    console.error('[on_text] erro:', err);
  }
});

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('Bot iniciado com sucesso'))
  .catch((err) => {
    console.error('Erro ao iniciar bot:', err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
