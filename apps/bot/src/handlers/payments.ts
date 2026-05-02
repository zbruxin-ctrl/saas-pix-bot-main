/**
 * Handlers de pagamento: seleção de produto, execução de pagamento (PIX/Saldo/Misto),
 * verificação de status, cancelamento e timeout de PIX.
 *
 * PADRÃO: parse_mode HTML em mensagens de texto.
 *         parse_mode MarkdownV2 APENAS em captions de replyWithPhoto.
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
 * FEAT-PRICING: tela de cupom/referral antes de gerar PIX; exibe desconto no resumo.
 * FIX-TS2352: double cast via unknown para acessar campos opcionais de CreatePaymentResponse
 * FIX-COUPON-DISCOUNT: aplica pendingCouponDiscount ao preço exibido na tela de método;
 *                      oculta botão de cupom quando já existe cupom aplicado.
 * FIX-MDV2: escapa '!' e demais caracteres reservados do MarkdownV2 na caption do PIX.
 * FEAT-REMOVE-COUPON: botão 🗑️ Remover cupom na tela de método de pagamento.
 * FEAT-COPYPASTE-CHECK: salva pixQrCodeText na sessão e reenvia copia e cola
 *                       quando usuário clica em Verificar Pagamento e status é PENDING.
 * FIX-502: mensagem amigável quando API retorna 502 (servidor inicializando).
 * FIX-SESSION-ORDER: sessão só é persistida com step=awaiting_payment APÓS
 *                    replyWithPhoto ter sucesso, evitando sessão suja em caso de
 *                    falha no envio da foto (ex: erro 400 MarkdownV2).
 * FIX-CHECK-SESSION-ORDER: handleCheckPayment carrega sessão uma vez no início;
 *                          clearSession sempre recebe firstName; clearSession
 *                          movida para após editOrReply nos status terminais.
 * FIX-ESCAPEHTML-NUMERIC: escapeHtml() removido de valores numéricos puros.
 * FIX-DOUBLE-GETSESSION: executePayment unificado para uma única leitura de sessão
 *                        (sessionForCoupon e sessionAfterSend fundidos em `session`).
 * FIX-ESCAPEHTML-DISCOUNT: escapeHtml() removido de discountAmount.toFixed(2).
 */
import { Context, Markup } from 'telegraf';
import { Telegraf } from 'telegraf';
import { escapeHtml, escapeMd } from '../utils/escape';
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

// ─── Tela de seleção de método de pagamento ──────────────────────────────────────────────────────

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

  // FIX-COUPON-DISCOUNT: aplica desconto do cupão ao preço exibido
  const session = await getSession(userId);
  const rawPrice = Number(product.price);
  const couponDiscount = session.pendingCouponDiscount ?? 0;
  const price = Math.max(0, rawPrice - couponDiscount);

  // FIX-ESCAPEHTML-NUMERIC: valores numéricos não precisam de escapeHtml
  const balanceStr = balance.toFixed(2);
  const descLine = product.description
    ? `\n📝 <i>${escapeHtml(product.description)}</i>\n`
    : '';

  const couponLine = session.pendingCoupon
    ? `🏷️ <b>Cupão:</b> <code>${escapeHtml(session.pendingCoupon)}</code> <b>(-R$ ${couponDiscount.toFixed(2)})</b>\n` +
      `💵 <b>Total com desconto:</b> R$ ${price.toFixed(2)}\n`
    : '';

  const confirmMessage =
    `📦 <b>${escapeHtml(product.name)}</b>${descLine}\n` +
    `────────────────────\n` +
    `💰 <b>Valor:</b> R$ ${rawPrice.toFixed(2)}\n` +
    couponLine +
    `🏦 <b>Seu saldo:</b> R$ ${balanceStr}\n\n` +
    `<b>Como deseja pagar?</b>`;

  const buttons = [];

  if (balance >= price) {
    buttons.push([
      Markup.button.callback(`💰 Só Saldo  (R$ ${price.toFixed(2)})`, `pay_balance_${product.id}`),
    ]);
  }

  buttons.push([
    Markup.button.callback(`📱 Só PIX  (R$ ${price.toFixed(2)})`, `pay_pix_${product.id}`),
  ]);

  if (balance > 0 && balance < price) {
    const pixDiff = (price - balance).toFixed(2);
    buttons.push([
      Markup.button.callback(
        `🔀 Saldo + PIX  (saldo R$ ${balanceStr} + PIX R$ ${pixDiff})`,
        `pay_mixed_${product.id}`
      ),
    ]);
  }

  if (session.pendingCoupon) {
    buttons.push([Markup.button.callback('🗑️ Remover cupão', `remove_coupon_${product.id}`)]);
  } else {
    buttons.push([Markup.button.callback('🏷️ Tenho um cupão', `coupon_input_${product.id}`)]);
  }

  buttons.push([Markup.button.callback('◀️ Voltar', 'show_products')]);

  await editOrReply(ctx, confirmMessage, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
  });
}

