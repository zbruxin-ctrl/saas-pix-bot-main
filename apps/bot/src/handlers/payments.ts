/**
 * Handlers de pagamento: seleção de produto, execução de pagamento (PIX/Saldo/Misto),
 * verificação de status, cancelamento e timeout de PIX.
 *
 * P2 FIX: timeout PIX usando Redis TTL — usuário recebe aviso ao expirar.
 * P3 FIX: /start durante pagamento preserva sessão (no index.ts).
 * SEC FIX #2: cancelPayment valida ownership do paymentId antes de cancelar.
 * SEC FIX #6: getPaymentStatus e cancelPayment passam telegramId para a API.
 * FIX #1: schedulePIXExpiry usa Redis TTL como fonte de verdade para detectar
 *         expiração resistente a restarts (verifica status na API ao invés de
 *         depender somente do setTimeout em memória).
 *         pixExpiresAt é salvo na sessão para re-agendamento no /start.
 * BUG FIX: answerCbQuery chamado ANTES de qualquer operação async para evitar
 *          timeout de 30s do Telegram que silencia o bot.
 */
import { Context, Markup } from 'telegraf';
import { Telegraf } from 'telegraf';
import { escapeMd } from '../utils/escape';
import { editOrReply, deletePhotoAndReply } from '../utils/helpers';
import { getSession, saveSession, clearSession } from '../services/session';
import { acquireLock, releaseLock } from '../services/locks';
import { apiClient } from '../services/apiClient';
import { captureError } from '../config/sentry';
import { showBlockedMessage } from './navigation';
import type { ProductDTO } from '@saas-pix/shared';

const PIX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

// Referência ao bot injetada em initPaymentHandlers
let _bot: Telegraf;

export function initPaymentHandlers(bot: Telegraf): void {
  _bot = bot;
}

// ─── Tela de seleção de método de pagamento ──────────────────────────────────

export async function showPaymentMethodScreen(
  ctx: Context,
  product: ProductDTO,
  preloadedBalance?: number
): Promise<void> {
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
    ? `\n📝 _${escapeMd(product.description)}_\n`
    : '';

  const confirmMessage =
    `📦 *${escapeMd(product.name)}*${descLine}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Valor:* R$ ${escapeMd(price.toFixed(2))}\n` +
    `🏦 *Seu saldo:* R$ ${escapeMd(balanceStr)}\n\n` +
    `*Como deseja pagar?*`;

  const buttons = [];

  if (balance >= price) {
    buttons.push([
      Markup.button.callback(`💰 Só Saldo  \(R$ ${price.toFixed(2)}\)`, `pay_balance_${product.id}`),
    ]);
  }

  buttons.push([
    Markup.button.callback(`📱 Só PIX  \(R$ ${price.toFixed(2)}\)`, `pay_pix_${product.id}`),
  ]);

  if (balance > 0 && balance < price) {
    const pixDiff = (price - balance).toFixed(2);
    buttons.push([
      Markup.button.callback(
        `🔀 Saldo \+ PIX  \(saldo R$ ${balanceStr} \+ PIX R$ ${pixDiff}\)`,
        `pay_mixed_${product.id}`
      ),
    ]);
  }

  buttons.push([Markup.button.callback('◀️ Voltar', 'show_products')]);

  await editOrReply(ctx, confirmMessage, {
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
  });
}

// ─── Execução de pagamento ───────────────────────────────────────────────────

