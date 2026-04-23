// Bot do Telegram - Ponto de entrada principal
// Usa Telegraf com modo polling (dev) ou webhook (produção)

import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { env } from './config/env';
import { apiClient } from './services/apiClient';
import type { ProductDTO } from '@saas-pix/shared';

// ─── Logger simples para o bot ────────────────────────────────────────────
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

// ─── Estado em memória das sessões de usuário ─────────────────────────────
// Em produção, use Redis para estado persistente
interface UserSession {
  step: 'idle' | 'selecting_product' | 'awaiting_payment';
  selectedProductId?: string;
  paymentId?: string;
  products?: ProductDTO[];
}

const sessions = new Map<number, UserSession>();

function getSession(userId: number): UserSession {
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: 'idle' });
  }
  return sessions.get(userId)!;
}

// ─── Inicialização do bot ─────────────────────────────────────────────────
const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

// ─── Comando /start ───────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const firstName = ctx.from?.first_name || 'visitante';
  const userId = ctx.from!.id;

  // Reseta sessão do usuário
  sessions.set(userId, { step: 'idle' });

  const welcomeMessage =
    `👋 Olá, *${firstName}*! Bem-vindo!\n\n` +
    `🛒 Aqui você pode adquirir nossos produtos e planos de forma rápida e segura.\n\n` +
    `💳 Aceitamos pagamento via *PIX* (confirmação instantânea)\n\n` +
    `Para ver nossos produtos, clique no botão abaixo:`;

  await ctx.replyWithMarkdown(
    welcomeMessage,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
      [Markup.button.callback('❓ Ajuda', 'show_help')],
    ])
  );
});

// ─── Comando /produtos ────────────────────────────────────────────────────
bot.command('produtos', async (ctx) => {
  await showProducts(ctx);
});

// ─── Comando /ajuda ───────────────────────────────────────────────────────
bot.command('ajuda', async (ctx) => {
  await showHelp(ctx);
});

// ─── Comando /meus_pedidos ────────────────────────────────────────────────
bot.command('meus_pedidos', async (ctx) => {
  await ctx.replyWithMarkdown(
    `📋 *Meus Pedidos*\n\n` +
    `Para verificar seus pedidos ou relatar algum problema, entre em contato com nosso suporte.\n\n` +
    `Em caso de dúvidas sobre pagamentos, envie o *ID do pagamento* que recebeu.`
  );
});

// ─── Callback: mostrar produtos ───────────────────────────────────────────
bot.action('show_products', async (ctx) => {
  await ctx.answerCbQuery();
  await showProducts(ctx);
});

// ─── Callback: mostrar ajuda ──────────────────────────────────────────────
bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery();
  await showHelp(ctx);
});

// ─── Callback: selecionar produto ─────────────────────────────────────────
bot.action(/^select_product_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const productId = ctx.match[1];
  const userId = ctx.from!.id;
  const session = getSession(userId);

  // Busca produto da sessão ou da API
  let product: ProductDTO | undefined = session.products?.find((p) => p.id === productId);

  if (!product) {
    try {
      const products = await apiClient.getProducts();
      product = products.find((p) => p.id === productId);
      session.products = products;
    } catch {
      await ctx.replyWithMarkdown('❌ Erro ao buscar produto. Tente novamente.');
      return;
    }
  }

  if (!product) {
    await ctx.replyWithMarkdown('❌ Produto não encontrado.');
    return;
  }

  if (product.stock !== null && product.stock !== undefined && product.stock <= 0) {
    await ctx.replyWithMarkdown('⚠️ Este produto está esgotado no momento.');
    return;
  }

  session.selectedProductId = productId;
  session.step = 'selecting_product';

  const confirmMessage =
    `📦 *${product.name}*\n\n` +
    `📝 ${product.description}\n\n` +
    `💰 *Valor: R$ ${Number(product.price).toFixed(2)}*\n\n` +
    `Deseja prosseguir com o pagamento via PIX?`;

  await ctx.replyWithMarkdown(
    confirmMessage,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Gerar PIX', `confirm_payment_${productId}`)],
      [Markup.button.callback('◀️ Voltar', 'show_products')],
    ])
  );
});