// ─── Tela de input de cupão ────────────────────────────────────────────────────────────────────────────────────

export async function showCouponInputScreen(
  ctx: Context,
  productId: string
): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  session.step = 'awaiting_coupon';
  session.pendingProductId = productId;
  await saveSession(userId, session);

  await editOrReply(
    ctx,
    `🏷️ <b>Digite seu cupão de desconto:</b>\n\n` +
    `<i>Envie o código do cupão ou clique em Pular para continuar sem desconto.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('⏭️ Pular', `skip_coupon_${productId}`)],
        [Markup.button.callback('◀️ Voltar', `select_product_${productId}`)],
      ]).reply_markup,
    }
  );
}

// ─── Execução de pagamento ───────────────────────────────────────────────────────────────────────────────────────

export async function executePayment(
  ctx: Context,
  productId: string,
  paymentMethod: 'BALANCE' | 'PIX' | 'MIXED',
  couponCode?: string,
  referralCode?: string
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
    await editOrReply(ctx, '⏳ Processando sua compra, aguarde...', { parse_mode: 'HTML' });

    // FIX-DOUBLE-GETSESSION: sessão carregada uma única vez e reutilizada
    // em todo o fluxo (cupão, pagamento por saldo e PIX).
    const session = await getSession(userId);
    const effectiveCoupon = couponCode ?? session.pendingCoupon ?? undefined;

    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      firstName: ctx.from?.first_name,
      username: ctx.from?.username,
      paymentMethod,
      ...(effectiveCoupon ? { couponCode: effectiveCoupon } : {}),
      ...(referralCode ? { referralCode } : {}),
    } as Parameters<typeof apiClient.createPayment>[0]);

    // ── Pagamento por saldo puro: salva sessão e finaliza ───────────────────────
    const paymentAny = payment as unknown as Record<string, unknown>;

    if (payment.paidWithBalance) {
      // FIX-ESCAPEHTML-DISCOUNT: discountAmount.toFixed(2) é numérico — sem escapeHtml.
      // couponCode mantido com escapeHtml pois é dado externo (API).
      const discountLine = paymentAny.discountAmount
        ? `\n🏷️ <b>Desconto aplicado:</b> R$ ${Number(paymentAny.discountAmount).toFixed(2)} (cupão ${escapeHtml(String(paymentAny.couponCode ?? ''))})\n`
        : '';

      await editOrReply(
        ctx,
        `✅ <b>Compra realizada com saldo!</b>\n\n` +
          `📦 <b>Produto:</b> ${escapeHtml(payment.productName)}\n` +
          `💰 <b>Valor debitado:</b> R$ ${Number(payment.amount).toFixed(2)}${discountLine}\n` +
          `Seu produto será entregue em instantes! 🚀`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
            [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
          ]).reply_markup,
        }
      );
      await clearSession(userId, session.firstName);
      return;
    }

    // ── Pagamento PIX / Misto: envia QR code primeiro, só então persiste sessão ──
    const expiresAt = new Date(payment.expiresAt);
    const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    const mixedLine = payment.isMixed
      ? `\n💳 *Saldo usado:* R$ ${escapeMd(Number(payment.balanceUsed).toFixed(2))}\n📱 *PIX a pagar:* R$ ${escapeMd(Number(payment.pixAmount).toFixed(2))}`
      : '';

    const discountMdLine = paymentAny.discountAmount
      ? `\n🏷️ *Desconto:* R$ ${escapeMd(Number(paymentAny.discountAmount).toFixed(2))}`
      : '';

    const qrBuffer = Buffer.from(payment.pixQrCode, 'base64');

    // FIX-MDV2: '!' é reservado no MarkdownV2 — escapado manualmente no literal
    // e via escapeMd() em todos os valores dinâmicos.
    const caption =
      `💳 *Pagamento PIX Gerado\\!*\n\n` +
      `📦 *Produto:* ${escapeMd(payment.productName)}\n` +
      `💰 *Valor total:* R$ ${escapeMd(Number(payment.amount).toFixed(2))}${mixedLine}${discountMdLine}\n` +
      `⏰ *Válido até:* ${escapeMd(expiresStr)}\n` +
      `�fa *ID:* \`${escapeMd(payment.paymentId)}\`\n\n` +
      `📋 *Copia e Cola:*\n\`${escapeMd(payment.pixQrCodeText)}\``;

    const chatId = ctx.chat?.id;
    if (chatId && session.mainMessageId) {
      await ctx.telegram.deleteMessage(chatId, session.mainMessageId).catch(() => {});
    }

    // FIX-SESSION-ORDER: envia a foto PRIMEIRO. Se falhar, a sessão NÃO é marcada
    // como awaiting_payment e o pagamento não fica pendente fantasma no Redis.
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

    // Foto enviada com sucesso — agora é seguro persistir o estado de pagamento.
    // FIX-DOUBLE-GETSESSION: reutiliza `session` em vez de fazer novo getSession.
    session.paymentId = payment.paymentId;
    session.step = 'awaiting_payment';
    session.pixExpiresAt = payment.expiresAt;
    session.pixQrCodeText = payment.pixQrCodeText;
    session.mainMessageId = qrMsg.message_id;
    delete session.pendingProductId;
    delete session.pendingCoupon;
    delete session.pendingCouponDiscount;
    await saveSession(userId, session);

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

    if (errStatus === 502) {
      await editOrReply(
        ctx,
        `🛠️ <b>O servidor está inicializando</b>\n\nAguarde alguns segundos e tente novamente. 😊`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Tentar Novamente', `select_product_${productId}`)],
            [Markup.button.callback('◀️ Voltar', 'show_products')],
          ]).reply_markup,
        }
      );
      return;
    }

    if (errStatus === 503 || errMsg.toLowerCase().includes('manutencao') || errMsg.toLowerCase().includes('manutenção')) {
      await editOrReply(
        ctx,
        `🛠️ <b>Manutenção em Andamento</b>\n\n${escapeHtml(errMsg)}\n\n<i>Tente novamente em alguns instantes! 😊</i>`,
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup }
      );
      return;
    }

    if (errStatus === 400 && (
      errMsg.includes('Cupão') || errMsg.includes('cupão') ||
      errMsg.includes('COUPON')
    )) {
      await editOrReply(
        ctx,
        `❌ <b>${escapeHtml(errMsg)}</b>\n\nTente outro cupão ou pague sem desconto.`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🏷️ Tentar outro cupão', `coupon_input_${productId}`)],
            [Markup.button.callback('📱 Pagar sem cupão', `pay_pix_${productId}`)],
            [Markup.button.callback('◀️ Voltar', `select_product_${productId}`)],
          ]).reply_markup,
        }
      );
      return;
    }

    if (errMsg.toLowerCase().includes('saldo insuficiente')) {
      await editOrReply(
        ctx,
        `❌ <b>${escapeHtml(errMsg)}</b>\n\nEscolha outra forma de pagamento ou adicione saldo.`,
        {
          parse_mode: 'HTML',
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
        ? `⏳ <b>Demorou um pouquinho mais que o esperado...</b>\n\nClique em <b>Tentar Novamente</b> abaixo 😊`
        : `⚠️ <b>Algo deu errado ao gerar o PIX</b>\n\nSeu dinheiro não foi cobrado.\nClique em <b>Tentar Novamente</b>.`,
      {
        parse_mode: 'HTML',
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

// ─── Timeout de PIX ───────────────────────────────────────────────────────────────────────────────────────────────

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

      try {
        const { status } = await apiClient.getPaymentStatus(paymentId, String(userId));
        if (status === 'APPROVED' || status === 'CANCELLED') {
          await clearSession(userId, session.firstName);
          return;
        }
      } catch {
        // API inacessível — avisa mesmo assim
      }

      await _bot.telegram
        .sendMessage(chatId, '⌛ Seu PIX expirou. Use /start para gerar um novo.', { parse_mode: 'HTML' })
        .catch(() => {});
      await clearSession(userId, session.firstName);
    } catch (err) {
      console.warn(`[schedulePIXExpiry] Erro ao expirar PIX ${paymentId}:`, err);
    }
  }, delayMs);
}