export async function executePayment(
  ctx: Context,
  productId: string,
  paymentMethod: 'BALANCE' | 'PIX' | 'MIXED'
): Promise<void> {
  const userId = ctx.from!.id;
  const lockKey = `pay:${userId}`;

  // Responde o callback ANTES do lock para não atingir timeout do Telegram
  if ('callbackQuery' in ctx && ctx.callbackQuery) {
    await ctx.answerCbQuery('⏳ Processando...').catch(() => {});
  }

  const acquired = await acquireLock(lockKey, 60);
  if (!acquired) {
    console.warn(`[executePayment] Lock ativo para ${userId}`);
    return;
  }

  try {
    await editOrReply(ctx, '⏳ Processando sua compra, aguarde\.\.\.');

    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      firstName: ctx.from?.first_name,
      username: ctx.from?.username,
      paymentMethod,
    });

    const session = await getSession(userId);
    session.paymentId = payment.paymentId;
    session.step = 'awaiting_payment';
    // FIX #1: persiste a data de expiração no Redis para re-agendamento após restart
    session.pixExpiresAt = payment.expiresAt;
    await saveSession(userId, session);

    if (payment.paidWithBalance) {
      await editOrReply(
        ctx,
        `✅ *Compra realizada com saldo\!*\n\n` +
          `📦 *Produto:* ${escapeMd(payment.productName)}\n` +
          `💰 *Valor debitado:* R$ ${escapeMd(Number(payment.amount).toFixed(2))}\n\n` +
          `Seu produto será entregue em instantes\! 🚀`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
            [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
          ]).reply_markup,
        }
      );
      await clearSession(userId, session.firstName);
      return;
    }

    const expiresAt = new Date(payment.expiresAt);
    const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    const mixedLine = payment.isMixed
      ? `\n💳 *Saldo usado:* R$ ${escapeMd(Number(payment.balanceUsed).toFixed(2))}\n📱 *PIX a pagar:* R$ ${escapeMd(Number(payment.pixAmount).toFixed(2))}`
      : '';

    const qrBuffer = Buffer.from(payment.pixQrCode, 'base64');
    const caption =
      `💳 *Pagamento PIX Gerado\!*\n\n` +
      `📦 *Produto:* ${escapeMd(payment.productName)}\n` +
      `💰 *Valor total:* R$ ${escapeMd(Number(payment.amount).toFixed(2))}${mixedLine}\n` +
      `⏰ *Válido até:* ${escapeMd(expiresStr)}\n` +
      `🪪 *ID:* \`${escapeMd(payment.paymentId)}\`\n\n` +
      `📋 *Copia e Cola:*\n\`${escapeMd(payment.pixQrCodeText)}\``;

    const chatId = ctx.chat?.id;
    const updatedSession = await getSession(userId);
    if (chatId && updatedSession.mainMessageId) {
      await ctx.telegram.deleteMessage(chatId, updatedSession.mainMessageId).catch(() => {});
      updatedSession.mainMessageId = undefined;
    }

    const qrMsg = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption,
        parse_mode: 'MarkdownV2',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
          [Markup.button.callback('❌ Cancelar', `cancel_payment_${payment.paymentId}`)],
        ]).reply_markup,
      }
    );

    updatedSession.mainMessageId = qrMsg.message_id;
    await saveSession(userId, updatedSession);

    // FIX #1: setTimeout serve como melhor esforço em instância única.
    // A resistência a restart vem do Redis: ao receber /start, o bot re-agenda
    // o aviso para PIX em aberto que ainda não expiraram (ver index.ts).
    const effectiveChatId = chatId ?? userId;
    schedulePIXExpiry(userId, payment.paymentId, effectiveChatId, PIX_TIMEOUT_MS);

    console.info(`[${paymentMethod}] PIX gerado para ${userId} | id: ${payment.paymentId} | expira: ${payment.expiresAt}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Erro desconhecido';
    const errStatus = (error as { statusCode?: number }).statusCode ?? 0;
    console.error(`[executePayment] Erro (${paymentMethod}) para ${userId}:`, error);
    captureError(error, { handler: 'executePayment', paymentMethod, userId, productId });

    if (errStatus === 403 || errMsg.toLowerCase().includes('suspensa')) {
      await showBlockedMessage(ctx);
      return;
    }

    if (errStatus === 503 || errMsg.toLowerCase().includes('manutencao') || errMsg.toLowerCase().includes('manutenção')) {
      await editOrReply(
        ctx,
        `🛠️ *Manutenção em Andamento*\n\n${escapeMd(errMsg)}\n\n_Tente novamente em alguns instantes\!_ 😊`,
        { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup }
      );
      return;
    }

    if (errMsg.toLowerCase().includes('saldo insuficiente')) {
      await editOrReply(
        ctx,
        `❌ *${escapeMd(errMsg)}*\n\nEscolha outra forma de pagamento ou adicione saldo\.`,
        {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('➕ Adicionar Saldo', 'deposit_balance')],
            [Markup.button.callback('◀️ Voltar', `select_product_${productId}`)],
          ]).reply_markup,
        }
      );
      return;
    }

    const isTimeout = errMsg.toLowerCase().includes('timeout') || errMsg.toLowerCase().includes('econnreset');
    await editOrReply(
      ctx,
      isTimeout
        ? `⏳ *Demorou um pouquinho mais que o esperado\.\.\.*\n\nClique em *Tentar Novamente* abaixo 😊`
        : `⚠️ *Algo deu errado ao gerar o PIX*\n\nSeu dinheiro não foi cobrado\.\nClique em *Tentar Novamente*\.`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Tentar Novamente', `select_product_${productId}`)],
          [Markup.button.callback('◀️ Voltar', 'show_products')],
        ]).reply_markup,
      }
    );
  } finally {
    await releaseLock(lockKey);
  }
}

// ─── Timeout de PIX ──────────────────────────────────────────────────────────

/**
 * FIX #1: schedulePIXExpiry recebe delayMs como parâmetro para permitir
 * re-agendamento com tempo restante calculado a partir do Redis (pixExpiresAt).
 */
export function schedulePIXExpiry(
  userId: number,
  paymentId: string,
  chatId: number,
  delayMs: number
): void {
  setTimeout(async () => {
    try {
      const session = await getSession(userId);
      if (session.step !== 'awaiting_payment' || session.paymentId !== paymentId) return;

      // Consulta status real na API antes de avisar (evita falso alarme pós-restart)
      try {
        const { status } = await apiClient.getPaymentStatus(paymentId, String(userId));
        if (status === 'APPROVED' || status === 'CANCELLED') {
          await clearSession(userId, session.firstName);
          return;
        }
      } catch {
        // API inacessível — avisa mesmo assim para não deixar o usuário esperando
      }

      await _bot.telegram
        .sendMessage(
          chatId,
          '⌛ Seu PIX expirou\. Use /start para gerar um novo\.',
          { parse_mode: 'MarkdownV2' }
        )
        .catch(() => {});
      await clearSession(userId, session.firstName);
    } catch (err) {
      console.warn(`[schedulePIXExpiry] Erro ao expirar PIX ${paymentId}:`, err);
    }
  }, delayMs);
}

// ─── Verificar pagamento ─────────────────────────────────────────────────────

export async function handleCheckPayment(ctx: Context, paymentId: string): Promise<void> {
  const userId = ctx.from!.id;

  // CRÍTICO: responde o cbQuery IMEDIATAMENTE antes de qualquer operação async.
  // Se demorar mais de 30s sem resposta, o Telegram marca o bot como "não responsivo"
  // e para de entregar updates para aquele usuário.
  await ctx.answerCbQuery('🔄 Verificando...').catch(() => {});

  try {
    // SEC FIX #6: passa telegramId para validação de ownership na API
    const { status } = await apiClient.getPaymentStatus(paymentId, String(userId));

    if (status === 'EXPIRED' || status === 'CANCELLED' || status === 'APPROVED') {
      await clearSession(userId);
    }

    const statusMessages: Record<string, string> = {
      PENDING:
        '⏳ *Pagamento pendente*\n\nAinda não identificamos seu pagamento\. Se já pagou, aguarde alguns segundos e verifique novamente\.',
      APPROVED:
        '✅ *Pagamento aprovado\!*\n\nSeu acesso está sendo liberado\. Você receberá uma mensagem em instantes\.',
      REJECTED:
        '❌ *Pagamento rejeitado*\n\nHouve um problema com seu pagamento\. Por favor, tente novamente\.',
      CANCELLED: '❌ *Pagamento cancelado*\n\nEste pagamento foi cancelado\.',
      EXPIRED: '⌛ *Pagamento expirado*\n\nO código PIX expirou\. Gere um novo pagamento\.',
    };

    const msg = statusMessages[status] || '❓ Status desconhecido';
    await editOrReply(
      ctx,
      msg,
      status === 'PENDING'
        ? {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Verificar Novamente', `check_payment_${paymentId}`)],
              [Markup.button.callback('❌ Cancelar', `cancel_payment_${paymentId}`)],
            ]).reply_markup,
          }
        : {
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
              [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
            ]).reply_markup,
          }
    );
  } catch (err) {
    console.error('[handleCheckPayment] Erro ao verificar pagamento:', err);
    // Envia mensagem de erro em vez de silenciar
    await ctx.reply('⚠️ Erro ao verificar pagamento\. Tente novamente\.', {
      parse_mode: 'MarkdownV2',
    }).catch(() => {});
  }
}

// ─── Cancelar pagamento ──────────────────────────────────────────────────────

export async function handleCancelPayment(ctx: Context, paymentId: string): Promise<void> {
  const userId = ctx.from!.id;

  // CRÍTICO: responde o cbQuery IMEDIATAMENTE antes de qualquer operação async
  await ctx.answerCbQuery('❌ Cancelando...').catch(() => {});

  // SEC FIX #2: Verifica ownership — só o dono do pagamento pode cancelar
  const session = await getSession(userId);
  if (session.paymentId !== paymentId) {
    console.warn(`[cancelPayment] userId ${userId} tentou cancelar paymentId ${paymentId} que não é dele (sessão: ${session.paymentId})`);
    await ctx.reply('⚠️ Ação não autorizada\.', { parse_mode: 'MarkdownV2' }).catch(() => {});
    return;
  }

  const lockKey = `cancel:${paymentId}`;
  const acquired = await acquireLock(lockKey, 15);
  if (!acquired) {
    await ctx.reply('⏳ Cancelamento já em andamento\.', { parse_mode: 'MarkdownV2' }).catch(() => {});
    return;
  }

  try {
    // SEC FIX #6: passa telegramId para que a API valide ownership também
    await apiClient.cancelPayment(paymentId, String(userId));
  } catch (error) {
    console.warn(`[cancelPayment] Não foi possível cancelar ${paymentId}:`, error);
  }

  try {
    await deletePhotoAndReply(ctx, session, userId, '❌ *Pagamento cancelado\.* \n\nVolte quando quiser\!', {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
    });
    await clearSession(userId, session.firstName);
  } catch (err) {
    console.error('[handleCancelPayment] Erro ao finalizar cancelamento:', err);
    await ctx.reply('❌ *Pagamento cancelado\.* Volte quando quiser\!', {
      parse_mode: 'MarkdownV2',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
    }).catch(() => {});
    await clearSession(userId, session.firstName).catch(() => {});
  } finally {
    await releaseLock(lockKey);
  }
}
