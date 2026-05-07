// paymentService.ts — suporte a qty > 1
// FIX-QTY: include order → orders; acessa payment.orders[0]; payment.product via include explícito
// FEAT-QTY2: entrega agrupada via deliverAllAsOne (1 mensagem com todos os itens)
// FIX-QTY3: confirmApproval distingue "reservar+criar orders" (BALANCE) de "só criar orders" (PIX/MIXED)
//           para não re-reservar StockItems que já foram reservados em _payWithPix
// FIX-QTY6: confirmApproval NÃO chama releaseReservation em caso de sucesso;
//           releaseReservation só é chamado quando entrega falha ou em expiração
// FIX-POOL1: reserveStock sequencial para não esgotar pool de conexões do Neon
// FIX-TIMEOUT1: _payWithBalance responde ao bot IMEDIATAMENTE após debitar saldo
//               e processa reservas+entrega em background (setImmediate)
//               para não estourar o timeout de 25s do bot em qty > 1
// FIX-BOT-SOURCE: botSource salvo no Payment e repassado ao deliverAllAsOne
//   'telegram' (ou null) → tenta enviar mensagem via Telegram antes de marcar entregue
//   'whatsapp'           → pula envio Telegram; bot busca conteúdo via GET /delivered-items
// FIX-POOL2: createOrdersOnly agora também é sequencial (Promise.all causava
//            'Unable to start a transaction in the given time' no Neon em qty > 1)
// FIX-POOL3: delay de 1s no início do setImmediate do _payWithBalance.
// FIX-UNIQUE-MPID: captura P2002 em _payWithPix/_payWithMixed/createDeposit e
//   lança AppError 409 em vez de crashar.
// FIX-EXT-REF: externalReference agora é `${telegramUserId}_${Date.now()}` — único
//   por tentativa. Antes era só o telegramUserId fixo: o MP detectava como duplicado
//   e retornava o mesmo mercadoPagoId do PIX anterior (mesmo cancelado), causando
//   P2002 unique constraint e o bot reutilizando um payment CANCELLED.
import { PaymentStatus, OrderStatus, StockItemStatus, WalletTransactionType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mercadoPagoService } from './mercadoPagoService';
import { deliveryService } from './deliveryService';
import { stockService } from './stockService';
import * as couponService from './couponService';
import { logger } from '../lib/logger';
import { AppError } from '../lib/AppError';
import { env } from '../config/env';

type ProductSnap = {
  id: string;
  name: string;
  price: import('@prisma/client').Prisma.Decimal;
  deliveryContent: string | null;
  stock: number | null;
};

const statusCacheTTL = 5_000;
const statusCache = new Map<string, { status: PaymentStatus; expiresAt: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Detecta erro de unique constraint do Prisma (P2002). */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

async function revertCoupon(paymentId: string): Promise<void> {
  try {
    await couponService.revertCoupon(paymentId);
  } catch (err) {
    logger.warn(`[revertCoupon] falhou para ${paymentId}:`, err);
  }
}

/**
 * Reserva N StockItems SEQUENCIALMENTE para não esgotar o pool de conexões do Neon.
 */
async function reserveStockSequential(
  productId: string,
  telegramUserId: string,
  paymentId: string,
  qty: number
): Promise<void> {
  for (let i = 0; i < qty; i++) {
    await stockService.reserveStock(productId, telegramUserId, paymentId);
  }
}

/**
 * Reserva N StockItems e cria N orders.
 * Usado em pagamentos BALANCE (aprovação imediata).
 */
async function reserveAndCreateOrders(
  telegramUserId: string,
  product: ProductSnap,
  qty: number,
  paymentId: string
): Promise<string[]> {
  await reserveStockSequential(product.id, telegramUserId, paymentId, qty);
  return createOrdersOnly(telegramUserId, product, qty, paymentId);
}

/**
 * Cria N orders SEQUENCIALMENTE, SEM reservar StockItems.
 * Usado em confirmApproval de pagamentos PIX/MIXED e entrega BALANCE background.
 */
async function createOrdersOnly(
  telegramUserId: string,
  product: ProductSnap,
  qty: number,
  paymentId: string
): Promise<string[]> {
  const orderIds: string[] = [];
  for (let i = 0; i < qty; i++) {
    const order = await prisma.order.create({
      data: {
        telegramUserId,
        paymentId,
        productId: product.id,
        status: OrderStatus.PROCESSING,
      },
      select: { id: true },
    });
    orderIds.push(order.id);
  }
  return orderIds;
}

/**
 * FIX-BOT-SOURCE: lê botSource do banco para o paymentId informado.
 */
async function getBotSource(paymentId: string): Promise<'telegram' | 'whatsapp'> {
  const p = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { botSource: true },
  });
  return (p?.botSource === 'whatsapp') ? 'whatsapp' : 'telegram';
}

