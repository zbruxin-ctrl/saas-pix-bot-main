/**
 * Handlers de pagamento: seleção de produto, execução de pagamento (PIX/Saldo/Misto),
 * verificação de status, cancelamento e timeout de PIX.
 *
 * PADRÃO: parse_mode HTML em mensagens de texto.
 *         parse_mode MarkdownV2 APENAS em captions de replyWithPhoto.
 *
 * TIPAGEM: todas as funções exportadas recebem Context (telegraf) —
 *          BotContext é apenas alias para Context; NarrowedContext nos handlers
 *          de ação é feito pelo Telegraf automaticamente ao registrar bot.action.
 *          Aqui aceitamos Context genérico pois as funções são chamadas tanto
 *          de bot.action quanto de bot.command.
 *
 * VARREDURA-FIX #10: showQuantityScreen usa availableStock (já descontado de reservas)
 *                    em vez de product.stock bruto.
 * FIX #1: markCouponUsed chamado com (userId, couponCode) — assinatura correta.
 * FIX #2: releaseLock recebe o token UUID retornado por acquireLock.
 * FIX #8: applyCoupon chamado após createPayment quando há cupom pendente.
 */
import { Context, Markup } from 'telegraf';
import { apiClient } from '../services/apiClient';
import { getSession, saveSession, clearSession, markCouponUsed } from '../services/session';
import { acquireLock, releaseLock } from '../services/locks';
import { applyCoupon } from '../services/couponClient';

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

/**
 * Tenta editar a mensagem atual (se vier de callback) ou envia nova mensagem.
 * Silencia o erro "message is not modified" do Telegram (400 com essa descrição)
 * e qualquer outro erro de edição — nesse caso cai no reply normal.
 */
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

export function initPaymentHandlers(): void {
  // placeholder — handlers registrados no index.ts
}

// ─── PIX timers ──────────────────────────────────────────────────────────────

const pixTimers = new Map<number, ReturnType<typeof setTimeout>>();

function registerPIXTimer(userId: number, t: ReturnType<typeof setTimeout>): void {
  cancelPIXTimer(userId);
  pixTimers.set(userId, t);
}

export function cancelPIXTimer(userId: number): void {
  const existing = pixTimers.get(userId);
  if (existing !== undefined) {
    clearTimeout(existing);
    pixTimers.delete(userId);
  }
}

// ─── Helpers de entrega ──────────────────────────────────────────────────────

function buildDeliveryMessage(
  productName: string,
  deliveryContent?: string | null
): string {
  const header = `✅ <b>Pagamento confirmado!</b>\n\n📦 <b>${escapeHtml(productName)}</b>\n`;

  if (deliveryContent && deliveryContent.trim().length > 0) {
    return (
      header +
      `\n🎁 <b>Seu produto:</b>\n` +
      `<pre>${escapeHtml(deliveryContent.trim())}</pre>\n\n` +
      `<i>Guarde essa mensagem em local seguro.</i>`
    );
  }

  return (
    header +
    `\n✔️ Seu pedido foi processado com sucesso.\n` +
    `<i>Em caso de dúvidas, acesse /ajuda.</i>`
  );
}

