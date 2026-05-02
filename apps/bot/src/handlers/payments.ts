/**
 * Handlers de pagamento: seleção de produto, execução de pagamento (PIX/Saldo/Misto),
 * verificação de status, cancelamento e timeout de PIX.
 *
 * PADRÃO: parse_mode HTML em mensagens de texto.
 *         parse_mode MarkdownV2 APENAS em captions de replyWithPhoto.
 *
 * FIX-BUILD: remove imports inexistentes (../lib/logger, sentry, lock).
 *            usa ../services/locks para acquireLock/releaseLock.
 *            usa console.error/warn em vez de logger/captureError.
 *            corrige pixQrCodeText (não pixCopyPaste).
 *            corrige payment.paymentId (não payment.id).
 * FEAT-MULTI-QTY: showQuantityScreen exportada;
 *                 stockLine no card de pagamento;
 *                 quantity no createPayment.
 * FEAT: emoji carteira no botão de saldo; botão cancelar depósito na tela PIX;
 *       cupom único por usuário (markCouponUsed/hasCouponBeenUsed).
 */
import { Context, Markup } from 'telegraf';
import { apiClient } from '../services/apiClient';
import { getSession, saveSession, clearSession, markCouponUsed, hasCouponBeenUsed } from '../services/session';
import { acquireLock, releaseLock } from '../services/locks';

type ProductDTO = Awaited<ReturnType<typeof apiClient.getProducts>>[number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
) {
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, extra as never);
    } else {
      await ctx.reply(text, extra as never);
    }
  } catch {
    await ctx.reply(text, extra as never);
  }
}

export function initPaymentHandlers() {
  // placeholder — handlers registrados no index.ts
}

// ─── PIX timers ──────────────────────────────────────────────────────────────

const pixTimers = new Map<number, NodeJS.Timeout>();

function registerPIXTimer(userId: number, t: NodeJS.Timeout) {
  cancelPIXTimer(userId);
  pixTimers.set(userId, t);
}

export function cancelPIXTimer(userId: number) {
  const existing = pixTimers.get(userId);
  if (existing) {
    clearTimeout(existing);
    pixTimers.delete(userId);
  }
}

// ─── Tela de quantidade ──────────────────────────────────────────────────────

export async function showQuantityScreen(
  ctx: Context,
  product: ProductDTO
): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  session.step = 'awaiting_quantity';
  session.pendingProductId = product.id;
  session.pendingQty = undefined;
  await saveSession(userId, session);

  const maxStock = product.stock != null ? product.stock : Infinity;
  const maxQty = Math.min(maxStock, 10);

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

  const descLine = product.description
    ? `\n📝 <i>${escapeHtml(product.description)}</i>` : '';
  const stockLine = product.stock != null && product.stock <= 5
    ? `\n⚠️ <b>Apenas ${product.stock} em estoque!</b>` : '';

  const qtyRows: ReturnType<typeof Markup.button.callback>[][] = [];
  let row: ReturnType<typeof Markup.button.callback>[] = [];
  for (let i = 1; i <= maxQty; i++) {
    const unitTotal = (Number(product.price) * i).toFixed(2);
    row.push(Markup.button.callback(`${i}x — R$ ${unitTotal}`, `set_qty_${product.id}_${i}`));
    if (row.length === 3 || i === maxQty) {
      qtyRows.push([...row]);
      row = [];
    }
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

// ─── Tela de método de pagamento ─────────────────────────────────────────────

export async function showPaymentMethodScreen(
  ctx: Context,
  product: ProductDTO,
  balance: number
): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  const rawPrice = Number(product.price);
  const couponDiscount = session.pendingCouponDiscount ?? 0;
  const qty = session.pendingQty ?? 1;
  const unitPrice = Math.max(0, rawPrice - couponDiscount);
  const price = unitPrice * qty;

  const descLine = product.description
    ? `\n📝 <i>${escapeHtml(product.description)}</i>\n` : '';

  const stockLine = (() => {
    if (product.stock == null) return '';
    if (product.stock <= 0)   return `\n⛔ <b>ESGOTADO</b>\n`;
    if (product.stock <= 5)   return `\n⚠️ <b>Apenas ${product.stock} em estoque!</b>\n`;
    return `\n📦 <b>Estoque:</b> ${product.stock} disponíveis\n`;
  })();

  const couponLine = session.pendingCoupon
    ? `🏷️ <b>Cupom:</b> <code>${escapeHtml(session.pendingCoupon)}</code> <b>(-R$ ${couponDiscount.toFixed(2)})</b>\n` +
      `💵 <b>Total com desconto:</b> R$ ${unitPrice.toFixed(2)}/un\n`
    : '';

  const qtyLine = qty > 1
    ? `🔢 <b>Quantidade:</b> ${qty}x\n` +
      `💵 <b>Total:</b> R$ ${price.toFixed(2)}\n`
    : '';

  const confirmMessage =
    `📦 <b>${escapeHtml(product.name)}</b>${descLine}` +
    stockLine +
    `\n────────────────────\n` +
    `💰 <b>Valor unitário:</b> R$ ${rawPrice.toFixed(2)}\n` +
    couponLine +
    qtyLine +
    `👛 <b>Seu saldo:</b> R$ ${balance.toFixed(2)}\n\n` +
    `<b>Como deseja pagar?</b>`;

  const canPayWithBalance = balance >= price;
  const canPayMixed = balance > 0 && balance < price;
  const hasCoupon = !!session.pendingCoupon;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`💳 PIX (R$ ${price.toFixed(2)})`, `pay_pix_${product.id}`)],
    ...(canPayWithBalance ? [[Markup.button.callback(`👛 Saldo (R$ ${price.toFixed(2)})`, `pay_balance_${product.id}`)]] : []),
    ...(canPayMixed ? [[Markup.button.callback(`🔀 Misto (Saldo + PIX)`, `pay_mixed_${product.id}`)]] : []),
    ...(!hasCoupon ? [[Markup.button.callback('🏷️ Aplicar cupom', `coupon_input_${product.id}`)]] : []),
    ...(hasCoupon ? [[Markup.button.callback('🗑️ Remover cupom', `remove_coupon_${product.id}`)]] : []),
    [Markup.button.callback('❌ Cancelar', 'cancel_payment')],
  ]);

  await editOrReply(ctx, confirmMessage, {
    parse_mode: 'HTML',
    reply_markup: keyboard.reply_markup,
  });
}

