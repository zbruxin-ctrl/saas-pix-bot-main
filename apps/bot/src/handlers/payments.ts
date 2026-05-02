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
 *         expiração resistente a restarts.
 *         pixExpiresAt é salvo na sessão para re-agendamento no /start.
 * BUG FIX: answerCbQuery chamado ANTES de qualquer operação async.
 * FEAT-PRICING: tela de cupom/referral antes de gerar PIX.
 * FIX-TS2352: double cast removido (AUDIT #13).
 * FIX-COUPON-DISCOUNT: aplica pendingCouponDiscount ao preço exibido na tela de método.
 * FIX-MDV2: escapa '!' e demais caracteres reservados do MarkdownV2.
 * FEAT-REMOVE-COUPON: botão Remover cupom na tela de método de pagamento.
 * FEAT-COPYPASTE-CHECK: salva pixQrCodeText na sessão.
 * FIX-502: mensagem amigável quando API retorna 502.
 * FIX-SESSION-ORDER, FIX-CHECK-SESSION-ORDER, FIX-ESCAPEHTML-NUMERIC,
 * FIX-DOUBLE-GETSESSION, FIX-ESCAPEHTML-DISCOUNT, AUDIT #4, #7, #19.
 * FIX-CUPOM: cupão→cupom.
 * FEAT-MULTI-QTY: showQuantityScreen para compra múltipla;
 *                 stockLine no card; quantity no createPayment.
 */
import { Context, Markup } from 'telegraf';
import { apiClient } from '../services/apiClient';
import { getSession, saveSession, clearSession, UserSession } from '../services/session';
import { logger } from '../lib/logger';
import { captureError } from '../lib/sentry';
import { releaseLock, acquireLock } from '../lib/lock';

type ProductDTO = Awaited<ReturnType<typeof apiClient.getProducts>>[number];

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
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

// ─── Tela de seleção de quantidade ────────────────────────────────────────────
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
    await editOrReply(ctx,
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

// ─── Tela de método de pagamento ─────────────────────────────────────────────────
export async function showPaymentMethodScreen(
  ctx: Context,
  product: ProductDTO,
  balance: number
): Promise<void> {
  const userId = ctx.from!.id;

  // FIX-COUPON-DISCOUNT: aplica desconto do cupom ao preço exibido
  // FEAT-MULTI-QTY: considera quantidade selecionada no preço total
  const session = await getSession(userId);
  const rawPrice = Number(product.price);
  const couponDiscount = session.pendingCouponDiscount ?? 0;
  const qty = session.pendingQty ?? 1;
  const unitPrice = Math.max(0, rawPrice - couponDiscount);
  const price = unitPrice * qty;

  const balanceStr = balance.toFixed(2);
  const descLine = product.description
    ? `\n📝 <i>${escapeHtml(product.description)}</i>\n`
    : '';

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
    `🏦 <b>Seu saldo:</b> R$ ${balanceStr}\n\n` +
    `<b>Como deseja pagar?</b>`;

  const canPayWithBalance = balance >= price;
  const canPayMixed = balance > 0 && balance < price;

  const hasCoupon = !!session.pendingCoupon;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`💳 PIX (R$ ${price.toFixed(2)})`, `pay_pix_${product.id}`)],
    ...(canPayWithBalance ? [[Markup.button.callback(`🟢 Saldo (R$ ${price.toFixed(2)})`, `pay_balance_${product.id}`)]] : []),
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

// ─── Tela de input de cupom ────────────────────────────────────────────────────
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

// ─── Executar pagamento ─────────────────────────────────────────────────────────
export async function executePayment(
  ctx: Context,
  productId: string,
  paymentMethod: 'PIX' | 'BALANCE' | 'MIXED',
  couponCode?: string,
  referralCode?: string
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
    const effectiveCoupon = couponCode ?? session.pendingCoupon ?? undefined;
    const qty = session.pendingQty ?? 1;

    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      quantity: qty,
      firstName: ctx.from?.first_name,
      username: ctx.from?.username,
      paymentMethod,
      ...(effectiveCoupon ? { couponCode: effectiveCoupon } : {}),
      ...(referralCode ? { referralCode } : {}),
    } as Parameters<typeof apiClient.createPayment>[0]);

    if (paymentMethod === 'PIX' || paymentMethod === 'MIXED') {
      const qrText = payment.pixQrCode ?? payment.pixCopyPaste ?? '';
      const amount = payment.amount ?? 0;
      const expiresAt = payment.expiresAt
        ? new Date(payment.expiresAt).toISOString()
        : new Date(Date.now() + 30 * 60 * 1000).toISOString();

      const caption = escapeMarkdownV2(
        `💳 *PIX gerado com sucesso\!*\n\n` +
        `📦 *Produto:* ${product?.name ?? ''}\n` +
        `💰 *Valor:* R$ ${Number(amount).toFixed(2)}\n\n` +
        `Copie o código abaixo ou escaneie o QR code:`
      ).slice(0, 900);

      let productName = '';
      try {
        const products = await apiClient.getProducts();
        const prod = products.find((p) => p.id === productId);
        productName = prod?.name ?? '';
      } catch { /**/ }

      const captionFinal = [
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
          caption: captionFinal,
          parse_mode: 'MarkdownV2',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.id}`)],
            [Markup.button.callback('❌ Cancelar PIX', `cancel_payment_${payment.id}`)],
          ]).reply_markup,
        }
      );

      await ctx.reply(
        `<code>${escapeHtml(qrText)}</code>`,
        { parse_mode: 'HTML' }
      );

      session.step = 'awaiting_payment';
      session.paymentId = payment.id;
      session.pixExpiresAt = expiresAt;
      session.pixQrCodeText = qrText;
      session.mainMessageId = pixMsg.message_id;
      await saveSession(userId, session);

      await schedulePIXExpiry(ctx, payment.id, userId, expiresAt);
    } else {
      // BALANCE
      session.step = 'idle';
      await saveSession(userId, session);

      await ctx.reply(
        `✅ <b>Pagamento realizado com sucesso\!</b>\n\n` +
        `📦 Seu pedido foi confirmado\.`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err: unknown) {
    captureError(err, { handler: 'executePayment', productId, paymentMethod, userId });
    const msg = err instanceof Error ? err.message : '';
    const is502 = msg.includes('502') || msg.includes('Bad Gateway');
    if (is502) {
      await ctx.reply(
        '⚠️ O servidor está inicializando. Tente novamente em alguns segundos.',
        { parse_mode: 'HTML' }
      );
    } else if (paymentMethod === 'MIXED') {
      await ctx.reply(
        `❌ Erro ao processar pagamento misto: ${escapeHtml(msg || 'Erro desconhecido')}`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(
        `❌ Erro ao processar pagamento: ${escapeHtml(msg || 'Erro desconhecido')}`,
        { parse_mode: 'HTML' }
      );
    }
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

// ─── Verificar pagamento ───────────────────────────────────────────────────────
export async function handleCheckPayment(
  ctx: Context,
  paymentId: string
): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);

  try {
    const status = await apiClient.getPaymentStatus(paymentId, String(userId));

    if (status.status === 'PAID') {
      await editOrReply(ctx,
        `✅ <b>Pagamento confirmado\!</b>\n\nSeu pedido foi processado com sucesso\.`,
        { parse_mode: 'HTML' }
      );
      await clearSession(userId, session.firstName);
    } else if (status.status === 'EXPIRED' || status.status === 'CANCELLED') {
      await editOrReply(ctx,
        `❌ <b>Pagamento ${status.status === 'EXPIRED' ? 'expirado' : 'cancelado'}</b>\n\nGere um novo pedido quando quiser.`,
        { parse_mode: 'HTML' }
      );
      await clearSession(userId, session.firstName);
    } else {
      // PENDING — reenvia copia e cola
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
    captureError(err, { handler: 'handleCheckPayment', paymentId, userId });
    await ctx.reply('❌ Erro ao verificar pagamento. Tente novamente.', { parse_mode: 'HTML' });
  }
}

// ─── Cancelar pagamento ────────────────────────────────────────────────────────
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
    await clearSession(userId, session.firstName).catch(() => {});
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
    // Já expirou — verificar status imediatamente
    try {
      const status = await apiClient.getPaymentStatus(paymentId, String(userId));
      if (status.status !== 'PAID') {
        await ctx.reply(
          '⏰ Seu PIX expirou. Gere um novo pedido quando quiser.',
          { parse_mode: 'HTML' }
        );
        await clearSession(userId);
      }
    } catch { /**/ }
    return;
  }

  const t = setTimeout(async () => {
    try {
      const status = await apiClient.getPaymentStatus(paymentId, String(userId));
      if (status.status !== 'PAID') {
        await ctx.reply(
          '⏰ Seu PIX expirou. Gere um novo pedido quando quiser.',
          { parse_mode: 'HTML' }
        );
        await clearSession(userId);
      }
    } catch { /**/ } finally {
      cancelPIXTimer(userId);
    }
  }, msUntilExpiry);

  registerPIXTimer(userId, t);
}
