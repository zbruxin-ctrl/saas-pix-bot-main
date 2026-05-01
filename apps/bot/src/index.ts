// Bot do Telegram - Ponto de entrada principal
// FEAT-MAINT: middleware global de manutencao
// FEAT-BLOCKED: middleware global de bloqueio de usuario
//   Acoes bloqueadas: ver produtos, comprar, adicionar saldo
//   Acoes permitidas: /start (mostra msg), /ajuda, /meus_pedidos, ver saldo
// FEAT-DESC: descricao rica dos produtos
// FEAT-CANCEL-DEPOSIT: botao cancelar PIX de deposito
// FIX-CANCEL: deleta foto do QR + envia msg de texto limpa + lock anti-duplo-clique
import express from 'express';
import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import type { ExtraEditMessageText } from 'telegraf/typings/telegram-types';
import { env } from './config/env';
import { apiClient, invalidateProductCache, invalidateBotConfigCache } from './services/apiClient';
import type { OrderSummary } from './services/apiClient';
import type { ProductDTO, WalletTransactionDTO } from '@saas-pix/shared';

import winston from 'winston';
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [BOT][${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

function escapeMd(text: string): string {
  return String(text ?? '').replace(/[_*`[]/g, '\\$&');
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface UserSession {
  step: 'idle' | 'selecting_product' | 'awaiting_payment' | 'awaiting_deposit_amount';
  selectedProductId?: string;
  paymentId?: string;
  depositPaymentId?: string;
  depositMessageId?: number; // ID da mensagem de foto do QR de deposito
  products?: ProductDTO[];
  mainMessageId?: number;
  firstName?: string;
  lastActivityAt: number;
}

const sessions = new Map<number, UserSession>();

function getSession(userId: number): UserSession {
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: 'idle', lastActivityAt: Date.now() });
  }
  const session = sessions.get(userId)!;
  session.lastActivityAt = Date.now();
  return session;
}

const SESSION_MAX_IDLE_MS = 60 * 60_000;
const SESSION_CLEANUP_INTERVAL_MS = 30 * 60_000;

function cleanupSessions(): void {
  const now = Date.now();
  let removed = 0;
  for (const [userId, session] of sessions.entries()) {
    if (session.step === 'idle' && now - session.lastActivityAt > SESSION_MAX_IDLE_MS) {
      sessions.delete(userId);
      removed++;
    }
  }
  if (removed > 0) logger.info(`[cleanup] ${removed} sessao(oes) idle removida(s). Total ativo: ${sessions.size}`);
}
setInterval(cleanupSessions, SESSION_CLEANUP_INTERVAL_MS);

const processedUpdateIds = new Set<number>();
setInterval(() => { processedUpdateIds.clear(); }, 5 * 60_000);

const paymentInProgress = new Set<number>();

// Lock para evitar duplo clique em cancelamentos
const cancelInProgress = new Set<string>(); // chave: paymentId

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

async function registerCommands(): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: 'start', description: '\ud83c\udfe0 Menu inicial' },
    { command: 'produtos', description: '\ud83d\udecd\ufe0f Ver produtos dispon\u00edveis' },
    { command: 'saldo', description: '\ud83d\udcb0 Ver meu saldo e adicionar' },
    { command: 'meus_pedidos', description: '\ud83d\udce6 Hist\u00f3rico de pedidos' },
    { command: 'ajuda', description: '\u2753 Central de ajuda e suporte' },
  ]);
  logger.info('\u2705 Menu de comandos registrado no Telegram');
}

async function editOrReply(
  ctx: Context,
  text: string,
  extra?: ExtraEditMessageText
): Promise<void> {
  const session = getSession(ctx.from!.id);
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.replyWithMarkdown(text, extra as object);
    return;
  }
  if (session.mainMessageId) {
    try {
      await ctx.telegram.editMessageText(chatId, session.mainMessageId, undefined, text, {
        parse_mode: 'Markdown',
        ...extra,
      });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (
        !msg.includes('message is not modified') &&
        !msg.includes('message to edit not found') &&
        !msg.includes('MESSAGE_ID_INVALID')
      ) {
        logger.warn(`[editOrReply] Erro ao editar: ${msg}`);
      }
    }
  }
  const sent = await ctx.replyWithMarkdown(text, extra as object);
  session.mainMessageId = sent.message_id;
}

async function editOrReplyHtml(
  ctx: Context,
  text: string,
  extra?: ExtraEditMessageText
): Promise<void> {
  const session = getSession(ctx.from!.id);
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.telegram.sendMessage(ctx.from!.id, text, { parse_mode: 'HTML', ...(extra as object) });
    return;
  }
  if (session.mainMessageId) {
    try {
      await ctx.telegram.editMessageText(chatId, session.mainMessageId, undefined, text, {
        parse_mode: 'HTML',
        ...extra,
      });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (
        !msg.includes('message is not modified') &&
        !msg.includes('message to edit not found') &&
        !msg.includes('MESSAGE_ID_INVALID')
      ) {
        logger.warn(`[editOrReplyHtml] Erro ao editar: ${msg}`);
      }
    }
  }
  const sent = await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...(extra as object) });
  session.mainMessageId = sent.message_id;
}

// FIX-CANCEL: deleta a mensagem de foto (QR) e envia uma mensagem de texto limpa no lugar.
async function deletePhotoAndReply(
  ctx: Context,
  session: UserSession,
  text: string,
  extra?: ExtraEditMessageText
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    const sent = await ctx.replyWithMarkdown(text, extra as object);
    session.mainMessageId = sent.message_id;
    session.depositMessageId = undefined;
    return;
  }

  const photoMsgId = session.depositMessageId ?? session.mainMessageId;
  if (photoMsgId) {
    await ctx.telegram.deleteMessage(chatId, photoMsgId).catch(() => {});
    session.mainMessageId = undefined;
    session.depositMessageId = undefined;
  }

  const sent = await ctx.telegram.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...(extra as object),
  });
  session.mainMessageId = sent.message_id;
}

// ─── Mensagem de conta suspensa ──────────────────────────────────────────
async function showBlockedMessage(ctx: Context): Promise<void> {
  const supportUrl = `https://wa.me/${escapeHtml(env.SUPPORT_PHONE)}`;
  await editOrReply(
    ctx,
    `\ud83d\udea8 *Conta Suspensa*\n\n` +
      `Sua conta foi *suspensa* e o acesso a compras e dep\u00f3sitos est\u00e1 restrito.\n\n` +
      `Voc\u00ea ainda pode:\n` +
      `\u2705 Ver seu saldo\n` +
      `\u2705 Consultar seus pedidos\n` +
      `\u2705 Acessar a ajuda\n\n` +
      `Se acredita que isso \u00e9 um erro, entre em contato com o suporte.`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('\ud83d\udcde Falar com Suporte', supportUrl)],
        [Markup.button.callback('\ud83d\udcb0 Ver Saldo', 'show_balance')],
        [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('\u2753 Ajuda', 'show_help')],
      ]).reply_markup,
    }
  );
}