// ─── Callback: confirmar e gerar PIX ──────────────────────────────────────
bot.action(/^confirm_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Gerando seu PIX...');
  const productId = ctx.match[1];
  const userId = ctx.from!.id;
  const session = getSession(userId);

  // Mensagem de carregamento
  const loadingMsg = await ctx.replyWithMarkdown('⏳ Gerando seu código PIX, aguarde...');

  try {
    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      firstName: ctx.from?.first_name,
      username: ctx.from?.username,
    });

    session.paymentId = payment.paymentId;
    session.step = 'awaiting_payment';

    // Remove mensagem de carregamento
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});

    // Formata data de expiração
    const expiresAt = new Date(payment.expiresAt);
    const expiresStr = expiresAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    // Envia resumo do pagamento
    await ctx.replyWithMarkdown(
      `💳 *Pagamento PIX Gerado!*\n\n` +
      `📦 *Produto:* ${payment.productName}\n` +
      `💰 *Valor:* R$ ${payment.amount.toFixed(2)}\n` +
      `⏰ *Válido até:* ${expiresStr}\n\n` +
      `_Escaneie o QR Code ou use o código copia e cola abaixo:_`
    );

    // Envia QR code como imagem
    const qrBuffer = Buffer.from(payment.pixQrCode, 'base64');
    await ctx.replyWithPhoto(
      { source: qrBuffer },
      { caption: '📷 Escaneie este QR Code no seu banco' }
    );

    // Envia código copia e cola em mensagem separada (fácil de copiar)
    await ctx.replyWithMarkdown(
      `📋 *Código PIX (Copia e Cola):*\n\n` +
      `\`${payment.pixQrCodeText}\`\n\n` +
      `⬆️ _Toque no código para copiar_\n\n` +
      `✅ Após o pagamento, você receberá uma confirmação automática aqui.\n\n` +
      `⏰ _Este código expira em 30 minutos._`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
        [Markup.button.callback('❌ Cancelar', 'cancel_payment')],
      ])
    );

    logger.info(`PIX gerado para usuário ${userId} | Pagamento: ${payment.paymentId}`);

  } catch (error) {
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
    const errMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    logger.error(`Erro ao gerar PIX para ${userId}:`, error);

    await ctx.replyWithMarkdown(
      `❌ *Erro ao gerar pagamento*\n\n${errMsg}\n\nTente novamente em alguns instantes.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', `confirm_payment_${productId}`)],
        [Markup.button.callback('◀️ Voltar', 'show_products')],
      ])
    );
  }
});

// ─── Callback: verificar status do pagamento ──────────────────────────────
bot.action(/^check_payment_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Verificando pagamento...');
  const paymentId = ctx.match[1];

  try {
    const { status } = await apiClient.getPaymentStatus(paymentId);

    const statusMessages: Record<string, string> = {
      PENDING: '⏳ *Pagamento pendente*\n\nAinda não identificamos seu pagamento. Se já pagou, aguarde alguns segundos e verifique novamente.',
      APPROVED: '✅ *Pagamento aprovado!*\n\nSeu acesso está sendo liberado. Você receberá uma mensagem em instantes.',
      REJECTED: '❌ *Pagamento rejeitado*\n\nHouve um problema com seu pagamento. Por favor, tente novamente.',
      CANCELLED: '❌ *Pagamento cancelado*\n\nEste pagamento foi cancelado.',
      EXPIRED: '⌛ *Pagamento expirado*\n\nO código PIX expirou. Gere um novo pagamento.',
    };

    const msg = statusMessages[status] || '❓ Status desconhecido';

    if (status === 'PENDING') {
      await ctx.replyWithMarkdown(
        msg,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Verificar Novamente', `check_payment_${paymentId}`)],
        ])
      );
    } else {
      await ctx.replyWithMarkdown(msg);
    }

  } catch {
    await ctx.replyWithMarkdown('❌ Erro ao verificar pagamento. Tente novamente.');
  }
});

// ─── Callback: cancelar pagamento ─────────────────────────────────────────
bot.action('cancel_payment', async (ctx) => {
  await ctx.answerCbQuery('Pagamento cancelado');
  const userId = ctx.from!.id;
  sessions.set(userId, { step: 'idle' });

  await ctx.replyWithMarkdown(
    '❌ Pagamento cancelado.\n\nVolte quando quiser!',
    Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
    ])
  );
});

// ─── Handler de mensagens de texto ────────────────────────────────────────
bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text;

  // Ignora comandos
  if (text.startsWith('/')) return;

  await ctx.replyWithMarkdown(
    `Não entendi sua mensagem. Use os botões abaixo para navegar:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Ver Produtos', 'show_products')],
      [Markup.button.callback('❓ Ajuda', 'show_help')],
    ])
  );
});