function afterPurchaseKeyboard(productId?: string): ReturnType<typeof Markup.inlineKeyboard> {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (productId) {
    rows.push([Markup.button.callback('🔄 Comprar Novamente', `select_product_${productId}`)]);
  }
  rows.push([Markup.button.callback('🏠 Menu Principal', 'show_home')]);
  return Markup.inlineKeyboard(rows);
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

  // VARREDURA-FIX #10: usa availableStock (já descontado de reservas pendentes)
  // em vez de product.stock bruto que não reflete reservas em aberto.
  const effectiveStock = product.availableStock ?? product.stock;
  const maxStock = effectiveStock != null ? effectiveStock : Infinity;
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
  const stockLine = effectiveStock != null && effectiveStock <= 5
    ? `\n⚠️ <b>Apenas ${effectiveStock} em estoque!</b>` : '';

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

  const effectiveStock = product.availableStock ?? product.stock;
  const stockLine = (() => {
    if (effectiveStock == null) return '';
    if (effectiveStock <= 0) return `\n⚠️ <b>Esgotado!</b>`;
    if (effectiveStock <= 5) return `\n⚠️ <b>Apenas ${effectiveStock} em estoque!</b>`;
    return '';
  })();

  const couponLine = session.pendingCoupon
    ? `\n🏷️ <b>Cupom:</b> <code>${escapeHtml(session.pendingCoupon)}</code> (-R$ ${couponDiscount.toFixed(2)})` : '';

  const qtyLine = qty > 1
    ? `\n🔢 <b>Quantidade:</b> ${qty}x` : '';

  const canPayBalance = balance >= price;
  const canPayMixed   = balance > 0 && balance < price;

  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  buttons.push([
    Markup.button.callback(
      `💳 PIX — R$ ${price.toFixed(2)}`,
      `pay_pix_${product.id}`
    ),
  ]);

  if (canPayBalance) {
    buttons.push([
      Markup.button.callback(
        `💰 Saldo (R$ ${balance.toFixed(2)}) — Pagar R$ ${price.toFixed(2)}`,
        `pay_balance_${product.id}`
      ),
    ]);
  }

  if (canPayMixed) {
    const pixPart = (price - balance).toFixed(2);
    buttons.push([
      Markup.button.callback(
        `🔀 Misto — Saldo R$ ${balance.toFixed(2)} + PIX R$ ${pixPart}`,
        `pay_mixed_${product.id}`
      ),
    ]);
  }

  if (!session.pendingCoupon) {
    buttons.push([
      Markup.button.callback('🏷️ Usar Cupom', `coupon_input_${product.id}`),
    ]);
  } else {
    buttons.push([
      Markup.button.callback('❌ Remover Cupom', `remove_coupon_${product.id}`),
    ]);
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
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  session.step = 'awaiting_coupon';
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

  // FIX #2: acquireLock retorna token UUID — deve ser passado ao releaseLock
  const lockToken = await acquireLock(String(userId));
  if (!lockToken) {
    await ctx.reply('⏳ Aguarde, processando pagamento anterior...', { parse_mode: 'HTML' });
    return;
  }

  try {
    const session = await getSession(userId);
    const firstName = ctx.from!.first_name;
    const username  = ctx.from!.username;
    const pendingCoupon = session.pendingCoupon ?? undefined;

    await editOrReply(ctx, '⏳ <b>Processando pagamento...</b>', { parse_mode: 'HTML' });

    const payment = await apiClient.createPayment({
      telegramId: String(userId),
      productId,
      firstName,
      username,
      paymentMethod: method,
      couponCode: pendingCoupon,
      referralCode: session.referralCode ?? undefined,
    });

    // FIX #8: notifica o backend que o cupom foi aplicado a este pagamento
    if (pendingCoupon && payment.paymentId) {
      try {
        // couponClient.validateCoupon retorna o couponId via data.couponId
        // Aqui já temos o paymentId confirmado — chamamos applyCoupon
        // O couponId não está disponível diretamente aqui; usamos o código como fallback
        await applyCoupon(pendingCoupon, String(userId), payment.paymentId);
      } catch {
        // Não bloqueia a compra se o apply falhar — o backend já registrou via createPayment
      }
    }

    if (payment.paidWithBalance) {
      // FIX #1: markCouponUsed recebe (userId, couponCode) — assinatura correta
      if (pendingCoupon) await markCouponUsed(userId, pendingCoupon);
      await clearSession(userId, firstName);
      await ctx.reply(
        buildDeliveryMessage(payment.productName ?? productId),
        {
          parse_mode: 'HTML',
          reply_markup: afterPurchaseKeyboard(productId).reply_markup,
        }
      );
      return;
    }

    // PIX ou MIXED — aguarda confirmação
    const expiresAt = payment.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const qrText    = payment.pixQrCodeText ?? '';
    const qrImage   = payment.pixQrCode ?? '';

    session.step         = 'awaiting_payment';
    session.paymentId    = payment.paymentId;
    session.pixExpiresAt = expiresAt;
    session.pixQrCodeText = qrText;
    // FIX #1: markCouponUsed recebe (userId, couponCode) — assinatura correta
    if (pendingCoupon) await markCouponUsed(userId, pendingCoupon);
    await saveSession(userId, session);

    const amountStr = String((payment.amount ?? 0).toFixed(2)).replace('.', '\\.');
    const balanceStr = payment.balanceUsed && payment.balanceUsed > 0
      ? `\nSaldo usado: R\\$ ${String(payment.balanceUsed.toFixed(2)).replace('.', '\\.')}\n*PIX:* R\\$ ${String((payment.pixAmount ?? payment.amount ?? 0).toFixed(2)).replace('.', '\\.')}`
      : '';

    if (qrImage) {
      await ctx.replyWithPhoto(
        { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrText)}` },
        {
          caption:
            `💳 *PIX gerado\!*\n\n` +
            `*Total:* R\\$ ${amountStr}${balanceStr}\n\n` +
            `Escaneie o QR ou copie o código abaixo:`,
          parse_mode: 'MarkdownV2',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
            [Markup.button.callback('❌ Cancelar PIX',        `cancel_payment_${payment.paymentId}`)],
          ]).reply_markup,
        }
      );
    } else {
      await ctx.reply(
        `💳 <b>PIX gerado!</b>\n\nTotal: R$ ${(payment.amount ?? 0).toFixed(2)}\n\nCopie o código abaixo:`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${payment.paymentId}`)],
            [Markup.button.callback('❌ Cancelar PIX',        `cancel_payment_${payment.paymentId}`)],
          ]).reply_markup,
        }
      );
    }
    await ctx.reply(`<code>${qrText}</code>`, { parse_mode: 'HTML' });
    await schedulePIXExpiry(ctx, payment.paymentId, userId, expiresAt);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    console.error('[executePayment] erro:', err);
    await ctx.reply(`❌ ${escapeHtml(msg)}`, { parse_mode: 'HTML' });
  } finally {
    // FIX #2: passa o lockToken para releaseLock verificar ownership antes de deletar
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
    const status = await apiClient.getPaymentStatus(paymentId, String(userId));

    if (status.status === 'APPROVED') {
      cancelPIXTimer(userId);
      await clearSession(userId, firstName);
      await ctx.reply(
        buildDeliveryMessage(
          status.productName ?? 'seu produto',
          status.deliveryContent
        ),
        {
          parse_mode: 'HTML',
          reply_markup: afterPurchaseKeyboard().reply_markup,
        }
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

export async function handleCancelPayment(
  ctx: Context,
  paymentId: string
): Promise<void> {
  try {
    const userId    = ctx.from!.id;
    const firstName = ctx.from!.first_name;
    const result = await apiClient.cancelPayment(paymentId, String(userId));
    cancelPIXTimer(userId);
    await clearSession(userId, firstName);

    if (result.cancelled) {
      await ctx.reply(
        `✅ PIX cancelado com sucesso. Use /produtos para fazer um novo pedido.`,
        { parse_mode: 'HTML' }
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

  const timer = setTimeout(async () => {
    try {
      const session = await getSession(userId);
      if (session.paymentId !== paymentId) return;
      const firstName = session.firstName ?? '';
      cancelPIXTimer(userId);
      await clearSession(userId, firstName);
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