/**
 * qty = 1 → deliver() normal
 * qty > 1 → deliverAllAsOne()
 */
async function deliverOrders(
  paymentId: string,
  orderIds: string[],
  telegramUser: import('@prisma/client').TelegramUser,
  product: import('@prisma/client').Product,
  botSource: 'telegram' | 'whatsapp'
): Promise<void> {
  if (orderIds.length === 1) {
    await deliveryService.deliver(orderIds[0], telegramUser, product, botSource);
  } else {
    await deliveryService.deliverAllAsOne(paymentId, telegramUser, product, orderIds, botSource);
  }
}

export const paymentService = {

  async _payWithBalance(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    amount: number;
    couponId?: string;
    referralCode?: string;
    botSource?: 'telegram' | 'whatsapp';
  }): Promise<{
    paymentId: string;
    paidWithBalance: true;
    productName: string;
    deliveryContent: string | null;
  }> {
    const { telegramUserId, product, qty, amount, couponId, referralCode, botSource } = opts;

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.telegramUser.findUnique({
        where: { id: telegramUserId },
        select: { id: true, balance: true },
      });
      if (!user || Number(user.balance) < amount) {
        throw new AppError('Saldo insuficiente.', 400);
      }
      const payment = await tx.payment.create({
        data: {
          telegramUserId,
          productId: product.id,
          amount,
          qty,
          status: PaymentStatus.APPROVED,
          paymentMethod: 'BALANCE',
          couponId: couponId ?? null,
          approvedAt: new Date(),
          botSource: botSource ?? null,
        },
      });
      await tx.telegramUser.update({
        where: { id: telegramUserId },
        data: { balance: { decrement: amount } },
      });
      await tx.walletTransaction.create({
        data: {
          telegramUserId,
          type: WalletTransactionType.PURCHASE,
          amount,
          description: `Compra: ${product.name} x${qty}`,
          paymentId: payment.id,
        },
      });
      return { payment };
    });

    const paymentId = result.payment.id;
    const resolvedBotSource = botSource ?? 'telegram';

    setImmediate(async () => {
      try {
        await sleep(1_000);
        const orderIds = await reserveAndCreateOrders(telegramUserId, product, qty, paymentId);
        const telegramUser = await prisma.telegramUser.findUniqueOrThrow({ where: { id: telegramUserId } });
        const productFull  = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
        await deliverOrders(paymentId, orderIds, telegramUser, productFull, resolvedBotSource);
      } catch (err) {
        logger.error(`[_payWithBalance] Erro na entrega background | pagamento=${paymentId}:`, err);
        await stockService.releaseReservation(paymentId).catch(() => {});
        if (resolvedBotSource === 'telegram') {
          try {
            const telegramUser = await prisma.telegramUser.findUnique({ where: { id: telegramUserId } });
            if (telegramUser) {
              const { telegramService } = await import('./telegramService');
              await telegramService.sendDeliveryError(telegramUser.telegramId);
            }
          } catch { /* não bloqueia */ }
        }
      }

      if (referralCode) {
        try {
          const referrer = await prisma.telegramUser.findFirst({
            where: { telegramId: referralCode },
            select: { id: true },
          });
          if (referrer) {
            const referral = await prisma.referral.findFirst({
              where: { referredId: telegramUserId, referrerId: referrer.id },
            });
            if (referral && !referral.rewardPaid) {
              const bonus = Number(product.price) * qty * 0.05;
              await prisma.telegramUser.update({
                where: { id: referrer.id },
                data: { balance: { increment: bonus } },
              });
              await prisma.walletTransaction.create({
                data: {
                  telegramUserId: referrer.id,
                  type: WalletTransactionType.REFERRAL_REWARD,
                  amount: bonus,
                  description: `Bônus indicação: ${product.name} x${qty}`,
                  paymentId,
                },
              });
              await prisma.referral.update({
                where: { id: referral.id },
                data: { rewardPaid: true },
              });
            }
          }
        } catch (err) {
          logger.warn('[_payWithBalance] Falha ao pagar bônus de indicação:', err);
        }
      }
    });

    return {
      paymentId,
      paidWithBalance: true,
      productName: product.name,
      deliveryContent: product.deliveryContent,
    };
  },

  async _payWithPix(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    amount: number;
    couponId?: string;
    firstName?: string;
    username?: string;
    botSource?: 'telegram' | 'whatsapp';
  }): Promise<{
    paymentId: string;
    pixQrCode: string;
    pixQrCodeText: string;
    amount: number;
    expiresAt: string;
    productName: string;
  }> {
    const { telegramUserId, product, qty, amount, couponId, firstName, username, botSource } = opts;
    let paymentId: string | undefined;
    try {
      const payerName = [firstName ?? 'Cliente', username ?? 'Telegram'].filter(Boolean).join(' ');

      // FIX-EXT-REF: referência única por tentativa — evita que o MP devolva o
      // mesmo mercadoPagoId de um PIX anterior (cancelado ou expirado).
      const externalReference = `${telegramUserId}_${Date.now()}`;

      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: amount,
        description: qty > 1 ? `${product.name} x${qty}` : product.name,
        payerName,
        externalReference,
        notificationUrl: `${env.API_URL}/webhooks/mercadopago`,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      let payment;
      try {
        payment = await prisma.payment.create({
          data: {
            telegramUserId,
            productId: product.id,
            amount,
            qty,
            status: PaymentStatus.PENDING,
            paymentMethod: 'PIX',
            mercadoPagoId: String(mpPayment.id),
            pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
            pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
            pixExpiresAt: expiresAt,
            couponId: couponId ?? null,
            botSource: botSource ?? null,
          },
        });
      } catch (createErr) {
        if (isUniqueConstraintError(createErr)) {
          logger.warn(`[_payWithPix] mercadoPagoId=${mpPayment.id} já existe — retornando payment existente`);
          const existing = await prisma.payment.findUnique({
            where: { mercadoPagoId: String(mpPayment.id) },
          });
          if (!existing) throw new AppError('Pagamento duplicado. Tente novamente.', 409);
          return {
            paymentId: existing.id,
            pixQrCode: existing.pixQrCode ?? '',
            pixQrCodeText: existing.pixQrCodeText ?? '',
            amount,
            expiresAt: (existing.pixExpiresAt ?? expiresAt).toISOString(),
            productName: qty > 1 ? `${product.name} x${qty}` : product.name,
          };
        }
        throw createErr;
      }

      paymentId = payment.id;
      await reserveStockSequential(product.id, telegramUserId, paymentId, qty);

      return {
        paymentId: payment.id,
        pixQrCode: payment.pixQrCode ?? '',
        pixQrCodeText: payment.pixQrCodeText ?? '',
        amount,
        expiresAt: expiresAt.toISOString(),
        productName: qty > 1 ? `${product.name} x${qty}` : product.name,
      };
    } catch (err) {
      if (paymentId) await stockService.releaseReservation(paymentId).catch(() => {});
      throw err;
    }
  },

  async _payWithMixed(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    totalAmount: number;
    balanceAmount: number;
    pixAmount: number;
    couponId?: string;
    firstName?: string;
    username?: string;
    botSource?: 'telegram' | 'whatsapp';
  }): Promise<{
    paymentId: string;
    pixQrCode: string;
    pixQrCodeText: string;
    amount: number;
    pixAmount: number;
    balanceUsed: number;
    expiresAt: string;
    productName: string;
  }> {
    const { telegramUserId, product, qty, totalAmount, balanceAmount, pixAmount, couponId, firstName, username, botSource } = opts;
    let paymentId: string | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        const user = await tx.telegramUser.findUnique({
          where: { id: telegramUserId },
          select: { balance: true },
        });
        if (!user || Number(user.balance) < balanceAmount) {
          throw new AppError('Saldo insuficiente para pagamento misto.', 400);
        }
        await tx.telegramUser.update({
          where: { id: telegramUserId },
          data: { balance: { decrement: balanceAmount } },
        });
        await tx.walletTransaction.create({
          data: {
            telegramUserId,
            type: WalletTransactionType.PURCHASE,
            amount: balanceAmount,
            description: `Reserva saldo (misto): ${product.name} x${qty}`,
          },
        });
      });

      const payerName = [firstName ?? 'Cliente', username ?? 'Telegram'].filter(Boolean).join(' ');

      // FIX-EXT-REF: referência única por tentativa
      const externalReference = `${telegramUserId}_${Date.now()}`;

      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: pixAmount,
        description: qty > 1 ? `${product.name} x${qty}` : product.name,
        payerName,
        externalReference,
        notificationUrl: `${env.API_URL}/webhooks/mercadopago`,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      let payment;
      try {
        payment = await prisma.payment.create({
          data: {
            telegramUserId,
            productId: product.id,
            amount: totalAmount,
            qty,
            pixAmount,
            balanceUsed: balanceAmount,
            status: PaymentStatus.PENDING,
            paymentMethod: 'MIXED',
            mercadoPagoId: String(mpPayment.id),
            pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
            pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
            pixExpiresAt: expiresAt,
            couponId: couponId ?? null,
            botSource: botSource ?? null,
          },
        });
      } catch (createErr) {
        if (isUniqueConstraintError(createErr)) {
          logger.warn(`[_payWithMixed] mercadoPagoId=${mpPayment.id} já existe — retornando payment existente`);
          const existing = await prisma.payment.findUnique({
            where: { mercadoPagoId: String(mpPayment.id) },
          });
          if (!existing) throw new AppError('Pagamento duplicado. Tente novamente.', 409);
          return {
            paymentId: existing.id,
            pixQrCode: existing.pixQrCode ?? '',
            pixQrCodeText: existing.pixQrCodeText ?? '',
            amount: totalAmount,
            pixAmount,
            balanceUsed: balanceAmount,
            expiresAt: (existing.pixExpiresAt ?? expiresAt).toISOString(),
            productName: qty > 1 ? `${product.name} x${qty}` : product.name,
          };
        }
        throw createErr;
      }

      paymentId = payment.id;
      await reserveStockSequential(product.id, telegramUserId, paymentId, qty);

      return {
        paymentId: payment.id,
        pixQrCode: payment.pixQrCode ?? '',
        pixQrCodeText: payment.pixQrCodeText ?? '',
        amount: totalAmount,
        pixAmount,
        balanceUsed: balanceAmount,
        expiresAt: expiresAt.toISOString(),
        productName: qty > 1 ? `${product.name} x${qty}` : product.name,
      };
    } catch (err) {
      try {
        await prisma.telegramUser.update({
          where: { id: telegramUserId },
          data: { balance: { increment: balanceAmount } },
        });
      } catch {}
      if (paymentId) await stockService.releaseReservation(paymentId).catch(() => {});
      throw err;
    }
  },

  async createPayment(opts: {
    telegramId: string;
    productId: string;
    qty?: number;
    firstName?: string;
    username?: string;
    paymentMethod?: string;
    couponCode?: string;
    referralCode?: string;
    botSource?: 'telegram' | 'whatsapp';
  }) {
    const { telegramId, productId, firstName, username, paymentMethod = 'PIX', couponCode, referralCode, botSource } = opts;
    const qty = Math.max(1, Math.min(opts.qty ?? 1, 100));

    const [product, user] = await Promise.all([
      prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, price: true, deliveryContent: true, stock: true },
      }),
      prisma.telegramUser.upsert({
        where: { telegramId },
        update: { firstName: firstName ?? undefined, username: username ?? undefined },
        create: { telegramId, firstName: firstName ?? '', username: username ?? null },
        select: { id: true },
      }),
    ]);

    if (!product) throw new AppError('Produto não encontrado.', 404);

    const telegramUserId = user.id;
    const baseAmount = Number(product.price) * qty;

    let couponId: string | undefined;
    let couponDiscount = 0;
    if (couponCode) {
      try {
        const result = await couponService.validateCoupon(couponCode, telegramId, baseAmount, productId);
        if (!result.valid || !result.couponId) throw new Error(result.error ?? 'Cupom inválido.');
        couponId = result.couponId;
        couponDiscount = result.discountAmount ?? 0;
      } catch {
        throw new AppError('Cupom inválido ou expirado.', 400);
      }
    }

    const totalAmount = Math.max(0, baseAmount - couponDiscount);

    if (paymentMethod === 'BALANCE') {
      const result = await this._payWithBalance({ telegramUserId, product, qty, amount: totalAmount, couponId, referralCode, botSource });
      return { ...result, amount: totalAmount };
    }

    if (paymentMethod === 'PIX') {
      return this._payWithPix({ telegramUserId, product, qty, amount: totalAmount, couponId, firstName, username, botSource });
    }

    const userData = await prisma.telegramUser.findUnique({ where: { id: telegramUserId }, select: { balance: true } });
    const balanceAmount = Math.min(Number(userData?.balance ?? 0), totalAmount);
    const pixAmount = Math.max(0, totalAmount - balanceAmount);

    if (pixAmount <= 0) {
      const result = await this._payWithBalance({ telegramUserId, product, qty, amount: totalAmount, couponId, referralCode, botSource });
      return { ...result, amount: totalAmount };
    }

    return this._payWithMixed({ telegramUserId, product, qty, totalAmount, balanceAmount, pixAmount, couponId, firstName, username, botSource });
  },

  async createDeposit(opts: {
    telegramId: string;
    amount: number;
    firstName?: string;
    username?: string;
  }): Promise<{
    paymentId: string;
    pixQrCode: string;
    pixQrCodeText: string;
    amount: number;
    expiresAt: string;
  }> {
    const { telegramId, amount, firstName, username } = opts;

    const user = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName: firstName ?? undefined, username: username ?? undefined },
      create: { telegramId, firstName: firstName ?? '', username: username ?? null },
      select: { id: true },
    });

    const payerName = [firstName ?? 'Cliente', username ?? 'Telegram'].filter(Boolean).join(' ');

    // FIX-EXT-REF: referência única por tentativa de depósito
    const externalReference = `deposit_${telegramId}_${Date.now()}`;

    const mpPayment = await mercadoPagoService.createPixPayment({
      transactionAmount: amount,
      description: 'Depósito de saldo',
      payerName,
      externalReference,
      notificationUrl: `${env.API_URL}/webhooks/mercadopago`,
    });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    let payment;
    try {
      payment = await prisma.payment.create({
        data: {
          telegramUserId: user.id,
          productId: null,
          amount,
          status: PaymentStatus.PENDING,
          paymentMethod: 'PIX',
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
          pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
          pixExpiresAt: expiresAt,
        },
      });
    } catch (createErr) {
      if (isUniqueConstraintError(createErr)) {
        logger.warn(`[createDeposit] mercadoPagoId=${mpPayment.id} já existe — retornando payment existente`);
        const existing = await prisma.payment.findUnique({
          where: { mercadoPagoId: String(mpPayment.id) },
        });
        if (!existing) throw new AppError('Depósito duplicado. Tente novamente.', 409);
        return {
          paymentId: existing.id,
          pixQrCode: existing.pixQrCode ?? '',
          pixQrCodeText: existing.pixQrCodeText ?? '',
          amount,
          expiresAt: (existing.pixExpiresAt ?? expiresAt).toISOString(),
        };
      }
      throw createErr;
    }

    return {
      paymentId: payment.id,
      pixQrCode: payment.pixQrCode ?? '',
      pixQrCodeText: payment.pixQrCodeText ?? '',
      amount,
      expiresAt: expiresAt.toISOString(),
    };
  },

  async getPaymentStatus(paymentId: string) {
    const cached = statusCache.get(paymentId);
    if (cached && cached.expiresAt > Date.now()) return { status: cached.status };

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    });
    if (!payment) throw new AppError('Pagamento não encontrado.', 404);

    statusCache.set(paymentId, { status: payment.status, expiresAt: Date.now() + statusCacheTTL });
    return { status: payment.status };
  },

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; message: string }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    });
    if (!payment) return { cancelled: false, message: 'Pagamento não encontrado.' };
    if (payment.status !== PaymentStatus.PENDING) {
      return { cancelled: false, message: 'Apenas pagamentos pendentes podem ser cancelados.' };
    }
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });
    await stockService.releaseReservation(paymentId).catch(() => {});
    await revertCoupon(paymentId);
    return { cancelled: true, message: 'Pagamento cancelado com sucesso.' };
  },

  async confirmApproval(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        telegramUserId: true,
        productId: true,
        qty: true,
        paymentMethod: true,
        botSource: true,
      },
    });

    if (!payment || !payment.productId) {
      logger.warn(`[confirmApproval] Pagamento ${paymentId} não encontrado ou sem produto.`);
      return;
    }

    const telegramUser = await prisma.telegramUser.findUniqueOrThrow({
      where: { id: payment.telegramUserId },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: payment.productId },
    });

    const qty = payment.qty ?? 1;
    const resolvedBotSource: 'telegram' | 'whatsapp' =
      payment.botSource === 'whatsapp' ? 'whatsapp' : 'telegram';

    try {
      let orderIds: string[];

      if (payment.paymentMethod === 'BALANCE') {
        orderIds = await reserveAndCreateOrders(payment.telegramUserId, product, qty, paymentId);
      } else {
        orderIds = await createOrdersOnly(payment.telegramUserId, product, qty, paymentId);
      }

      await deliverOrders(paymentId, orderIds, telegramUser, product, resolvedBotSource);
    } catch (err) {
      logger.error(`[confirmApproval] Entrega falhou para pagamento=${paymentId}:`, err);
      await stockService.releaseReservation(paymentId).catch(() => {});
      if (resolvedBotSource === 'telegram') {
        try {
          const { telegramService } = await import('./telegramService');
          await telegramService.sendDeliveryError(telegramUser.telegramId);
        } catch { /* não bloqueia */ }
      }
    }
  },
};