// ─── Funções auxiliares ───────────────────────────────────────────────────

async function showProducts(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = getSession(userId);

  try {
    await ctx.replyWithMarkdown('🔍 Buscando produtos disponíveis...');

    const products = await apiClient.getProducts();
    session.products = products;

    if (products.length === 0) {
      await ctx.replyWithMarkdown('😔 Nenhum produto disponível no momento. Volte em breve!');
      return;
    }

    const buttons = products.map((p) => {
      const stockLabel = p.stock !== null && p.stock !== undefined ? ` (${p.stock} restantes)` : '';
      const label = `${p.name}${stockLabel} — R$ ${Number(p.price).toFixed(2)}`;
      return [Markup.button.callback(label, `select_product_${p.id}`)];
    });

    await ctx.replyWithMarkdown(
      `🛍️ *Nossos Produtos*\n\nEscolha uma opção abaixo:`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (error) {
    logger.error('Erro ao buscar produtos:', error);
    await ctx.replyWithMarkdown(
      '❌ Erro ao buscar produtos. Tente novamente em instantes.',
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', 'show_products')],
      ])
    );
  }
}

async function showHelp(ctx: Context): Promise<void> {
  await ctx.replyWithMarkdown(
    `❓ *Central de Ajuda*\n\n` +
    `*Comandos disponíveis:*\n` +
    `• /start — Tela inicial\n` +
    `• /produtos — Ver produtos\n` +
    `• /ajuda — Esta mensagem\n\n` +
    `*Como funciona?*\n` +
    `1. Escolha um produto\n` +
    `2. Gere o código PIX\n` +
    `3. Pague pelo seu banco\n` +
    `4. Receba seu acesso automaticamente ✅\n\n` +
    `*Problemas com pagamento?*\n` +
    `Entre em contato com nosso suporte informando o ID do pagamento.`
  );
}

// ─── Tratamento de erros do bot ───────────────────────────────────────────
bot.catch((err, ctx) => {
  logger.error(`Erro no bot para update ${ctx.update.update_id}:`, err);
});

// ─── Inicialização ────────────────────────────────────────────────────────
async function startBot(): Promise<void> {
  if (env.NODE_ENV === 'production' && env.BOT_WEBHOOK_URL) {
    // Modo webhook para produção
    const webhookUrl = `${env.BOT_WEBHOOK_URL}/telegram-webhook`;
    await bot.launch({
      webhook: {
        domain: env.BOT_WEBHOOK_URL,
        port: env.BOT_WEBHOOK_PORT,
        path: '/telegram-webhook',
      },
    });
    logger.info(`🤖 Bot iniciado em modo WEBHOOK: ${webhookUrl}`);
  } else {
    // Modo polling para desenvolvimento
    await bot.launch();
    logger.info('🤖 Bot iniciado em modo POLLING (desenvolvimento)');
  }

  logger.info(`📌 Bot username: @${bot.botInfo?.username}`);
}

startBot().catch((err) => {
  logger.error('Falha ao iniciar o bot:', err);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