// ─── Middleware global (manutencao + bloqueio) ──────────────────────────────
const BLOCKED_ALLOWED_ACTIONS = new Set([
  'show_balance',
  'show_orders',
  'show_help',
  'show_home',
]);

function isBlockedAllowedAction(callbackData: string): boolean {
  return BLOCKED_ALLOWED_ACTIONS.has(callbackData);
}

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const telegramId = String(userId);
  let config: { maintenanceMode: boolean; maintenanceMessage: string; isBlocked: boolean };

  try {
    config = await apiClient.getBotConfig(telegramId);
  } catch {
    return next();
  }

  if (config.maintenanceMode) {
    const session = getSession(userId);
    const firstName = escapeMd(session.firstName || ctx.from?.first_name || 'visitante');
    const maintMsg = config.maintenanceMessage || 'Estamos em manuten\u00e7\u00e3o. Voltamos em breve!';
    const text =
      `\ud83d\udee0\ufe0f *Manuten\u00e7\u00e3o em Andamento*\n\n` +
      `Ol\u00e1, *${firstName}*!\n\n` +
      `${escapeMd(maintMsg)}\n\n` +
      `_Pedimos desculpas pelo inconveniente. Em breve estaremos de volta!_ \ud83d\ude0a`;

    if ('callbackQuery' in ctx && ctx.callbackQuery) {
      await ctx.answerCbQuery('\ud83d\udee0\ufe0f Bot em manuten\u00e7\u00e3o', { show_alert: true }).catch(() => {});
    }

    if (session.mainMessageId && ctx.chat?.id) {
      await ctx.telegram.editMessageText(ctx.chat.id, session.mainMessageId, undefined, text, {
        parse_mode: 'Markdown',
      }).catch(async () => {
        const sent = await ctx.replyWithMarkdown(text).catch(() => null);
        if (sent) session.mainMessageId = sent.message_id;
      });
    } else {
      const sent = await ctx.replyWithMarkdown(text).catch(() => null);
      if (sent) getSession(userId).mainMessageId = sent.message_id;
    }
    return;
  }

  if (config.isBlocked) {
    const isStartCommand = 'message' in ctx && (ctx.message as { text?: string })?.text === '/start';
    const isCallbackQuery = 'callbackQuery' in ctx && ctx.callbackQuery;
    const callbackData = isCallbackQuery ? ('data' in ctx.callbackQuery! ? ctx.callbackQuery!.data : '') : '';

    if (isStartCommand) {
      const session = getSession(userId);
      session.firstName = ctx.from?.first_name;
      if (session.mainMessageId && ctx.chat?.id) {
        await ctx.telegram.deleteMessage(ctx.chat.id, session.mainMessageId).catch(() => {});
        session.mainMessageId = undefined;
      }
      await showBlockedMessage(ctx);
      return;
    }

    const isAllowedCommand =
      'message' in ctx &&
      ['/ajuda', '/meus_pedidos', '/saldo'].some(
        (cmd) => (ctx.message as { text?: string })?.text?.startsWith(cmd)
      );
    if (isAllowedCommand) return next();

    if (isCallbackQuery) {
      if (isBlockedAllowedAction(callbackData)) return next();
      await ctx.answerCbQuery('\ud83d\udea8 Conta suspensa \u2014 a\u00e7\u00e3o n\u00e3o permitida', { show_alert: true }).catch(() => {});
      await showBlockedMessage(ctx);
      return;
    }

    if ('message' in ctx && (ctx.message as { text?: string })?.text) {
      await showBlockedMessage(ctx);
      return;
    }

    return next();
  }

  return next();
});

