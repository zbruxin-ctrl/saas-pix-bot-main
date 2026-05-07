/**
 * Handlers de pagamento: seleção de produto, execução de pagamento (PIX/Saldo/Misto),
 * verificação de status, cancelamento e timeout de PIX.
 *
 * PADRÃO: parse_mode HTML em mensagens de texto.
 *         parse_mode MarkdownV2 APENAS em captions de replyWithPhoto.
 *
 * FIX-QTY-BOT: quantity (session.pendingQty) agora é passado no createPayment.
 * FIX-DELIVERY-BOT: bot não monta mais mensagem de entrega para BALANCE/PIX.
 * FIX-CANCEL-DELETE: ao cancelar/expirar PIX, deleta as 2 mensagens (QR foto +
 *   código copia e cola) e envia nova mensagem de status.
 * FIX-CANCEL-NOT-PENDING: quando API retorna 'Apenas pagamentos pendentes podem
 *   ser cancelados', deleta as mensagens, limpa a sessão e exibe mensagem amigável.
 */
import { Context, Markup } from 'telegraf';
import { apiClient } from '../services/apiClient';
import { getSession, saveSession, clearSession, markCouponUsed } from '../services/session';
import { acquireLock, releaseLock, cancelPIXTimer, registerPIXTimer } from '../services/locks';
import { applyCoupon } from '../services/couponClient';
import { persistPixExpiry, clearPixExpiry } from '../services/pixExpiry';

type ProductDTO = Awaited<ReturnType<typeof apiClient.getProducts>>[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMarkdownV2(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function editOrReply(
  ctx: Context,
  text: string,
  extra?: Parameters<Context['editMessageText']>[1]
): Promise<void> {
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, extra as never);
      return;
    }
  } catch (err: unknown) {
    void err;
  }
  await ctx.reply(text, extra as never);
}

/**
 * Tenta deletar uma mensagem pelo message_id. Silencia erros.
 */
async function tryDeleteMessage(ctx: Context, messageId: number): Promise<void> {
  try {
    const chatId = ctx.chat?.id ?? (ctx.callbackQuery?.message as { chat?: { id?: number } } | undefined)?.chat?.id;
    if (chatId) await ctx.telegram.deleteMessage(chatId, messageId);
  } catch {
    // silencia: mensagem pode já ter sido deletada ou ser muito antiga (>48h)
  }
}

/**
 * Deleta QR + código copia e cola em paralelo.
 */
async function deletePixMessages(
  ctx: Context,
  pixQrMessageId?: number,
  pixCodeMessageId?: number
): Promise<void> {
  await Promise.all([
    pixQrMessageId   ? tryDeleteMessage(ctx, pixQrMessageId)   : Promise.resolve(),
    pixCodeMessageId ? tryDeleteMessage(ctx, pixCodeMessageId) : Promise.resolve(),
  ]);
}

export function initPaymentHandlers(): void {
  // placeholder — handlers registrados no index.ts
}

// ─── Helpers de teclado pós-compra ───────────────────────────────────────────

function afterPurchaseKeyboard(productId?: string): ReturnType<typeof Markup.inlineKeyboard> {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (productId) {
    rows.push([Markup.button.callback('🔄 Comprar Novamente', `select_product_${productId}`)]);
  }
  rows.push([Markup.button.callback('🏠 Menu Principal', 'show_home')]);
  return Markup.inlineKeyboard(rows);
}

// ─── Tela de quantidade ───────────────────────────────────────────────────────