// ─── Verificar pagamento ───────────────────────────────────────────────────────────────────────────────────────────

export async function handleCheckPayment(ctx: Context, paymentId: string): Promise<void> {
  const userId = ctx.from!.id;

  await ctx.answerCbQuery('🔄 Verificando...').catch(() => {});

  // FIX-CHECK-SESSION-ORDER: carrega sessão uma vez para todos os branches
  const session = await getSession(userId);

  try {
    const { status } = await apiClient.getPaymentStatus(paymentId, String(userId));

    if (status === 'PENDING') {
      // FEAT-COPYPASTE-CHECK: reenvia copia e cola junto com o status pendente
      const pixText = session.pixQrCodeText;

      const copyPasteBlock = pixText
        ? `\n\n📋 <b>Copia e Cola:</b>\n<code>${escapeHtml(pixText)}</code>`
        : '';

      await editOrReply(
        ctx,
        `⏳ <b>Pagamento pendente</b>\n\nAinda não identificamos seu pagamento. Se já pagou, aguarde alguns segundos e verifique novamente.${copyPasteBlock}`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Novamente', `check_payment_${paymentId}`)],
            [Markup.button.callback('❌ Cancelar', `cancel_payment_${paymentId}`)],
          ]).reply_markup,
        }
      );
      return;
    }

    const statusMessages: Record<string, string> = {
      APPROVED:
        '✅ <b>Pagamento aprovado!</b>\n\nSeu acesso está sendo liberado. Você receberá uma mensagem em instantes.',
      REJECTED:
        '❌ <b>Pagamento rejeitado</b>\n\nHouve um problema com seu pagamento. Por favor, tente novamente.',
      CANCELLED: '❌ <b>Pagamento cancelado</b>\n\nEste pagamento foi cancelado.',
      EXPIRED: '⌛ <b>Pagamento expirado</b>\n\nO código PIX expirou. Gere um novo pagamento.',
    };

    const msg = statusMessages[status] || '❓ Status desconhecido';

    // FIX-CHECK-RACE: envia a mensagem ANTES de limpar a sessão
    await editOrReply(
      ctx,
      msg,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🏠 Menu Inicial', 'show_home')],
          [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
        ]).reply_markup,
      }
    );

    // Limpa sessão após confirmar que a mensagem foi entregue
    await clearSession(userId, session.firstName);
  } catch (err) {
    console.error('[handleCheckPayment] Erro ao verificar pagamento:', err);
    await ctx.reply('⚠️ Erro ao verificar pagamento. Tente novamente.', {
      parse_mode: 'HTML',
    }).catch(() => {});
  }
}