async function showHome(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const firstName = escapeMd(session.firstName || ctx.from?.first_name || 'visitante');

  await editOrReply(
    ctx,
    `\ud83d\udc4b Ol\u00e1, *${firstName}*! Bem-vindo!\n\n` +
      `\ud83d\uded2 Aqui voc\u00ea pode adquirir nossos produtos e planos de forma r\u00e1pida e segura.\n\n` +
      `\ud83d\udcb3 Aceitamos pagamento via *PIX* (confirma\u00e7\u00e3o instant\u00e2nea) ou via *saldo* pr\u00e9-carregado.\n\n` +
      `Para ver nossos produtos, clique no bot\u00e3o abaixo:`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('\ud83d\udecd\ufe0f Ver Produtos', 'show_products')],
        [Markup.button.callback('\ud83d\udcb0 Meu Saldo', 'show_balance')],
        [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('\u2753 Ajuda', 'show_help')],
      ]).reply_markup,
    }
  );
}

bot.command('start', async (ctx) => {
  const firstName = escapeMd(ctx.from?.first_name || 'visitante');
  const userId = ctx.from!.id;

  sessions.set(userId, {
    step: 'idle',
    mainMessageId: undefined,
    firstName: ctx.from?.first_name || 'visitante',
    lastActivityAt: Date.now(),
  });

  const sent = await ctx.replyWithMarkdown(
    `\ud83d\udc4b Ol\u00e1, *${firstName}*! Bem-vindo!\n\n` +
      `\ud83d\uded2 Aqui voc\u00ea pode adquirir nossos produtos e planos de forma r\u00e1pida e segura.\n\n` +
      `\ud83d\udcb3 Aceitamos pagamento via *PIX* (confirma\u00e7\u00e3o instant\u00e2nea) ou via *saldo* pr\u00e9-carregado.\n\n` +
      `Para ver nossos produtos, clique no bot\u00e3o abaixo:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('\ud83d\udecd\ufe0f Ver Produtos', 'show_products')],
      [Markup.button.callback('\ud83d\udcb0 Meu Saldo', 'show_balance')],
      [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
      [Markup.button.callback('\u2753 Ajuda', 'show_help')],
    ])
  );

  getSession(userId).mainMessageId = sent.message_id;
});

bot.command('produtos', async (ctx) => { await showProducts(ctx); });
bot.command('saldo', async (ctx) => { await showBalance(ctx); });
bot.command('ajuda', async (ctx) => { await showHelp(ctx); });
bot.command('meus_pedidos', async (ctx) => { await showOrders(ctx); });

bot.action('show_home', async (ctx) => {
  await ctx.answerCbQuery();
  await showHome(ctx);
});

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery('\u23f3 Carregando produtos...');
  await showProducts(ctx);
});

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery();
  await showHelp(ctx);
});

bot.action('show_orders', async (ctx) => {
  await ctx.answerCbQuery('\ud83d\udce6 Carregando pedidos...');
  await showOrders(ctx);
});

async function showBalance(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const { balance, transactions } = await apiClient.getBalance(String(userId));

    const txLines = (transactions as WalletTransactionDTO[])
      .slice(0, 5)
      .map((t) => {
        const sinal = t.type === 'DEPOSIT' ? '\u2795' : '\u2796';
        return `${sinal} R$ ${Number(t.amount).toFixed(2)} \u2014 ${escapeMd(t.description)}`;
      })
      .join('\n');

    const texto =
      `\ud83d\udcb0 *Seu Saldo*\n\n` +
      `Dispon\u00edvel: *R$ ${Number(balance).toFixed(2)}*\n\n` +
      (txLines ? `*\u00daltimas transa\u00e7\u00f5es:*\n${txLines}\n\n` : '_Nenhuma transa\u00e7\u00e3o ainda._\n\n') +
      `Use seu saldo para comprar sem precisar fazer PIX toda hora!`;

    const config = await apiClient.getBotConfig(String(userId)).catch(() => ({ isBlocked: false }));
    const buttons = config.isBlocked
      ? [
          [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
          [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
        ]
      : [
          [Markup.button.callback('\u2795 Adicionar Saldo', 'deposit_balance')],
          [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
        ];

    await editOrReply(ctx, texto, {
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (err) {
    logger.error(`Erro ao buscar saldo para ${userId}:`, err);
    await editOrReply(ctx, '\u274c Erro ao buscar saldo. Tente novamente.', {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')]]).reply_markup,
    });
  }
}

bot.action('show_balance', async (ctx) => {
  await ctx.answerCbQuery('\u23f3 Buscando saldo...');
  await showBalance(ctx);
});

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from!.id);
  session.step = 'awaiting_deposit_amount';
  await ctx.replyWithMarkdown(
    `\ud83d\udcb3 *Adicionar Saldo*\n\n` +
      `Digite o valor em reais que deseja depositar:\n` +
      `_(m\u00ednimo R$ 1,00 | m\u00e1ximo R$ 10.000,00)_\n\n` +
      `Exemplo: \`25\` ou \`50.00\``
  );
});

bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('\u23f3 Carregando produto...');
  const productId = ctx.match[1];
  const userId = ctx.from!.id;
  const session = getSession(userId);

  let product: ProductDTO | undefined = session.products?.find((p) => p.id === productId);
  let balanceResult = 0;

  if (!product) {
    try {
      const [products, walletData] = await Promise.all([
        apiClient.getProducts(),
        apiClient.getBalance(String(userId)).catch(() => ({ balance: 0, transactions: [] })),
      ]);
      product = products.find((p) => p.id === productId);
      session.products = products;
      balanceResult = Number(walletData.balance);
    } catch {
      await editOrReply(ctx, '\u274c Erro ao buscar produto. Tente novamente.');
      return;
    }
  } else {
    try {
      const walletData = await apiClient.getBalance(String(userId));
      balanceResult = Number(walletData.balance);
    } catch {
      balanceResult = 0;
    }
  }

  if (!product) {
    await editOrReply(ctx, '\u274c Produto n\u00e3o encontrado.');
    return;
  }

  if (product.stock !== null && product.stock !== undefined && product.stock <= 0) {
    await editOrReply(ctx, '\u26a0\ufe0f Este produto est\u00e1 esgotado no momento.');
    return;
  }

  session.selectedProductId = productId;
  session.step = 'selecting_product';

  await showPaymentMethodScreen(ctx, product, balanceResult);
});