// ─── Tela de input de cupom ──────────────────────────────────────────────────

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
    `🏷️ <b>Aplicar cupom</b>\n\nDigite o código do cupom abaixo:`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancelar', `back_to_payment_${productId}`)],
      ]).reply_markup,
    }
  );
}

// ─── Executar pagamento ───────────────────────────────────────────────────────

export async function executePayment(
  ctx: Context,
  productId: string,
  paymentMethod: 'PIX' | 'BALANCE' | 'MIXED'
): Promise<void> {
  const userId = ctx.from!.id;
  const lockKey = `payment_lock:${userId}`;
  const lockToken = await acquireLock(lockKey, 30);
  if (!lockToken) {
    await ctx.reply('⏳ Aguarde, seu pagamento anterior ainda está sendo processado.', { parse_mode: 'HTML' });
    return;
  }

  const session = await getSession(userId);

  try {
    const qty = session.pendingQty ?? 1;
    const effectiveCoupon = session.pendingCoupon ?? undefined;

    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      quantity: qty,
      firstName: ctx.from?.first_name,
      username: ctx.from?.username,
      paymentMethod,
      ...(effectiveCoupon ? { couponCode: effectiveCoupon } : {}),
    } as Parameters<typeof apiClient.createPayment>[0]);

    // Marca o cupom como usado por este usuário
    if (effectiveCoupon) {
      await markCouponUsed(userId, effectiveCoupon);
    }

    if (paymentMethod === 'PIX' || paymentMethod === 'MIXED') {
      const qrText = payment.pixQrCodeText ?? payment.pixQrCode ?? '';
      const amount = payment.amount ?? 0;
      const expiresAt = payment.expiresAt
        ? new Date(payment.expiresAt).toISOString()
        : new Date(Date.now() + 30 * 60 * 1000).toISOString();

      let productName = payment.productName ?? '';
      if (!productName) {
        try {
          const products = await apiClient.getProducts();
          productName = products.find((p) => p.id === productId)?.name ?? '';
        } catch { /**/ }
      }

      const captionLines = [
        `💳 *PIX gerado com sucesso\!*`,
        ``,
        `📦 *Produto:* ${escapeMarkdownV2(productName)}`,
        `💰 *Valor:* R\$ ${escapeMarkdownV2(Number(amount).toFixed(2))}`,
        `⏰ *Expira em:* 30 minutos`,
        ``,
        `Copie o código abaixo ou escaneie o QR Code:`,
      ].join('\n').slice(0, 900);

      const pixMsg = await ctx.replyWithPhoto(
        { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrText)}` },
        {
          caption: captionLines,
          parse_mode: 'MarkdownV2',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
            [Markup.button.callback('❌ Cancelar PIX', `cancel_payment_${payment.paymentId}`)],
          ]).reply_markup,
        }
      );

      await ctx.reply(`<code>${escapeHtml(qrText)}</code>`, { parse_mode: 'HTML' });

      session.step = 'awaiting_payment';
      session.paymentId = payment.paymentId;
      session.pixExpiresAt = expiresAt;
      session.pixQrCodeText = qrText;
      session.mainMessageId = pixMsg.message_id;
      await saveSession(userId, session);

      await schedulePIXExpiry(ctx, payment.paymentId, userId, expiresAt);
    } else {
      // BALANCE
      const usedCoupons = session.usedCoupons ?? [];
      await clearSession(userId, session.firstName, usedCoupons);
      await ctx.reply(
        `✅ <b>Pagamento realizado com sucesso!</b>\n\n📦 Seu pedido foi confirmado.`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err: unknown) {
    console.error('[executePayment] erro:', err);
    const msg = err instanceof Error ? err.message : '';
    const is502 = msg.includes('502') || msg.includes('Bad Gateway');
    if (is502) {
      await ctx.reply('⚠️ O servidor está inicializando. Tente novamente em alguns segundos.', { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`❌ Erro ao processar pagamento: ${escapeHtml(msg || 'Erro desconhecido')}`, { parse_mode: 'HTML' });
    }
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

// ─── Verificar pagamento ──────────────────────────────────────────────────────

export async function handleCheckPayment(
  ctx: Context,
  paymentId: string
): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);

  try {
    const status = await apiClient.getPaymentStatus(paymentId, String(userId));

    if (status.status === 'PAID' || status.status === 'APPROVED') {
      await editOrReply(ctx,
        `✅ <b>Pagamento confirmado!</b>\n\nSeu pedido foi processado com sucesso.`,
        { parse_mode: 'HTML' }
      );
      const usedCoupons = session.usedCoupons ?? [];
      await clearSession(userId, session.firstName, usedCoupons);
    } else if (status.status === 'EXPIRED' || status.status === 'CANCELLED') {
      await editOrReply(ctx,
        `❌ <b>Pagamento ${status.status === 'EXPIRED' ? 'expirado' : 'cancelado'}</b>\n\nGere um novo pedido quando quiser.`,
        { parse_mode: 'HTML' }
      );
      const usedCoupons = session.usedCoupons ?? [];
      await clearSession(userId, session.firstName, usedCoupons);
    } else {
      if (session.pixQrCodeText) {
        await ctx.reply(
          `⏳ Pagamento ainda não confirmado. Copie o código PIX abaixo:\n\n<code>${escapeHtml(session.pixQrCodeText)}</code>`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.answerCbQuery('⏳ Pagamento ainda não confirmado. Aguarde.').catch(() => {});
      }
    }
  } catch (err) {
    console.error('[handleCheckPayment] erro:', err);
    await ctx.reply('❌ Erro ao verificar pagamento. Tente novamente.', { parse_mode: 'HTML' });
  }
}

// ─── Cancelar pagamento ───────────────────────────────────────────────────────

export async function handleCancelPayment(
  ctx: Context,
  paymentId: string
): Promise<void> {
  const userId = ctx.from!.id;
  const lockKey = `cancel_lock:${userId}`;
  const lockToken = await acquireLock(lockKey, 15);
  if (!lockToken) return;

  const session = await getSession(userId);

  try {
    await apiClient.cancelPayment(paymentId, String(userId));
    await editOrReply(ctx,
      `❌ <b>PIX cancelado.</b>\n\nUse /produtos para fazer um novo pedido.`,
      { parse_mode: 'HTML' }
    );
    cancelPIXTimer(userId);
    const usedCoupons = session.usedCoupons ?? [];
    await clearSession(userId, session.firstName, usedCoupons).catch(() => {});
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

// ─── Agendar expiração do PIX ─────────────────────────────────────────────────

export async function schedulePIXExpiry(
  ctx: Context,
  paymentId: string,
  userId: number,
  expiresAtISO: string
): Promise<void> {
  const expiresAt = new Date(expiresAtISO).getTime();
  const now = Date.now();
  const msUntilExpiry = expiresAt - now;

  if (msUntilExpiry <= 0) {
    try {
      const status = await apiClient.getPaymentStatus(paymentId, String(userId));
      if (status.status !== 'PAID' && status.status !== 'APPROVED') {
        await ctx.reply('⏰ Seu PIX expirou. Gere um novo pedido quando quiser.', { parse_mode: 'HTML' });
        const session = await getSession(userId);
        await clearSession(userId, session.firstName, session.usedCoupons ?? []);
      }
    } catch { /**/ }
    return;
  }

  const t = setTimeout(async () => {
    try {
      const status = await apiClient.getPaymentStatus(paymentId, String(userId));
      if (status.status !== 'PAID' && status.status !== 'APPROVED') {
        await ctx.reply('⏰ Seu PIX expirou. Gere um novo pedido quando quiser.', { parse_mode: 'HTML' });
        const session = await getSession(userId);
        await clearSession(userId, session.firstName, session.usedCoupons ?? []);
      }
    } catch { /**/ } finally {
      cancelPIXTimer(userId);
    }
  }, msUntilExpiry);

  registerPIXTimer(userId, t);
}
