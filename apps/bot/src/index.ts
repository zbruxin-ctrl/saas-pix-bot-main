/**
 * Bot Telegram principal — registro de handlers e inicialização.
 *
 * TIPAGEM: os callbacks de bot.action / bot.command / bot.on / bot.start
 *          NÃO recebem anotação de tipo no parâmetro ctx — o Telegraf já
 *          infere o NarrowedContext correto automaticamente.
 *
 *          Os helpers (showHome, showProducts, etc.) aceitam Context genérico
 *          pois são chamados tanto de bot.action quanto de bot.command.
 *
 * FIX #6: referralCode capturado do startPayload e salvo na sessão — propagado ao createPayment.
 * FIX #7: clearSession sem 3º parâmetro — session.ts lê usedCoupons da sessão atual automaticamente.
 * FIX ITEM-8: schedulePIXExpiry agendado após geração de PIX de depósito.
 * FIX ITEM-11: saveSession desnecessário removido de select_product.
 * FEAT-SUPPORT: showHelp busca supportPhone via apiClient.getBotConfig() (painel admin).
 * FIX-WELCOME: showHome busca welcomeMessage via apiClient.getBotConfig() (painel admin).
 * FIX-MD2HTML: welcomeMessage convertida de Markdown para HTML antes de exibir.
 */
import { Telegraf, Markup } from 'telegraf';
import type { Context } from 'telegraf';
import { apiClient } from './services/apiClient';
import { getSession, saveSession, clearSession } from './services/session';
import { validateCoupon } from './services/couponClient';
import { registerReferral } from './services/referralClient';
import type { WalletTransactionDTO } from '@saas-pix/shared';
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

// Cache do username do bot (evita chamar getMe() a cada /indicacoes)
let cachedBotUsername: string | null = null;
async function getBotUsername(): Promise<string> {
  if (!cachedBotUsername) {
    const me = await bot.telegram.getMe();
    cachedBotUsername = me.username ?? '';
  }
  return cachedBotUsername;
}