async function showPaymentMethodScreen(ctx: Context, product: ProductDTO, preloadedBalance?: number): Promise<void> {
  const userId = ctx.from!.id;
  let balance = preloadedBalance ?? 0;

  if (preloadedBalance === undefined) {
    try {
      const walletData = await apiClient.getBalance(String(userId));
      balance = Number(walletData.balance);
    } catch {
      balance = 0;
    }
  }

  const price = Number(product.price);
  const balanceStr = balance.toFixed(2);

  const descLine = product.description
    ? `\n\ud83d\udcdd _${escapeMd(product.description)}_\n`
    : '';

  const confirmMessage =
    `\ud83d\udce6 *${escapeMd(product.name)}*` +
    descLine +
    `\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
    `\ud83d\udcb0 *Valor:* R$ ${price.toFixed(2)}\n` +
    `\ud83c\udfe6 *Seu saldo:* R$ ${balanceStr}\n\n` +
    `*Como deseja pagar?*`;

  const buttons = [];

  if (balance >= price) {
    buttons.push([Markup.button.callback(`\ud83d\udcb0 S\u00f3 Saldo  (R$ ${price.toFixed(2)})`, `pay_balance_${product.id}`)]);
  }

  buttons.push([Markup.button.callback(`\ud83d\udcf1 S\u00f3 PIX  (R$ ${price.toFixed(2)})`, `pay_pix_${product.id}`)]);

  if (balance > 0 && balance < price) {
    const pixDiff = (price - balance).toFixed(2);
    buttons.push([Markup.button.callback(`\ud83d\udd00 Saldo + PIX  (saldo R$ ${balanceStr} + PIX R$ ${pixDiff})`, `pay_mixed_${product.id}`)]);
  }

  buttons.push([Markup.button.callback('\u25c0\ufe0f Voltar', 'show_products')]);

  await editOrReply(ctx, confirmMessage, {
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
  });
}

async function executePayment(
  ctx: Context,
  productId: string,
  paymentMethod: 'BALANCE' | 'PIX' | 'MIXED'
): Promise<void> {
  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (paymentInProgress.has(userId)) {
    logger.warn(`[B13] Pagamento ja em andamento para ${userId}`);
    return;
  }
  paymentInProgress.add(userId);

  try {
    await editOrReply(ctx, '\u23f3 Processando sua compra, aguarde...');

    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      firstName: ctx.from?.first_name,
      username: ctx.from?.username,
      paymentMethod,
    });

    session.paymentId = payment.paymentId;
    session.step = 'awaiting_payment';

    if (payment.paidWithBalance) {
      await editOrReply(
        ctx,
        `\u2705 *Compra realizada com saldo!*\n\n` +
          `\ud83d\udce6 *Produto:* ${escapeMd(payment.productName)}\n` +
          `\ud83d\udcb0 *Valor debitado:* R$ ${Number(payment.amount).toFixed(2)}\n\n` +
          `Seu produto ser\u00e1 entregue em instantes! \ud83d\ude80`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('\ud83c\udfe0 Menu Inicial', 'show_home')],
            [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
          ]).reply_markup,
        }
      );
      session.step = 'idle';
      return;
    }

    const expiresAt = new Date(payment.expiresAt);
    const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    const mixedLine = payment.isMixed
      ? `\n\ud83d\udcb3 *Saldo usado:* R$ ${Number(payment.balanceUsed).toFixed(2)}\n\ud83d\udcf1 *PIX a pagar:* R$ ${Number(payment.pixAmount).toFixed(2)}`
      : '';

    const qrBuffer = Buffer.from(payment.pixQrCode, 'base64');
    const caption =
      `\ud83d\udcb3 *Pagamento PIX Gerado!*\n\n` +
      `\ud83d\udce6 *Produto:* ${escapeMd(payment.productName)}\n` +
      `\ud83d\udcb0 *Valor total:* R$ ${Number(payment.amount).toFixed(2)}${mixedLine}\n` +
      `\u23f0 *V\u00e1lido at\u00e9:* ${expiresStr}\n` +
      `\ud83e\udeaa *ID:* \`${payment.paymentId}\`\n\n` +
      `\ud83d\udccb *Copia e Cola:*\n\`${payment.pixQrCodeText}\``;

    const chatId = ctx.chat?.id;
    if (chatId && session.mainMessageId) {
      await ctx.telegram.deleteMessage(chatId, session.mainMessageId).catch(() => {});
      session.mainMessageId = undefined;
    }

    const qrMsg = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('\ud83d\udd04 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
          [Markup.button.callback('\u274c Cancelar', `cancel_payment_${payment.paymentId}`)],
        ]).reply_markup,
      }
    );

    session.mainMessageId = qrMsg.message_id;
    logger.info(`[${paymentMethod}] PIX gerado para usuario ${userId} | Pagamento: ${payment.paymentId}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    const errStatus = (error as { statusCode?: number }).statusCode ?? 0;
    logger.error(`Erro ao processar pagamento (${paymentMethod}) para ${userId}:`, error);

    if (errStatus === 403 || errMsg.toLowerCase().includes('suspensa') || errMsg.toLowerCase().includes('bloqueada') || errMsg.toLowerCase().includes('bloqueado')) {
      await showBlockedMessage(ctx);
      return;
    }

    if (errStatus === 503 || errMsg.toLowerCase().includes('manuten\u00e7\u00e3o') || errMsg.toLowerCase().includes('manutencao')) {
      await editOrReply(
        ctx,
        `\ud83d\udee0\ufe0f *Manuten\u00e7\u00e3o em Andamento*\n\n${escapeMd(errMsg)}\n\n_Tente novamente em alguns instantes!_ \ud83d\ude0a`,
        { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('\ud83c\udfe0 Menu Inicial', 'show_home')]]).reply_markup }
      );
      return;
    }

    if (errMsg.toLowerCase().includes('saldo insuficiente')) {
      await editOrReply(
        ctx,
        `\u274c *${escapeMd(errMsg)}*\n\nEscolha outra forma de pagamento ou adicione saldo.`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('\u2795 Adicionar Saldo', 'deposit_balance')],
            [Markup.button.callback('\u25c0\ufe0f Voltar', `select_product_${productId}`)],
          ]).reply_markup,
        }
      );
      return;
    }

    if (errMsg.toLowerCase().includes('processamento') || errMsg.toLowerCase().includes('aguarde') || errStatus === 429) {
      await editOrReply(
        ctx,
        `\u23f3 *Seu pagamento j\u00e1 est\u00e1 sendo processado!*\n\nAguarde um instante e verifique seus pedidos. \ud83d\ude0a`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
            [Markup.button.callback('\ud83c\udfe0 Menu Inicial', 'show_home')],
          ]).reply_markup,
        }
      );
      return;
    }

    const isTimeout = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('econnreset');
    await editOrReply(
      ctx,
      isTimeout
        ? `\u23f3 *Demorou um pouquinho mais que o esperado...*\n\nN\u00e3o se preocupe! Clique em *Tentar Novamente* abaixo \ud83d\ude0a`
        : `\u26a0\ufe0f *Algo deu errado ao gerar o PIX*\n\nSeu dinheiro n\u00e3o foi cobrado.\nClique em *Tentar Novamente*.`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('\ud83d\udd04 Tentar Novamente', `select_product_${productId}`)],
          [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_products')],
        ]).reply_markup,
      }
    );
  } finally {
    paymentInProgress.delete(userId);
  }
}

bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('\ud83d\udcb0 Processando com saldo...');
  await executePayment(ctx, ctx.match[1], 'BALANCE');
});

bot.action(/^pay_pix_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('\u23f3 Gerando PIX...');
  await executePayment(ctx, ctx.match[1], 'PIX');
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('\ud83d\udd00 Aplicando saldo + PIX...');
  await executePayment(ctx, ctx.match[1], 'MIXED');
});

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('\ud83d\udd0d Verificando pagamento...');
  const paymentId = ctx.match[1];

  try {
    const { status } = await apiClient.getPaymentStatus(paymentId);
    const statusMessages: Record<string, string> = {
      PENDING: '\u23f3 *Pagamento pendente*\n\nAinda n\u00e3o identificamos seu pagamento. Se j\u00e1 pagou, aguarde alguns segundos e verifique novamente.',
      APPROVED: '\u2705 *Pagamento aprovado!*\n\nSeu acesso est\u00e1 sendo liberado. Voc\u00ea receber\u00e1 uma mensagem em instantes.',
      REJECTED: '\u274c *Pagamento rejeitado*\n\nHouve um problema com seu pagamento. Por favor, tente novamente.',
      CANCELLED: '\u274c *Pagamento cancelado*\n\nEste pagamento foi cancelado.',
      EXPIRED: '\u231b *Pagamento expirado*\n\nO c\u00f3digo PIX expirou. Gere um novo pagamento.',
    };

    const msg = statusMessages[status] || '\u2753 Status desconhecido';
    await editOrReply(
      ctx,
      msg,
      status === 'PENDING'
        ? {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('\ud83d\udd04 Verificar Novamente', `check_payment_${paymentId}`)],
              [Markup.button.callback('\u274c Cancelar', `cancel_payment_${paymentId}`)],
            ]).reply_markup,
          }
        : {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('\ud83c\udfe0 Menu Inicial', 'show_home')],
              [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
            ]).reply_markup,
          }
    );
  } catch {
    await ctx.answerCbQuery('Erro ao verificar pagamento.', { show_alert: true });
  }
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const userId = ctx.from!.id;

  if (cancelInProgress.has(paymentId)) {
    await ctx.answerCbQuery('\u23f3 Cancelamento j\u00e1 em andamento...', { show_alert: false }).catch(() => {});
    return;
  }
  cancelInProgress.add(paymentId);

  await ctx.answerCbQuery('\u274c Cancelando...').catch(() => {});

  try {
    await apiClient.cancelPayment(paymentId);
    logger.info(`Pagamento ${paymentId} cancelado pelo usuario ${userId}`);
  } catch (error) {
    logger.warn(`Nao foi possivel cancelar pagamento ${paymentId}: ${error instanceof Error ? error.message : error}`);
  }

  const session = getSession(userId);

  await deletePhotoAndReply(
    ctx,
    session,
    '\u274c *Pagamento cancelado.*\n\nVolte quando quiser!',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('\ud83c\udfe0 Menu Inicial', 'show_home')],
      ]).reply_markup,
    }
  );

  const firstName = session.firstName;
  sessions.set(userId, { step: 'idle', firstName, lastActivityAt: Date.now() });

  cancelInProgress.delete(paymentId);
});

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.step === 'awaiting_deposit_amount') {
    const valor = parseFloat(text.replace(',', '.'));

    if (isNaN(valor) || valor < 1 || valor > 10000) {
      // FIX: usar replyWithMarkdown para que os backticks sejam renderizados como codigo
      await ctx.replyWithMarkdown(
        '\u274c Valor inv\u00e1lido\. Digite um valor entre R\$ 1,00 e R\$ 10\.000,00\.\n\nExemplo: `25` ou `50.00`'
      );
      return;
    }

    session.step = 'idle';
    const processingMsg = await ctx.replyWithMarkdown('\u23f3 Gerando PIX de dep\u00f3sito, aguarde...');

    try {
      const deposit = await apiClient.createDeposit(String(userId), valor, ctx.from?.first_name, ctx.from?.username);

      session.depositPaymentId = deposit.paymentId;

      await ctx.deleteMessage(processingMsg.message_id).catch(() => {});

      const expiresAt = new Date(deposit.expiresAt);
      const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });

      const qrBuffer = Buffer.from(deposit.pixQrCode, 'base64');
      const depositMsg = await ctx.replyWithPhoto(
        { source: qrBuffer },
        {
          caption:
            `\ud83d\udcb3 *Dep\u00f3sito de Saldo*\n` +
            `Valor: *R$ ${valor.toFixed(2)}*\n` +
            `V\u00e1lido at\u00e9: ${expiresStr}\n` +
            `\ud83e\udeaa ID: \`${deposit.paymentId}\`\n\n` +
            `\ud83d\udccb *Copia e Cola:*\n\`${deposit.pixQrCodeText}\`\n\n` +
            `Ap\u00f3s o pagamento, o saldo ser\u00e1 creditado automaticamente! \u2705`,
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('\ud83d\udd04 Verificar Pagamento', `check_payment_${deposit.paymentId}`)],
            [Markup.button.callback('\u274c Cancelar Dep\u00f3sito', `cancel_payment_${deposit.paymentId}`)],
          ]).reply_markup,
        }
      );

      session.depositMessageId = depositMsg.message_id;
      session.mainMessageId = depositMsg.message_id;

      logger.info(`[Deposit] PIX de deposito gerado para ${userId} | valor: ${valor} | id: ${deposit.paymentId}`);
    } catch (err) {
      await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
      logger.error(`Erro ao gerar deposito para ${userId}:`, err);

      const depositErrMsg = err instanceof Error ? err.message : '';
      const depositErrStatus = (err as { statusCode?: number }).statusCode ?? 0;

      if (depositErrStatus === 403 || depositErrMsg.toLowerCase().includes('suspensa')) {
        await showBlockedMessage(ctx);
        return;
      }

      if (depositErrStatus === 503 || depositErrMsg.toLowerCase().includes('manuten\u00e7\u00e3o')) {
        await ctx.replyWithMarkdown(
          `\ud83d\udee0\ufe0f *Manuten\u00e7\u00e3o em Andamento*\n\n${escapeMd(depositErrMsg)}\n\n_Tente novamente em alguns instantes!_ \ud83d\ude0a`
        );
        return;
      }

      await ctx.replyWithMarkdown(
        '\u274c Erro ao gerar PIX de dep\u00f3sito. Tente novamente.',
        Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_balance')]])
      );
    }
    return;
  }

  await ctx.replyWithMarkdown(
    `N\u00e3o entendi sua mensagem. Use os bot\u00f5es abaixo para navegar:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('\ud83d\udecd\ufe0f Ver Produtos', 'show_products')],
      [Markup.button.callback('\ud83d\udcb0 Meu Saldo', 'show_balance')],
      [Markup.button.callback('\ud83d\udce6 Meus Pedidos', 'show_orders')],
      [Markup.button.callback('\u2753 Ajuda', 'show_help')],
    ])
  );
});

async function showProducts(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  session.step = 'idle';

  try {
    const products = await apiClient.getProducts();
    session.products = products;

    if (products.length === 0) {
      await editOrReply(ctx, '\ud83d\ude14 Nenhum produto dispon\u00edvel no momento. Volte em breve!', {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')]]).reply_markup,
      });
      return;
    }

    const buttons = products.map((p) => {
      const stockLabel = p.stock !== null && p.stock !== undefined ? ` (${p.stock} restantes)` : '';
      const label = `${p.name}${stockLabel} \u2014 R$ ${Number(p.price).toFixed(2)}`;
      return [Markup.button.callback(label, `select_product_${p.id}`)];
    });

    buttons.push([Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')]);

    await editOrReply(ctx, `\ud83d\udecd\ufe0f *Nossos Produtos*\n\nEscolha um produto abaixo:`, {
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (error) {
    logger.error('Erro ao buscar produtos:', error);
    await editOrReply(ctx, '\u274c Erro ao buscar produtos. Tente novamente em instantes.', {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('\ud83d\udd04 Tentar Novamente', 'show_products')],
        [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
      ]).reply_markup,
    });
  }
}

async function showOrders(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const orders = await apiClient.getOrders(String(userId));

    if (!orders || orders.length === 0) {
      await editOrReply(
        ctx,
        `\ud83d\udce6 *Meus Pedidos*\n\n_Voc\u00ea ainda n\u00e3o fez nenhum pedido._\n\nCompre um produto e ele aparecer\u00e1 aqui!`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('\ud83d\udecd\ufe0f Ver Produtos', 'show_products')],
            [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
          ]).reply_markup,
        }
      );
      return;
    }

    const statusEmoji: Record<string, string> = {
      DELIVERED: '\u2705',
      PENDING: '\u23f3',
      FAILED: '\u274c',
      PROCESSING: '\ud83d\udd04',
    };

    const lines = orders.slice(0, 10).map((o: OrderSummary) => {
      const emoji = statusEmoji[o.status] ?? '\ud83d\udce6';
      const date = new Date(o.createdAt).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });
      const valor = o.amount !== null ? ` \u00b7 R$ ${Number(o.amount).toFixed(2)}` : '';
      const metodo =
        o.paymentMethod === 'BALANCE'
          ? ' \u00b7 \ud83d\udcb0Saldo'
          : o.paymentMethod === 'MIXED'
            ? ' \u00b7 \ud83d\udd00Misto'
            : o.paymentMethod === 'PIX'
              ? ' \u00b7 \ud83d\udcf1PIX'
              : '';
      return `${emoji} *${escapeMd(o.productName)}* \u2014 ${date}${valor}${metodo}`;
    });

    const total = orders.length;
    const hasMore = total > 10;

    await editOrReply(
      ctx,
      `\ud83d\udce6 *Meus Pedidos* (${total} no total)\n\n${lines.join('\n')}${hasMore ? `\n\n_...e mais ${total - 10} pedidos anteriores._` : ''}\n\n` +
        `_Para suporte sobre um pedido espec\u00edfico, entre em contato informando o nome do produto e a data._`,
      {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')]]).reply_markup,
      }
    );
  } catch (err) {
    logger.error(`Erro ao buscar pedidos para ${userId}:`, err);
    await editOrReply(ctx, '\u274c Erro ao buscar seus pedidos. Tente novamente.', {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('\ud83d\udd04 Tentar Novamente', 'show_orders')],
        [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
      ]).reply_markup,
    });
  }
}

async function showHelp(ctx: Context): Promise<void> {
  const supportUrl = `https://wa.me/${escapeHtml(env.SUPPORT_PHONE)}`;

  await editOrReplyHtml(
    ctx,
    `\u2753 <b>Central de Ajuda</b>\n\n` +
      `<b>Comandos dispon\u00edveis:</b>\n` +
      `/start \u2014 Tela inicial\n` +
      `/produtos \u2014 Ver produtos\n` +
      `/saldo \u2014 Ver e adicionar saldo\n` +
      `/meus_pedidos \u2014 Hist\u00f3rico de pedidos\n` +
      `/ajuda \u2014 Esta mensagem\n\n` +
      `<b>Como funciona?</b>\n` +
      `1. Escolha um produto\n` +
      `2. Escolha como pagar: saldo, PIX ou os dois\n` +
      `3. Receba seu acesso automaticamente \u2705\n\n` +
      `<b>Saldo pr\u00e9-pago:</b>\n` +
      `Fa\u00e7a um dep\u00f3sito uma vez e use para v\u00e1rias compras sem gerar PIX a cada vez.\n\n` +
      `<b>Modo Saldo + PIX:</b>\n` +
      `Seu saldo cobre parte do valor e voc\u00ea paga o restante via PIX!\n\n` +
      `<b>Problemas com pagamento?</b>\n` +
      `Entre em contato informando o ID do pagamento.`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('\ud83d\udcde Contatar Suporte', supportUrl)],
        [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
      ]).reply_markup,
    }
  );
}