export async function showQuantityScreen(
  ctx: Context,
  product: ProductDTO
): Promise<void> {
  const userId  = ctx.from!.id;
  const session = await getSession(userId);
  session.step             = 'awaiting_quantity';
  session.pendingProductId = product.id;
  session.pendingQty       = undefined;
  await saveSession(userId, session);

  const effectiveStock = product.availableStock ?? product.stock;
  const maxStock = effectiveStock != null ? effectiveStock : Infinity;
  const maxQty   = Math.min(maxStock, 10);

  if (maxQty <= 0) {
    await editOrReply(
      ctx,
      `⛔ <b>${escapeHtml(product.name)}</b>\n\nEste produto está esgotado no momento.`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('◀️ Ver outros produtos', 'show_products')],
        ]).reply_markup,
      }
    );
    return;
  }

  const descLine  = product.description ? `\n📝 <i>${escapeHtml(product.description)}</i>` : '';
  const stockLine = effectiveStock != null && effectiveStock <= 5
    ? `\n⚠️ <b>Apenas ${effectiveStock} em estoque!</b>` : '';

  const qtyRows: ReturnType<typeof Markup.button.callback>[][] = [];
  let row: ReturnType<typeof Markup.button.callback>[] = [];
  for (let i = 1; i <= maxQty; i++) {
    const unitTotal = (Number(product.price) * i).toFixed(2);
    row.push(Markup.button.callback(`${i}x — R$ ${unitTotal}`, `set_qty_${product.id}_${i}`));
    if (row.length === 3 || i === maxQty) { qtyRows.push([...row]); row = []; }
  }
  qtyRows.push([Markup.button.callback('◀️ Voltar', 'show_products')]);

  await editOrReply(
    ctx,
    `📦 <b>${escapeHtml(product.name)}</b>${descLine}${stockLine}\n\n` +
    `💰 <b>Preço unitário:</b> R$ ${Number(product.price).toFixed(2)}\n\n` +
    `<b>Quantas unidades deseja comprar?</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(qtyRows).reply_markup,
    }
  );
}

// ─── Tela de método de pagamento ──────────────────────────────────────────────

export async function showPaymentMethodScreen(
  ctx: Context,
  product: ProductDTO,
  balance: number
): Promise<void> {
  const userId  = ctx.from!.id;
  const session = await getSession(userId);
  const rawPrice      = Number(product.price);
  const couponDiscount = session.pendingCouponDiscount ?? 0;
  const qty            = session.pendingQty ?? 1;
  const unitPrice      = Math.max(0, rawPrice - couponDiscount);
  const price          = unitPrice * qty;

  const descLine  = product.description ? `\n📝 <i>${escapeHtml(product.description)}</i>\n` : '';
  const effectiveStock = product.availableStock ?? product.stock;
  const stockLine = (() => {
    if (effectiveStock == null) return '';
    if (effectiveStock <= 0)   return `\n⚠️ <b>Esgotado!</b>`;
    if (effectiveStock <= 5)   return `\n⚠️ <b>Apenas ${effectiveStock} em estoque!</b>`;
    return '';
  })();
  const couponLine = session.pendingCoupon
    ? `\n🏷️ <b>Cupom:</b> <code>${escapeHtml(session.pendingCoupon)}</code> (-R$ ${couponDiscount.toFixed(2)})` : '';
  const qtyLine = qty > 1 ? `\n🔢 <b>Quantidade:</b> ${qty}x` : '';

  const canPayBalance = balance >= price;
  const canPayMixed   = balance > 0 && balance < price;

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];
  buttons.push([Markup.button.callback(`💳 PIX — R$ ${price.toFixed(2)}`, `pay_pix_${product.id}`)]);

  if (canPayBalance) {
    buttons.push([Markup.button.callback(
      `💰 Saldo (R$ ${balance.toFixed(2)}) — Pagar R$ ${price.toFixed(2)}`,
      `pay_balance_${product.id}`
    )]);
  }

  if (canPayMixed) {
    const pixPart = (price - balance).toFixed(2);
    buttons.push([Markup.button.callback(
      `🔀 Misto — Saldo R$ ${balance.toFixed(2)} + PIX R$ ${pixPart}`,
      `pay_mixed_${product.id}`
    )]);
  }

  if (!session.pendingCoupon) {
    buttons.push([Markup.button.callback('🏷️ Usar Cupom', `coupon_input_${product.id}`)]);
  } else {
    buttons.push([Markup.button.callback('❌ Remover Cupom', `remove_coupon_${product.id}`)]);
  }
  buttons.push([Markup.button.callback('◀️ Voltar', `select_product_${product.id}`)]);

  await editOrReply(
    ctx,
    `📦 <b>${escapeHtml(product.name)}</b>${descLine}${stockLine}${qtyLine}\n\n` +
    `💰 <b>Total a pagar:</b> R$ ${price.toFixed(2)}${couponLine}\n\n` +
    `<b>Como deseja pagar?</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    }
  );
}

// ─── Tela de input de cupom ───────────────────────────────────────────────────