// ─── Cancelar pagamento ────────────────────────────────────────────────────────���──────────────────────────────

export async function handleCancelPayment(ctx: Context, paymentId: string): Promise<void> {
  const userId = ctx.from!.id;

  await ctx.answerCbQuery('❌ Cancelando...').catch(() => {});

  const session = await getSession(userId);
  if (session.paymentId !== paymentId) {
    console.warn(`[cancelPayment] userId ${userId} tentou cancelar paymentId ${paymentId} que não é dele (sessão: ${session.paymentId})`);
    await ctx.reply('⚠️ Ação não autorizada.', { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  const lockKey = `cancel:${paymentId}`;
  const acquired = await acquireLock(lockKey, 15);
  if (!acquired) {
    await ctx.reply('⏳ Cancelamento já em andamento.', { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  try {
    await apiClient.cancelPayment(paymentId, String(userId));
  } catch (error) {
    console.warn(`[cancelPayment] Não foi possível cancelar ${paymentId}:`, error);
  }

  try {
    await deletePhotoAndReply(ctx, session, userId, '❌ <b>Pagamento cancelado.</b>\n\nVolte quando quiser!', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
    });
    await clearSession(userId, session.firstName);
  } catch (err) {
    console.error('[handleCancelPayment] Erro ao finalizar cancelamento:', err);
    await ctx.reply('❌ <b>Pagamento cancelado.</b> Volte quando quiser!', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
    }).catch(() => {});
    await clearSession(userId, session.firstName).catch(() => {});
  } finally {
    await releaseLock(lockKey);
  }
}