bot.catch((err, ctx) => {
  logger.error(`Erro no bot para update ${ctx.update.update_id}:`, err);
});

async function startBot(): Promise<void> {
  if (env.NODE_ENV === 'production' && env.BOT_WEBHOOK_URL) {
    const PORT = parseInt(process.env.PORT ?? '8080', 10);
    const webhookPath = '/telegram-webhook';
    const webhookUrl = `${env.BOT_WEBHOOK_URL}${webhookPath}`;

    await bot.telegram.setWebhook(webhookUrl, {
      secret_token: env.TELEGRAM_BOT_SECRET,
    });
    logger.info(`\ud83e\udd16 Webhook registrado no Telegram: ${webhookUrl}`);

    const me = await bot.telegram.getMe();
    logger.info(`\ud83d\udccc Bot username: @${me.username}`);

    await registerCommands();

    const app = express();
    app.use(express.json());

    app.post(webhookPath, (req, res) => {
      const secretToken = req.headers['x-telegram-bot-api-secret-token'];
      if (env.TELEGRAM_BOT_SECRET && secretToken !== env.TELEGRAM_BOT_SECRET) {
        res.sendStatus(403);
        return;
      }

      res.sendStatus(200);

      const updateId: number | undefined = req.body?.update_id;
      if (updateId !== undefined) {
        if (processedUpdateIds.has(updateId)) {
          logger.warn(`[B15] update_id ${updateId} duplicado \u2014 ignorado`);
          return;
        }
        processedUpdateIds.add(updateId);
      }

      bot.handleUpdate(req.body).catch((err) => {
        logger.error('[webhook] Erro ao processar update:', err);
      });
    });

    app.get('/health', (_req, res) => res.json({ status: 'ok', bot: me.username }));

    app.post('/internal/cache/invalidate-products', (req, res) => {
      const secret = req.headers['x-bot-secret'];
      if (secret !== env.TELEGRAM_BOT_SECRET) {
        res.sendStatus(403);
        return;
      }
      invalidateProductCache();
      invalidateBotConfigCache();
      logger.info('[cache] Cache de produtos + bot-config invalidado via API admin');
      res.json({ ok: true });
    });

    app.listen(PORT, () => {
      logger.info(`\ud83d\ude80 Servidor webhook do bot escutando na porta ${PORT}`);
    });
  } else {
    await bot.launch();
    logger.info(`\ud83d\udccc Bot username: @${bot.botInfo?.username}`);
    logger.info('\ud83e\udd16 Bot iniciado em modo POLLING (desenvolvimento)');

    await registerCommands();
  }
}

startBot().catch((err) => {
  logger.error('Falha ao iniciar o bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