export async function showCouponInputScreen(
  ctx: Context,
  productId: string
): Promise<void> {
  const userId  = ctx.from!.id;
  const session = await getSession(userId);
  session.step             = 'awaiting_coupon';
  session.pendingProductId = productId;
  await saveSession(userId, session);

  await editOrReply(
    ctx,
    `🏷️ <b>Inserir Cupom</b>\n\nDigite o código do cupom:\n\n<i>Para cancelar, clique no botão abaixo.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Voltar', `back_to_payment_${productId}`)],
      ]).reply_markup,
    }
  );
}

// ─── executePayment ───────────────────────────────────────────────────────────

export async function executePayment(
  ctx: Context,
  productId: string,
  method: 'PIX' | 'BALANCE' | 'MIXED'
): Promise<void> {
  const userId = ctx.from!.id;

  const lockToken = await acquireLock(String(userId));
  if (!lockToken) {
    await ctx.reply('⏳ Aguarde, processando pagamento anterior...', { parse_mode: 'HTML' });
    return;
  }

  try {
    const session       = await getSession(userId);
    const firstName     = ctx.from!.first_name;
    const username      = ctx.from!.username;
    const pendingCoupon = session.pendingCoupon ?? undefined;
    const quantity      = session.pendingQty ?? 1;

    await editOrReply(ctx, '⏳ <b>Processando pagamento...</b>', { parse_mode: 'HTML' });

    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      quantity,
      firstName,
      username,
      paymentMethod: method,
      couponCode: pendingCoupon,
      referralCode: session.referralCode ?? undefined,
    });

    if (pendingCoupon && payment.paymentId) {
      try { await applyCoupon(pendingCoupon, String(userId), payment.paymentId); } catch { /* não bloqueia */ }
    }

    if (payment.paidWithBalance) {
      if (pendingCoupon) await markCouponUsed(userId, pendingCoupon);
      await clearSession(userId, firstName);
      const productName = payment.productName ?? productId;
      const qtyLabel    = quantity > 1 ? ` (${quantity}x)` : '';
      await ctx.reply(
        `✅ <b>Compra realizada com sucesso!</b>\n\n` +
        `📦 <b>${escapeHtml(productName)}${qtyLabel}</b>\n\n` +
        `<i>O conteúdo foi enviado na mensagem acima. Guarde em local seguro.</i>`,
        { parse_mode: 'HTML', reply_markup: afterPurchaseKeyboard(productId).reply_markup }
      );
      return;
    }

    // PIX ou MIXED
    const expiresAt = payment.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const qrText    = payment.pixQrCodeText ?? '';
    const qrImage   = payment.pixQrCode ?? '';

    session.step          = 'awaiting_payment';
    session.paymentId     = payment.paymentId;
    session.pixExpiresAt  = expiresAt;
    session.pixQrCodeText = qrText;
    if (pendingCoupon) await markCouponUsed(userId, pendingCoupon);
    await saveSession(userId, session);

    const amountStr  = String((payment.amount ?? 0).toFixed(2)).replace('.', '\\.');
    const balanceStr = payment.balanceUsed && payment.balanceUsed > 0
      ? `\nSaldo usado: R\\$ ${String(payment.balanceUsed.toFixed(2)).replace('.', '\\.')}\n*PIX:* R\\$ ${String((payment.pixAmount ?? payment.amount ?? 0).toFixed(2)).replace('.', '\\.')}`
      : '';

    let pixQrMessageId: number | undefined;
    if (qrImage) {
      const qrMsg = await ctx.replyWithPhoto(
        { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrText)}` },
        {
          caption:
            `💳 *PIX gerado\\!*\n\n` +
            `*Total:* R\\$ ${amountStr}${balanceStr}\n\n` +
            `Escaneie o QR ou copie o código abaixo:`,
          parse_mode: 'MarkdownV2',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
            [Markup.button.callback('❌ Cancelar PIX',        `cancel_payment_${payment.paymentId}`)],
          ]).reply_markup,
        }
      );
      pixQrMessageId = qrMsg.message_id;
    } else {
      const qrMsg = await ctx.reply(
        `💳 <b>PIX gerado!</b>\n\nTotal: R$ ${(payment.amount ?? 0).toFixed(2)}\n\nCopie o código abaixo:`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
            [Markup.button.callback('❌ Cancelar PIX',        `cancel_payment_${payment.paymentId}`)],
          ]).reply_markup,
        }
      );
      pixQrMessageId = qrMsg.message_id;
    }

    const codeMsg = await ctx.reply(`<code>${qrText}</code>`, { parse_mode: 'HTML' });

    const updatedSession = await getSession(userId);
    updatedSession.pixQrMessageId   = pixQrMessageId;
    updatedSession.pixCodeMessageId = codeMsg.message_id;
    await saveSession(userId, updatedSession);

    await schedulePIXExpiry(ctx, payment.paymentId, userId, expiresAt);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    console.error('[executePayment] erro:', err);
    await ctx.reply(`❌ ${escapeHtml(msg)}`, { parse_mode: 'HTML' });
  } finally {
    await releaseLock(String(userId), lockToken);
  }
}

// ─── handleCheckPayment ───────────────────────────────────────────────────────

