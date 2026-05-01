// Bot do Telegram - Ponto de entrada principal
// FEATURE 1: edit-in-place (editOrReply)
// FEATURE 2: sistema de saldo
// FEATURE 3: animação de loading nos botões
// FEATURE 4: escolha de método de pagamento
// PERF #3: Promise.all para buscar produto + saldo em paralelo
// PERF #7: limpeza de sessões idle a cada 30min
// FEATURE 5: /meus_pedidos com histórico real
// FIX WEBHOOK: bot sobe servidor Express próprio na porta 8080
// FIX TS7016: usa fetch nativo do Node 20
// FIX #1 a #15: vários fixes anteriores
// FIX B13: paymentInProgress Set em executePayment
// FIX B14: res.sendStatus(200) ANTES do await bot.handleUpdate
// FIX B15: dedup por update_id no webhook
// FEAT-MAINT: middleware global de manutenção — consulta /bot-config (TTL 10s)
//   Quando maintenance_mode=true, QUALQUER interação (comando ou callback) recebe
//   a mensagem de manutenção configurada no painel admin. O usuário não consegue
//   navegar nem comprar. Apenas /start exibe a mensagem (sem menu).
// FEAT-BLOCKED: quando a API retorna 403 (usuário bloqueado), o bot exibe
//   mensagem amigável explicando que a conta está suspensa.
// FEAT-DESC: tela de produto exibe descrição rica (igual à de boas-vindas do /start)
//   Descrição do produto é exibida em destaque + ícone, linha separadora visual.
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
  if (removed > 0) {
    logger.info(`[cleanup] ${removed} sessão(ões) idle removida(s). Total ativo: ${sessions.size}`);
  }
}

setInterval(cleanupSessions, SESSION_CLEANUP_INTERVAL_MS);

// FIX B15: dedup de update_id
const processedUpdateIds = new Set<number>();
const UPDATE_DEDUP_CLEANUP_MS = 5 * 60_000;
setInterval(() => {
  if (processedUpdateIds.size > 0) {
    processedUpdateIds.clear();
    logger.info('[dedup] Cache de update_ids limpo');
  }
}, UPDATE_DEDUP_CLEANUP_MS);

const paymentInProgress = new Set<number>();

const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

async function registerCommands(): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 Menu inicial' },
    { command: 'produtos', description: '🛍️ Ver produtos disponíveis' },
    { command: 'saldo', description: '💰 Ver meu saldo e adicionar' },
    { command: 'meus_pedidos', description: '📦 Histórico de pedidos' },
    { command: 'ajuda', description: '❓ Central de ajuda e suporte' },
  ]);
  logger.info('✅ Menu de comandos registrado no Telegram');
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
        logger.warn(`[editOrReply] Erro inesperado ao editar: ${msg}`);
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
        logger.warn(`[editOrReplyHtml] Erro inesperado ao editar: ${msg}`);
      }
    }
  }

  const sent = await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...(extra as object) });
  session.mainMessageId = sent.message_id;
}

// ─── FEAT-MAINT: helper de verificação de manutenção ─────────────────────────
// Retorna null se não está em manutenção, ou a mensagem configurada se estiver.
async function getMaintenanceMessage(): Promise<string | null> {
  try {
    const config = await apiClient.getBotConfig();
    if (config.maintenanceMode) {
      return config.maintenanceMessage || 'Estamos em manutenção. Voltamos em breve! 🛠️';
    }
  } catch {
    // Se não conseguir checar, não bloqueia
  }
  return null;
}

// ─── FEAT-MAINT: middleware global ────────────────────────────────────────────
// Intercepta QUALQUER update (mensagem, callback, comando) e bloqueia
// quando modo manutenção está ativo. Exibe mensagem configurada no admin.
bot.use(async (ctx, next) => {
  const maintMsg = await getMaintenanceMessage();
  if (maintMsg) {
    const userId = ctx.from?.id;
    if (userId) {
      const session = getSession(userId);
      const firstName = escapeMd(session.firstName || ctx.from?.first_name || 'visitante');
      const text =
        `🛠️ *Manutenção em Andamento*\n\n` +
        `Olá, *${firstName}*!\n\n` +
        `${escapeMd(maintMsg)}\n\n` +
        `_Pedimos desculpas pelo inconveniente. Em breve estaremos de volta!_ 😊`;

      if ('callbackQuery' in ctx && ctx.callbackQuery) {
        await ctx.answerCbQuery('🛠️ Bot em manutenção', { show_alert: true }).catch(() => {});
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
        if (sent && userId) getSession(userId).mainMessageId = sent.message_id;
      }
    }
    return; // não chama next() — bloqueia completamente
  }
  return next();
});