// ─── Markdown → HTML helper ───────────────────────────────────────────────────
// Converte subset básico de Markdown (negrito, itálico, código, links) para HTML.
// Necessário pois o painel admin salva a mensagem com Markdown mas o bot usa parse_mode HTML.
function mdToHtml(text: string): string {
  return text
    // Escapa caracteres HTML antes de inserir tags (evita double-encode)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // **negrito** → <b>negrito</b>
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    // *itálico* ou _itálico_ → <i>itálico</i>
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
    .replace(/_(.*?)_/g, '<i>$1</i>')
    // `código` → <code>código</code>
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // [texto](url) → <a href="url">texto</a>
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

// ─── showHome ─────────────────────────────────────────────────────────────────

const DEFAULT_WELCOME =
  '🛒 Aqui você pode adquirir nossos produtos de forma rápida e segura.\n\n' +
  '💳 Aceitamos pagamento via <b>PIX</b> (confirmação instantânea) ou via <b>saldo pré-carregado</b>.';

async function showHome(ctx: Context): Promise<void> {
  const config = await apiClient.getBotConfig().catch(() => ({ welcomeMessage: '' }));
  // Converte Markdown → HTML caso o admin tenha digitado com formatação Markdown
  const rawMsg = config.welcomeMessage?.trim();
  const welcomeMsg = rawMsg ? mdToHtml(rawMsg) : DEFAULT_WELCOME;

  const firstName = ctx.from?.first_name ?? 'visitante';
  const text =
    `👋 Olá, <b>${firstName}</b>! Bem-vindo!\n\n` +
    `${welcomeMsg}\n\n` +
    `Escolha uma opção no <b>menu</b> para começar:\n\nPara ver nossos produtos, clique no botão abaixo:`;

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
      // FIX #6: salva referralCode na sessão para ser propagado ao createPayment
      if (!session.referralCode) {
        session.referralCode = referralCode;
      }
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
      await schedulePIXExpiry(ctx, session.paymentId, userId, session.pixExpiresAt);
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

async function showProducts(ctx: Context): Promise<void> {
  try {
    const products = await apiClient.getProducts();
    if (!products.length) {
      await ctx.reply('🛋️ Nenhum produto disponível no momento.', { parse_mode: 'HTML' });
      return;
    }

    const buttons = products.map((p: ProductDTO) => {
      let stockLabel = '';
      if (p.availableStock != null) {
        stockLabel = p.availableStock <= 0 ? ' ❌ Esgotado' : ` (${p.availableStock} restantes)`;
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

bot.command('produtos', (ctx) => showProducts(ctx));

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produtos...').catch(() => {});
  await showProducts(ctx);
});

// ─── /saldo ───────────────────────────────────────────────────────────────────

async function showBalance(ctx: Context): Promise<void> {
  try {
    const userId   = ctx.from!.id;
    const data     = await apiClient.getBalance(String(userId));

    const txs: WalletTransactionDTO[] = data.transactions ?? [];

    let historyText = '';
    if (txs.length > 0) {
      const lines = txs.slice(0, 5).map((t) => {
        const sign  = t.type === 'DEPOSIT' ? '+' : '-';
        const emoji = t.type === 'DEPOSIT' ? '🟢' : '🔴';
        const date  = t.createdAt
          ? new Date(t.createdAt).toLocaleDateString('pt-BR')
          : '';
        return (
          `${emoji} ${sign}R$ ${Number(t.amount).toFixed(2)} — ` +
          `${t.description ?? t.type}` +
          `${date ? ` <i>(${date})</i>` : ''}`
        );
      });
      historyText = `\n\n📃 <b>Últimas transações:</b>\n${lines.join('\n')}`;
    } else {
      historyText = '\n\n<i>Nenhuma transação encontrada.</i>';
    }

    const text     = `💰 <b>Seu saldo:</b> R$ ${Number(data.balance).toFixed(2)}${historyText}`;
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

bot.command('saldo', (ctx) => showBalance(ctx));

bot.action('show_balance', async (ctx) => {
  await ctx.answerCbQuery('⏳ Buscando saldo...').catch(() => {});
  await showBalance(ctx);
});

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const userId  = ctx.from.id;
    const session = await getSession(userId);
    session.step  = 'awaiting_deposit_amount';
    await saveSession(userId, session);

    const text     = `💳 <b>Depositar saldo</b>\n\nDigite o valor que deseja depositar (mínimo R$ 1,00):\n\n<i>Para cancelar, clique no botão abaixo.</i>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancelar', 'cancel_deposit')],
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    }
  } catch (err) {
    console.error('[deposit_balance] erro:', err);
  }
});

bot.action('cancel_deposit', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId  = ctx.from.id;
  const session = await getSession(userId);
  session.step  = 'idle';
  await saveSession(userId, session);
  await showBalance(ctx);
});

// ─── /pedidos ─────────────────────────────────────────────────────────────────

async function showOrders(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const orders = await apiClient.getOrders(String(userId));

    if (!orders || orders.length === 0) {
      const text     = '🔭 <b>Você ainda não tem pedidos.</b>\n\nFaça sua primeira compra!';
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

    const lines = orders.slice(0, 10).map((o, i) => {
      const status =
        o.status === 'DELIVERED'  ? '✅' :
        o.status === 'PROCESSING' ? '⏳' :
        o.status === 'CANCELLED'  ? '❌' : '❓';
      return `${i + 1}. ${status} <b>${o.productName}</b> — R$ ${Number(o.amount).toFixed(2)}`;
    });

    const text     = `<b>📦 Seus Últimos Pedidos</b>\n\n${lines.join('\n')}\n\n<i>Exibindo até 10 pedidos mais recentes.</i>`;
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

bot.command('meus_pedidos', (ctx) => showOrders(ctx));

bot.action('show_orders', async (ctx) => {
  await ctx.answerCbQuery('📦 Carregando pedidos...').catch(() => {});
  await showOrders(ctx);
});

// ─── Indicações ────────────────────────────────────────────────────────────────

async function showReferral(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from!.id;
    let referralInfo: { referralCount?: number; purchaseCount?: number; bonusEarned?: number } | null = null;
    try {
      referralInfo = await apiClient.getReferralInfo(String(userId));
    } catch { /* ignora se endpoint não existir */ }

    const botUsername = await getBotUsername();
    const link        = `https://t.me/${botUsername}?start=${userId}`;

    let statsText = '';
    if (referralInfo) {
      const usaram    = referralInfo.referralCount ?? 0;
      const compraram = referralInfo.purchaseCount ?? 0;
      const bonus     = Number(referralInfo.bonusEarned ?? 0).toFixed(2);
      statsText =
        `\n\n📊 <b>Suas estatísticas:</b>\n` +
        `👆 Pessoas que usaram seu link: <b>${usaram}</b>\n` +
        `🛒 Dessas, compraram: <b>${compraram}</b>\n` +
        `💰 Bônus acumulado: <b>R$ ${bonus}</b>`;
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

bot.command('indicacoes', (ctx) => showReferral(ctx));

bot.action('show_referral', async (ctx) => {
  await ctx.answerCbQuery('👥 Carregando indicações...').catch(() => {});
  await showReferral(ctx);
});

// ─── Ajuda ────────────────────────────────────────────────────────────────────

async function showHelp(ctx: Context): Promise<void> {
  // Busca o telefone de suporte dinamicamente do painel admin
  const config = await apiClient.getBotConfig().catch(() => ({ supportPhone: '' }));
  const phone = config.supportPhone || '';

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

bot.command('ajuda', (ctx) => showHelp(ctx));

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showHelp(ctx);
});

// ─── Suporte ──────────────────────────────────────────────────────────────────

bot.command('suporte', async (ctx) => {
  try {
    const config = await apiClient.getBotConfig().catch(() => ({ supportPhone: '' }));
    const phone = config.supportPhone || '';
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
    const userId    = ctx.from.id;
    // FIX ITEM-11: sessão lida mas NÃO salva aqui — nenhuma alteração foi feita nela
    await getSession(userId);

    let product: ProductDTO | undefined;
    try {
      const products = await apiClient.getProducts();
      product = products.find((p) => p.id === productId);
    } catch (err) {
      console.error('[select_product] erro:', err);
      await ctx.reply('❌ Erro ao buscar produto. Tente novamente.', { parse_mode: 'HTML' });
      return;
    }

    if (!product) {
      await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' });
      return;
    }
    if (product.availableStock != null && product.availableStock <= 0) {
      await ctx.reply('⚠️ Este produto está esgotado no momento.', { parse_mode: 'HTML' });
      return;
    }
    await showQuantityScreen(ctx, product);
  } catch (err) {
    console.error('[select_product_action] erro:', err);
  }
});

// ─── Seleção de quantidade → tela de pagamento ────────────────────────────────

bot.action(/^set_qty_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const productId = ctx.match[1];
    const qty       = parseInt(ctx.match[2], 10);
    const userId    = ctx.from.id;

    const session = await getSession(userId);
    session.pendingQty        = qty;
    session.selectedProductId = productId;
    session.step              = 'selecting_product';
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
    console.error('[set_qty] erro:', err);
  }
});

// ─── Métodos de pagamento ────────────────────────────────────────────────────────────

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

// ─── Verificar / cancelar pagamento ──────────────────────────────────────────

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
  const userId  = ctx.from.id;
  const session = await getSession(userId);
  cancelPIXTimer(userId);
  await clearSession(userId, session.firstName);
  await ctx.reply('❌ Pedido cancelado. Use /produtos para começar novamente.', {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
    ]).reply_markup,
  });
});

// ─── Cupom ────────────────────────────────────────────────────────────────────

bot.action(/^coupon_input_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showCouponInputScreen(ctx, ctx.match[1]);
});