export async function handleCheckPayment(
  ctx: Context,
  paymentId: string
): Promise<void> {
  try {
    const userId    = ctx.from!.id;
    const firstName = ctx.from!.first_name;
    const status    = await apiClient.getPaymentStatus(paymentId, String(userId));

    if (status.status === 'APPROVED') {
      cancelPIXTimer(userId);
      await clearPixExpiry(userId);
      await clearSession(userId, firstName);
      await ctx.reply(
        `✅ <b>Pagamento confirmado!</b>\n\n` +
        `📦 <b>${escapeHtml(status.productName ?? 'seu produto')}</b>\n\n` +
        `<i>O conteúdo foi enviado em mensagem separada. Guarde em local seguro.</i>`,
        { parse_mode: 'HTML', reply_markup: afterPurchaseKeyboard().reply_markup }
      );
      return;
    }

    if (status.status === 'EXPIRED' || status.status === 'CANCELLED') {
      await ctx.reply(
        `⏰ Este PIX expirou ou foi cancelado. Use /produtos para fazer um novo pedido.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    await ctx.reply(
      `⏳ Pagamento ainda pendente. Aguarde a confirmação do PIX.`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Verificar novamente', `check_payment_${paymentId}`)],
          [Markup.button.callback('❌ Cancelar PIX',        `cancel_payment_${paymentId}`)],
        ]).reply_markup,
      }
    );
  } catch (err) {
    console.error('[handleCheckPayment] erro:', err);
    await ctx.reply('❌ Erro ao verificar pagamento.', { parse_mode: 'HTML' });
  }
}

// ─── handleCancelPayment ──────────────────────────────────────────────────────

/** Mensagens da API que indicam que o pagamento já foi processado (não é erro do usuário). */
const ALREADY_PROCESSED_MSGS = [
  'apenas pagamentos pendentes',
  'already',
  'não pode ser cancelado',
  'nao pode ser cancelado',
  'expirado',
  'aprovado',
];

function isAlreadyProcessed(message: string): boolean {
  const lower = message.toLowerCase();
  return ALREADY_PROCESSED_MSGS.some((m) => lower.includes(m));
}

export async function handleCancelPayment(
  ctx: Context,
  paymentId: string
): Promise<void> {
  try {
    const userId    = ctx.from!.id;
    const firstName = ctx.from!.first_name;

    const session          = await getSession(userId);
    const pixQrMessageId   = session.pixQrMessageId;
    const pixCodeMessageId = session.pixCodeMessageId;

    const result = await apiClient.cancelPayment(paymentId, String(userId));
    cancelPIXTimer(userId);
    await clearPixExpiry(userId);
    await clearSession(userId, firstName);

    // Deleta QR + código independente do resultado
    await deletePixMessages(ctx, pixQrMessageId, pixCodeMessageId);

    if (result.cancelled) {
      await ctx.reply(
        `❌ <b>PIX cancelado.</b>\n\nUse /produtos para fazer um novo pedido.`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
          ]).reply_markup,
        }
      );
    } else if (isAlreadyProcessed(result.message ?? '')) {
      // Pagamento já foi aprovado ou expirado — mensagem amigável
      await ctx.reply(
        `ℹ️ <b>Este PIX já foi processado</b> (aprovado ou expirado) e não pode mais ser cancelado.\n\n` +
        `Use /produtos para fazer um novo pedido.`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
          ]).reply_markup,
        }
      );
    } else {
      await ctx.reply(
        `⚠️ ${escapeHtml(result.message ?? 'Não foi possível cancelar o pagamento.')}`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    console.error('[handleCancelPayment] erro:', err);
    await ctx.reply('❌ Erro ao cancelar pagamento.', { parse_mode: 'HTML' });
  }
}

// ─── schedulePIXExpiry ────────────────────────────────────────────────────────

export async function schedulePIXExpiry(
  ctx: Context,
  paymentId: string,
  userId: number,
  expiresAt: string
): Promise<void> {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return;

  await persistPixExpiry(userId, paymentId, expiresAt);

  const timer = setTimeout(async () => {
    try {
      const session          = await getSession(userId);
      if (session.paymentId !== paymentId) return;
      const firstName        = session.firstName ?? '';
      const pixQrMessageId   = session.pixQrMessageId;
      const pixCodeMessageId = session.pixCodeMessageId;
      cancelPIXTimer(userId);
      await clearPixExpiry(userId);
      await clearSession(userId, firstName);
      await deletePixMessages(ctx, pixQrMessageId, pixCodeMessageId);
      await ctx.reply(
        `⏰ <b>PIX expirado!</b>\n\nSeu PIX expirou. Use /produtos para gerar um novo pedido.`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
          ]).reply_markup,
        }
      );
    } catch (err) {
      console.error('[PIXExpiry] erro:', err);
    }
  }, ms);

  registerPIXTimer(userId, timer);
}