async function showHome(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const firstName = escapeMd(session.firstName || ctx.from?.first_name || 'visitante');

  await editOrReply(
    ctx,
    `👋 Olá, *${firstName}*! Bem-vindo!\n\n` +
      `🛒 Aqui você pode adquirir nossos produtos e planos de forma rápida e segura.\n\n` +
      `💳 Aceitamos pagamento via *PIX* (confirmação instantânea) ou via *saldo* pré-carregado.\n\n` +
      `Para ver nossos produtos, clique no botão abaixo:`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
        [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
        [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('❓ Ajuda', 'show_help')],
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
    `👋 Olá, *${firstName}*! Bem-vindo!\n\n` +
      `🛒 Aqui você pode adquirir nossos produtos e planos de forma rápida e segura.\n\n` +
      `💳 Aceitamos pagamento via *PIX* (confirmação instantânea) ou via *saldo* pré-carregado.\n\n` +
      `Para ver nossos produtos, clique no botão abaixo:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
      [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
      [Markup.button.callback('❓ Ajuda', 'show_help')],
    ])
  );

  getSession(userId).mainMessageId = sent.message_id;
});

bot.command('produtos', async (ctx) => {
  await showProducts(ctx);
});
bot.command('saldo', async (ctx) => {
  await showBalance(ctx);
});
bot.command('ajuda', async (ctx) => {
  await showHelp(ctx);
});
bot.command('meus_pedidos', async (ctx) => {
  await showOrders(ctx);
});

bot.action('show_home', async (ctx) => {
  await ctx.answerCbQuery();
  await showHome(ctx);
});

bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produtos...');
  await showProducts(ctx);
});

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery();
  await showHelp(ctx);
});

bot.action('show_orders', async (ctx) => {
  await ctx.answerCbQuery('📦 Carregando pedidos...');
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
      `💰 *Seu Saldo*\n\n` +
      `Disponível: *R$ ${Number(balance).toFixed(2)}*\n\n` +
      (txLines ? `*Últimas transações:*\n${txLines}\n\n` : '_Nenhuma transação ainda._\n\n') +
      `Use seu saldo para comprar sem precisar fazer PIX toda hora!`;

    await editOrReply(ctx, texto, {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('\u2795 Adicionar Saldo', 'deposit_balance')],
        [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
      ]).reply_markup,
    });
  } catch (err) {
    logger.error(`Erro ao buscar saldo para ${userId}:`, err);
    await editOrReply(ctx, '❌ Erro ao buscar saldo. Tente novamente.', {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')]]).reply_markup,
    });
  }
}

bot.action('show_balance', async (ctx) => {
  await ctx.answerCbQuery('⏳ Buscando saldo...');
  await showBalance(ctx);
});

bot.action('deposit_balance', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from!.id);
  session.step = 'awaiting_deposit_amount';
  await ctx.replyWithMarkdown(
    `💳 *Adicionar Saldo*\n\n` +
      `Digite o valor em reais que deseja depositar:\n` +
      `_(mínimo R$ 1,00 | máximo R$ 10.000,00)_\n\n` +
      `Exemplo: \`25\` ou \`50.00\``
  );
});

bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Carregando produto...');
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
    await editOrReply(ctx, '\u274c Produto não encontrado.');
    return;
  }

  if (product.stock !== null && product.stock !== undefined && product.stock <= 0) {
    await editOrReply(ctx, '\u26a0\ufe0f Este produto está esgotado no momento.');
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

  // FEAT-DESC: descrição rica do produto com linha visual separadora
  const descLine = product.description
    ? `\n📝 _${escapeMd(product.description)}_\n`
    : '';

  const confirmMessage =
    `📦 *${escapeMd(product.name)}*` +
    descLine +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Valor:* R$ ${price.toFixed(2)}\n` +
    `🏦 *Seu saldo:* R$ ${balanceStr}\n\n` +
    `*Como deseja pagar?*`;

  const buttons = [];

  if (balance >= price) {
    buttons.push([Markup.button.callback(`💰 Só Saldo  (R$ ${price.toFixed(2)})`, `pay_balance_${product.id}`)]);
  }

  buttons.push([Markup.button.callback(`📱 Só PIX  (R$ ${price.toFixed(2)})`, `pay_pix_${product.id}`)]);

  if (balance > 0 && balance < price) {
    const pixDiff = (price - balance).toFixed(2);
    buttons.push([Markup.button.callback(`🔀 Saldo + PIX  (saldo R$ ${balanceStr} + PIX R$ ${pixDiff})`, `pay_mixed_${product.id}`)]);
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
    logger.warn(`[B13] Pagamento já em andamento para ${userId} (${paymentMethod}) — request duplicado ignorado`);
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
          `📦 *Produto:* ${escapeMd(payment.productName)}\n` +
          `💰 *Valor debitado:* R$ ${Number(payment.amount).toFixed(2)}\n\n` +
          `Seu produto será entregue em instantes! 🚀`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
            [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
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
      ? `\n💳 *Saldo usado:* R$ ${Number(payment.balanceUsed).toFixed(2)}\n📱 *PIX a pagar:* R$ ${Number(payment.pixAmount).toFixed(2)}`
      : '';

    const qrBuffer = Buffer.from(payment.pixQrCode, 'base64');
    const caption =
      `💳 *Pagamento PIX Gerado!*\n\n` +
      `📦 *Produto:* ${escapeMd(payment.productName)}\n` +
      `💰 *Valor total:* R$ ${Number(payment.amount).toFixed(2)}${mixedLine}\n` +
      `\u23f0 *Válido até:* ${expiresStr}\n` +
      `🪪 *ID:* \`${payment.paymentId}\`\n\n` +
      `📋 *Copia e Cola:*\n\`${payment.pixQrCodeText}\``;

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
          [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
          [Markup.button.callback('\u274c Cancelar', `cancel_payment_${payment.paymentId}`)],
        ]).reply_markup,
      }
    );

    session.mainMessageId = qrMsg.message_id;
    logger.info(`[${paymentMethod}] PIX gerado para usuário ${userId} | Pagamento: ${payment.paymentId}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    const errStatus = (error as { statusCode?: number }).statusCode ?? 0;
    logger.error(`Erro ao processar pagamento (${paymentMethod}) para ${userId}:`, error);

    // FEAT-BLOCKED: usuário bloqueado — 403 retornado pela API
    if (errStatus === 403 || errMsg.toLowerCase().includes('suspensa') || errMsg.toLowerCase().includes('bloqueada') || errMsg.toLowerCase().includes('bloqueado')) {
      await editOrReply(
        ctx,
        `🚫 *Conta Suspensa*\n\n` +
          `Sua conta foi suspensa e não é possível realizar compras no momento.\n\n` +
          `Se acredita que isso é um erro, entre em contato com o suporte.`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.url('📞 Falar com Suporte', `https://wa.me/${env.SUPPORT_PHONE}`)],
            [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
          ]).reply_markup,
        }
      );
      return;
    }

    // FEAT-MAINT: manutenção retornada pela API (503) mesmo sem o middleware ter interceptado
    if (errStatus === 503 || errMsg.toLowerCase().includes('manutenção') || errMsg.toLowerCase().includes('manutencao')) {
      await editOrReply(
        ctx,
        `🛠️ *Manutenção em Andamento*\n\n${escapeMd(errMsg)}\n\n_Tente novamente em alguns instantes!_ 😊`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
          ]).reply_markup,
        }
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

    if (
      errMsg.toLowerCase().includes('processamento') ||
      errMsg.toLowerCase().includes('aguarde') ||
      errStatus === 429
    ) {
      await editOrReply(
        ctx,
        `\u23f3 *Seu pagamento já está sendo processado!*\n\nAguarde um instante e verifique seus pedidos. 😊`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
            [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
          ]).reply_markup,
        }
      );
      return;
    }

    const isTimeout = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('econnreset');
    await editOrReply(
      ctx,
      isTimeout
        ? `\u23f3 *Demorou um pouquinho mais que o esperado...*\n\nNão se preocupe! Clique em *Tentar Novamente* abaixo 😊`
        : `\u26a0\ufe0f *Algo deu errado ao gerar o PIX*\n\nSeu dinheiro não foi cobrado.\nClique em *Tentar Novamente*.`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Tentar Novamente', `select_product_${productId}`)],
          [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_products')],
        ]).reply_markup,
      }
    );
  } finally {
    paymentInProgress.delete(userId);
  }
}

bot.action(/^pay_balance_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('💰 Processando com saldo...');
  await executePayment(ctx, ctx.match[1], 'BALANCE');
});

bot.action(/^pay_pix_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⏳ Gerando PIX...');
  await executePayment(ctx, ctx.match[1], 'PIX');
});

bot.action(/^pay_mixed_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🔀 Aplicando saldo + PIX...');
  await executePayment(ctx, ctx.match[1], 'MIXED');
});

bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('🔍 Verificando pagamento...');
  const paymentId = ctx.match[1];

  try {
    const { status } = await apiClient.getPaymentStatus(paymentId);
    const statusMessages: Record<string, string> = {
      PENDING: '\u23f3 *Pagamento pendente*\n\nAinda não identificamos seu pagamento. Se já pagou, aguarde alguns segundos e verifique novamente.',
      APPROVED: '\u2705 *Pagamento aprovado!*\n\nSeu acesso está sendo liberado. Você receberá uma mensagem em instantes.',
      REJECTED: '\u274c *Pagamento rejeitado*\n\nHouve um problema com seu pagamento. Por favor, tente novamente.',
      CANCELLED: '\u274c *Pagamento cancelado*\n\nEste pagamento foi cancelado.',
      EXPIRED: '\u231b *Pagamento expirado*\n\nO código PIX expirou. Gere um novo pagamento.',
    };

    const msg = statusMessages[status] || '\u2753 Status desconhecido';
    await editOrReply(
      ctx,
      msg,
      status === 'PENDING'
        ? {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Verificar Novamente', `check_payment_${paymentId}`)],
              [Markup.button.callback('\u274c Cancelar', `cancel_payment_${paymentId}`)],
            ]).reply_markup,
          }
        : {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
              [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
            ]).reply_markup,
          }
    );
  } catch {
    await ctx.answerCbQuery('Erro ao verificar pagamento.', { show_alert: true });
  }
});