bot.action(/^back_to_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId    = ctx.from.id;
    const [products, walletData] = await Promise.all([
      apiClient.getProducts(),
      apiClient.getBalance(String(userId)).catch(() => ({ balance: 0 })),
    ]);
    const product = products.find((p) => p.id === productId);
    if (!product) { await ctx.reply('❌ Produto não encontrado.'); return; }
    await showPaymentMethodScreen(ctx, product, Number(walletData.balance));
  } catch (err) {
    console.error('[back_to_payment] erro:', err);
  }
});

bot.action(/^remove_coupon_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const productId = ctx.match[1];
    const userId    = ctx.from.id;
    const session   = await getSession(userId);
    session.pendingCoupon         = null;
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
    console.error('[remove_coupon] erro:', err);
  }
});

// ─── Mensagens de texto (cupom / depósito) ────────────────────────────────────

bot.on('text', async (ctx) => {
  try {
    const userId  = ctx.from.id;
    const session = await getSession(userId);
    const text    = ctx.message.text.trim();

    // ── Cupom
    if (session.step === 'awaiting_coupon' && session.pendingProductId) {
      const productId = session.pendingProductId;

      // Busca produto para calcular o valor a ser enviado ao endpoint de validação
      let orderAmount = 0;
      try {
        const products = await apiClient.getProducts();
        const product  = products.find((p) => p.id === productId);
        if (product) {
          const qty = session.pendingQty ?? 1;
          orderAmount = Number(product.price) * qty;
        }
      } catch { /* usa 0 como fallback */ }

      const result = await validateCoupon(text.toUpperCase(), String(userId), orderAmount, productId);

      if (!result.valid || !result.data) {
        await ctx.reply(
          `❌ ${result.error ?? 'Cupom inválido ou expirado.'}`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('◀️ Voltar', `back_to_payment_${productId}`)],
            ]).reply_markup,
          }
        );
        return;
      }

      session.pendingCoupon         = text.toUpperCase();
      session.pendingCouponDiscount = result.data.discountAmount;
      session.step                  = 'selecting_product';
      await saveSession(userId, session);

      const [products, walletData] = await Promise.all([
        apiClient.getProducts(),
        apiClient.getBalance(String(userId)).catch(() => ({ balance: 0 })),
      ]);
      const product = products.find((p) => p.id === productId);
      if (!product) { await ctx.reply('❌ Produto não encontrado.', { parse_mode: 'HTML' }); return; }
      await showPaymentMethodScreen(ctx, product, Number(walletData.balance));
      return;
    }

    // ── Depósito
    if (session.step === 'awaiting_deposit_amount') {
      const raw   = text.replace(',', '.');
      const value = parseFloat(raw);

      if (isNaN(value) || value < 1) {
        await ctx.reply(
          `❌ Valor inválido. Digite um valor numérico maior ou igual a R$ 1,00.`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('❌ Cancelar', 'cancel_deposit')],
            ]).reply_markup,
          }
        );
        return;
      }

      session.step = 'idle';
      await saveSession(userId, session);

      await ctx.reply('⏳ <b>Gerando PIX de depósito...</b>', { parse_mode: 'HTML' });

      try {
        const deposit = await apiClient.createDeposit(
          String(userId),
          value,
          ctx.from.first_name,
          ctx.from.username
        );

        // FIX ITEM-1: pixCopyPaste não existe em CreateDepositResponse — usa apenas pixQrCodeText
        const qrText  = deposit.pixQrCodeText ?? '';
        const qrImage = deposit.pixQrCode ?? '';

        if (qrImage) {
          await ctx.replyWithPhoto(
            { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrText)}` },
            {
              caption: `💳 *PIX gerado\\!*\n\n*Valor:* R\\$ ${String(value.toFixed(2)).replace('.', '\\.')}\n\nEscaneie o QR ou copie o código abaixo:`,
              parse_mode: 'MarkdownV2',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Verificar Depósito', `check_payment_${deposit.paymentId}`)],
                [Markup.button.callback('❌ Cancelar', `cancel_payment_${deposit.paymentId}`)],
              ]).reply_markup,
            }
          );
        } else {
          await ctx.reply(
            `💳 <b>PIX de depósito gerado!</b>\n\nValor: R$ ${value.toFixed(2)}\n\nCopie o código abaixo:`,
            {
              parse_mode: 'HTML',
              reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Verificar Depósito', `check_payment_${deposit.paymentId}`)],
                [Markup.button.callback('❌ Cancelar', `cancel_payment_${deposit.paymentId}`)],
              ]).reply_markup,
            }
          );
        }
        await ctx.reply(`<code>${qrText}</code>`, { parse_mode: 'HTML' });

        // FIX ITEM-8: agenda timer de expiração para o PIX de depósito
        if (deposit.expiresAt) {
          await schedulePIXExpiry(ctx, deposit.paymentId, userId, deposit.expiresAt);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao gerar depósito';
        await ctx.reply(`❌ ${msg}`, { parse_mode: 'HTML' });
      }
      return;
    }
  } catch (err) {
    console.error('[bot.on text] erro:', err);
  }
});

// ─── Inicialização ────────────────────────────────────────────────────────────

const WEBHOOK_URL  = process.env.WEBHOOK_URL;
const WEBHOOK_PORT = parseInt(process.env.PORT ?? '3001', 10);

if (WEBHOOK_URL) {
  bot.launch({ webhook: { domain: WEBHOOK_URL, port: WEBHOOK_PORT } })
    .then(() => console.log(`[bot] ✅ Webhook ativo em ${WEBHOOK_URL} (porta ${WEBHOOK_PORT})`))
    .catch((err) => { console.error('[bot] ❌ Falha ao iniciar webhook:', err); process.exit(1); });
} else {
  bot.launch()
    .then(() => console.log('[bot] ✅ Polling ativo'))
    .catch((err) => { console.error('[bot] ❌ Falha ao iniciar polling:', err); process.exit(1); });
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