bot.action(/^cancel_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('❌ Cancelando...');
  const paymentId = ctx.match[1];
  const userId = ctx.from!.id;

  try {
    await apiClient.cancelPayment(paymentId);
    logger.info(`Pagamento ${paymentId} cancelado pelo usuário ${userId}`);
  } catch (error) {
    logger.warn(`Não foi possível cancelar pagamento ${paymentId}: ${error instanceof Error ? error.message : error}`);
  }

  sessions.set(userId, { step: 'idle', lastActivityAt: Date.now() });
  await editOrReply(ctx, '\u274c *Pagamento cancelado.*\n\nVolte quando quiser!', {
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
  });
});

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (session.step === 'awaiting_deposit_amount') {
    const valor = parseFloat(text.replace(',', '.'));

    if (isNaN(valor) || valor < 1 || valor > 10000) {
      await ctx.reply('\u274c Valor inválido. Digite um valor entre R$ 1,00 e R$ 10.000,00.\n\nExemplo: `25` ou `50.00`');
      return;
    }

    session.step = 'idle';
    const processingMsg = await ctx.replyWithMarkdown('\u23f3 Gerando PIX de depósito, aguarde...');

    try {
      const deposit = await apiClient.createDeposit(String(userId), valor, ctx.from?.first_name, ctx.from?.username);

      await ctx.deleteMessage(processingMsg.message_id).catch(() => {});

      const expiresAt = new Date(deposit.expiresAt);
      const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });

      const qrBuffer = Buffer.from(deposit.pixQrCode, 'base64');
      await ctx.replyWithPhoto(
        { source: qrBuffer },
        {
          caption:
            `💳 *Depósito de Saldo*\n` +
            `Valor: *R$ ${valor.toFixed(2)}*\n` +
            `Válido até: ${expiresStr}\n` +
            `🪪 ID: \`${deposit.paymentId}\`\n\n` +
            `📋 *Copia e Cola:*\n\`${deposit.pixQrCodeText}\`\n\n` +
            `Após o pagamento, o saldo será creditado automaticamente! \u2705`,
          parse_mode: 'Markdown',
        }
      );

      logger.info(`[Deposit] PIX de depósito gerado para ${userId} | valor: ${valor}`);
    } catch (err) {
      await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
      logger.error(`Erro ao gerar depósito para ${userId}:`, err);

      // FEAT-MAINT: bloqueia depósito também durante manutenção
      const depositErrMsg = err instanceof Error ? err.message : '';
      const depositErrStatus = (err as { statusCode?: number }).statusCode ?? 0;
      if (depositErrStatus === 503 || depositErrMsg.toLowerCase().includes('manutenção')) {
        await ctx.replyWithMarkdown(
          `🛠️ *Manutenção em Andamento*\n\n${escapeMd(depositErrMsg)}\n\n_Tente novamente em alguns instantes!_ 😊`
        );
        return;
      }

      await ctx.replyWithMarkdown(
        '\u274c Erro ao gerar PIX de depósito. Tente novamente.',
        Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_balance')]])
      );
    }
    return;
  }

  await ctx.replyWithMarkdown(
    `Não entendi sua mensagem. Use os botões abaixo para navegar:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
      [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
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
      await editOrReply(ctx, '😔 Nenhum produto disponível no momento. Volte em breve!', {
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

    await editOrReply(ctx, `🛍️ *Nossos Produtos*\n\nEscolha um produto abaixo:`, {
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (error) {
    logger.error('Erro ao buscar produtos:', error);
    await editOrReply(ctx, '\u274c Erro ao buscar produtos. Tente novamente em instantes.', {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', 'show_products')],
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
        `📦 *Meus Pedidos*\n\n_Você ainda não fez nenhum pedido._\n\nCompre um produto e ele aparecerá aqui!`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
            [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
          ]).reply_markup,
        }
      );
      return;
    }

    const statusEmoji: Record<string, string> = {
      DELIVERED: '✅',
      PENDING: '⏳',
      FAILED: '❌',
      PROCESSING: '🔄',
    };

    const lines = orders.slice(0, 10).map((o: OrderSummary) => {
      const emoji = statusEmoji[o.status] ?? '📦';
      const date = new Date(o.createdAt).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });
      const valor = o.amount !== null ? ` · R$ ${Number(o.amount).toFixed(2)}` : '';
      const metodo =
        o.paymentMethod === 'BALANCE'
          ? ' · 💰Saldo'
          : o.paymentMethod === 'MIXED'
            ? ' · 🔀Misto'
            : o.paymentMethod === 'PIX'
              ? ' · 📱PIX'
              : '';
      return `${emoji} *${escapeMd(o.productName)}* — ${date}${valor}${metodo}`;
    });

    const total = orders.length;
    const hasMore = total > 10;

    await editOrReply(
      ctx,
      `📦 *Meus Pedidos* (${total} no total)\n\n${lines.join('\n')}${hasMore ? `\n\n_...e mais ${total - 10} pedidos anteriores._` : ''}\n\n` +
        `_Para suporte sobre um pedido específico, entre em contato informando o nome do produto e a data._`,
      {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')]]).reply_markup,
      }
    );
  } catch (err) {
    logger.error(`Erro ao buscar pedidos para ${userId}:`, err);
    await editOrReply(ctx, '\u274c Erro ao buscar seus pedidos. Tente novamente.', {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', 'show_orders')],
        [Markup.button.callback('\u25c0\ufe0f Voltar', 'show_home')],
      ]).reply_markup,
    });
  }
}

async function showHelp(ctx: Context): Promise<void> {
  const supportUrl = `https://wa.me/${escapeHtml(env.SUPPORT_PHONE)}`;

  await editOrReplyHtml(
    ctx,
    `❓ <b>Central de Ajuda</b>\n\n` +
      `<b>Comandos disponíveis:</b>\n` +
      `/start — Tela inicial\n` +
      `/produtos — Ver produtos\n` +
      `/saldo — Ver e adicionar saldo\n` +
      `/meus_pedidos — Histórico de pedidos\n` +
      `/ajuda — Esta mensagem\n\n` +
      `<b>Como funciona?</b>\n` +
      `1. Escolha um produto\n` +
      `2. Escolha como pagar: saldo, PIX ou os dois\n` +
      `3. Receba seu acesso automaticamente ✅\n\n` +
      `<b>Saldo pré-pago:</b>\n` +
      `Faça um depósito uma vez e use para várias compras sem gerar PIX a cada vez.\n\n` +
      `<b>Modo Saldo + PIX:</b>\n` +
      `Seu saldo cobre parte do valor e você paga o restante via PIX!\n\n` +
      `<b>Problemas com pagamento?</b>\n` +
      `Entre em contato informando o ID do pagamento.`,
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('📞 Contatar Suporte', supportUrl)],
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
    logger.info(`🤖 Webhook registrado no Telegram: ${webhookUrl}`);

    const me = await bot.telegram.getMe();
    logger.info(`📌 Bot username: @${me.username}`);

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
          logger.warn(`[B15] update_id ${updateId} duplicado — ignorado`);
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
      // Invalida também o config cache para que a mudança de manutenção
      // seja refletida imediatamente sem esperar o TTL de 10s
      invalidateBotConfigCache();
      logger.info('[cache] Cache de produtos + bot-config invalidado via API admin');
      res.json({ ok: true });
    });

    app.listen(PORT, () => {
      logger.info(`🚀 Servidor webhook do bot escutando na porta ${PORT}`);
    });
  } else {
    await bot.launch();
    logger.info(`📌 Bot username: @${bot.botInfo?.username}`);
    logger.info('🤖 Bot iniciado em modo POLLING (desenvolvimento)');

    await registerCommands();
  }
}

startBot().catch((err) => {
  logger.error('Falha ao iniciar o bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
