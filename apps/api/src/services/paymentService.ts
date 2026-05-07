// paymentService.ts — suporte a qty > 1
// FIX-QTY: include order → orders; acessa payment.orders[0]; payment.product via include explícito
// FEAT-QTY2: entrega agrupada via deliverAllAsOne (1 mensagem com todos os itens)
// FIX-QTY3: confirmApproval distingue "reservar+criar orders" (BALANCE) de "só criar orders" (PIX/MIXED)
//           para não re-reservar StockItems que já foram reservados em _payWithPix
// FIX-QTY6: confirmApproval NÃO chama releaseReservation em caso de sucesso;
//           releaseReservation só é chamado quando entrega falha ou em expiração
// PERF-QTY7: reserveStock e createOrders paralelizados com Promise.all + createMany
//            para evitar timeout em qty > 1 (cada reserveStock era ~200-500ms sequential)
// FIX-POOL1: reserveStock de volta a sequencial para não esgotar pool de conexões do Neon
//            (Promise.all com qty=6 abria 6 transações simultâneas → "Unable to start a transaction")
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

async function revertCoupon(paymentId: string): Promise<void> {
  try {
    await couponService.revertCoupon(paymentId);
  } catch (err) {
    logger.warn(`[revertCoupon] falhou para ${paymentId}:`, err);
  }
}

/**
 * Reserva N StockItems SEQUENCIALMENTE para não esgotar o pool de conexões do Neon.
 * FIX-POOL1: Promise.all com qty=6 abria 6 transações simultâneas causando
 *            "Unable to start a transaction in the given time".
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
 * Cria N orders de uma vez com Promise.all, SEM reservar StockItems.
 * Usado em confirmApproval de pagamentos PIX/MIXED, onde os StockItems
 * já foram reservados no momento da criação do PIX (_payWithPix / _payWithMixed).
 */
async function createOrdersOnly(
  telegramUserId: string,
  product: ProductSnap,
  qty: number,
  paymentId: string
): Promise<string[]> {
  const orders = await Promise.all(
    Array.from({ length: qty }, () =>
      prisma.order.create({
        data: {
          telegramUserId,
          paymentId,
          productId: product.id,
          status: OrderStatus.PROCESSING,
        },
        select: { id: true },
      })
    )
  );
  return orders.map((o) => o.id);
}

/**
 * qty = 1 → deliver() normal (1 mensagem simples)
 * qty > 1 → deliverAllAsOne() (1 mensagem com todos os itens listados)
 */
async function deliverOrders(
  paymentId: string,
  orderIds: string[],
  telegramUser: import('@prisma/client').TelegramUser,
  product: import('@prisma/client').Product
): Promise<void> {
  if (orderIds.length === 1) {
    await deliveryService.deliver(orderIds[0], telegramUser, product);
  } else {
    await deliveryService.deliverAllAsOne(paymentId, telegramUser, product, orderIds);
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
  }): Promise<{
    paymentId: string;
    paidWithBalance: true;
    productName: string;
    deliveryContent: string | null;
  }> {
    const { telegramUserId, product, qty, amount, couponId, referralCode } = opts;
    let paymentId: string | undefined;

    try {
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

      paymentId = result.payment.id;

      // FIX-POOL1: reservas sequenciais para não esgotar pool do Neon
      const orderIds = await reserveAndCreateOrders(telegramUserId, product, qty, paymentId);
      const telegramUser = await prisma.telegramUser.findUniqueOrThrow({ where: { id: telegramUserId } });
      const productFull = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      await deliverOrders(paymentId, orderIds, telegramUser, productFull);

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
                  paymentId: paymentId,
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
    } catch (err) {
      if (paymentId) await stockService.releaseReservation(paymentId).catch(() => {});
      throw err;
    }

    return {
      paymentId: paymentId!,
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
  }): Promise<{
    paymentId: string;
    pixQrCode: string;
    pixQrCodeText: string;
    amount: number;
    expiresAt: string;
    productName: string;
  }> {
    const { telegramUserId, product, qty, amount, couponId, firstName, username } = opts;
    let paymentId: string | undefined;
    try {
      const payerName = [firstName ?? 'Cliente', username ?? 'Telegram'].filter(Boolean).join(' ');
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: amount,
        description: qty > 1 ? `${product.name} x${qty}` : product.name,
        payerName,
        externalReference: telegramUserId,
        notificationUrl: `${env.API_URL}/webhooks/mercadopago`,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const payment = await prisma.payment.create({
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
        },
      });

      paymentId = payment.id;
      // FIX-POOL1: reservas sequenciais para não esgotar pool do Neon
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
    const { telegramUserId, product, qty, totalAmount, balanceAmount, pixAmount, couponId, firstName, username } = opts;
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
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: pixAmount,
        description: qty > 1 ? `${product.name} x${qty}` : product.name,
        payerName,
        externalReference: telegramUserId,
        notificationUrl: `${env.API_URL}/webhooks/mercadopago`,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const payment = await prisma.payment.create({
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
        },
      });

      paymentId = payment.id;
      // FIX-POOL1: reservas sequenciais para não esgotar pool do Neon
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
  }) {
    const { telegramId, productId, firstName, username, paymentMethod = 'PIX', couponCode, referralCode } = opts;
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
      const result = await this._payWithBalance({ telegramUserId, product, qty, amount: totalAmount, couponId, referralCode });
      return { ...result, amount: totalAmount };
    }

    if (paymentMethod === 'PIX') {
      return this._payWithPix({ telegramUserId, product, qty, amount: totalAmount, couponId, firstName, username });
    }

    const userData = await prisma.telegramUser.findUnique({ where: { id: telegramUserId }, select: { balance: true } });
    const balanceAmount = Math.min(Number(userData?.balance ?? 0), totalAmount);
    const pixAmount = Math.max(0, totalAmount - balanceAmount);

    if (pixAmount <= 0) {
      const result = await this._payWithBalance({ telegramUserId, product, qty, amount: totalAmount, couponId, referralCode });
      return { ...result, amount: totalAmount };
    }

    return this._payWithMixed({ telegramUserId, product, qty, totalAmount, balanceAmount, pixAmount, couponId, firstName, username });
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
    const mpPayment = await mercadoPagoService.createPixPayment({
      transactionAmount: amount,
      description: 'Depósito de saldo',
      payerName,
      externalReference: `deposit_${telegramId}`,
      notificationUrl: `${env.API_URL}/webhooks/mercadopago`,
    });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const payment = await prisma.payment.create({
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

    return {
      paymentId: payment.id,
      pixQrCode: payment.pixQrCode ?? '',
      pixQrCodeText: payment.pixQrCodeText ?? '',
      amount,
      expiresAt: expiresAt.toISOString(),
    };
  },

  async confirmApproval(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true, product: true, orders: true },
    });

    if (!payment) {
      logger.warn(`[confirmApproval] Pagamento não encontrado: ${paymentId}`);
      return;
    }

    if (payment.approvedAt) {
      logger.info(`[confirmApproval] Pagamento já aprovado: ${paymentId}`);
      return;
    }

    if (!payment.product || !payment.productId) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });
        await tx.telegramUser.update({
          where: { id: payment.telegramUserId },
          data: { balance: { increment: Number(payment.amount) } },
        });
        await tx.walletTransaction.create({
          data: {
            telegramUserId: payment.telegramUserId,
            type: WalletTransactionType.DEPOSIT,
            amount: Number(payment.amount),
            description: 'Depósito via PIX',
            paymentId,
          },
        });
      });
      statusCache.delete(paymentId);
      return;
    }

    const product = payment.product;
    const telegramUser = payment.telegramUser;
    const qty: number = (payment as any).qty ?? 1;

    let deliverySucceeded = false;
    try {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
      });

      let existingOrders = payment.orders;

      if (existingOrders.length === 0) {
        // PIX/MIXED: StockItems já foram reservados em _payWithPix/_payWithMixed.
        // Aqui só criamos os orders em paralelo, SEM re-reservar.
        const orderIds = await createOrdersOnly(telegramUser.id, product, qty, paymentId);
        existingOrders = await prisma.order.findMany({ where: { id: { in: orderIds } } });
      } else {
        await prisma.order.updateMany({
          where: { paymentId },
          data: { status: OrderStatus.PROCESSING },
        });
      }

      const orderIds = existingOrders.map((o) => o.id);
      await deliverOrders(paymentId, orderIds, telegramUser, product);
      deliverySucceeded = true;

      statusCache.delete(paymentId);
    } catch (err) {
      logger.error(`[confirmApproval] Erro na entrega do pagamento ${paymentId}:`, err);
      await stockService.releaseReservation(paymentId).catch(() => {});
      throw err;
    }
  },

  processApprovedPayment(paymentId: string): Promise<void> {
    return this.confirmApproval(paymentId);
  },

  async handleMercadoPagoWebhook(data: { action?: string; data?: { id?: string } }): Promise<void> {
    if (data.action !== 'payment.updated' && data.action !== 'payment.created') return;
    const mpId = data.data?.id;
    if (!mpId) return;

    setImmediate(async () => {
      try {
        const payment = await prisma.payment.findFirst({
          where: { mercadoPagoId: mpId },
          select: { id: true, status: true, amount: true },
        });

        if (!payment) {
          logger.warn(`[webhook] Pagamento não encontrado para mercadoPagoId: ${mpId}`);
          return;
        }

        if (payment.status !== PaymentStatus.PENDING) {
          logger.info(`[webhook] Pagamento ${payment.id} já processado (status: ${payment.status})`);
          return;
        }

        const { isApproved } = await mercadoPagoService.verifyPayment(mpId, Number(payment.amount));

        if (!isApproved) {
          logger.info(`[webhook] Pagamento ${mpId} ainda não aprovado.`);
          return;
        }

        await paymentService.confirmApproval(payment.id);
      } catch (err) {
        logger.error('[webhook] Erro ao processar webhook:', err);
      }
    });
  },

  async findExpiredPaymentIds(now: Date): Promise<string[]> {
    const payments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        pixExpiresAt: { lt: now },
      },
      select: { id: true },
    });
    return payments.map((p) => p.id);
  },

  async cancelExpiredPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, mercadoPagoId: true },
    });

    if (!payment || payment.status !== PaymentStatus.PENDING) return;

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.EXPIRED, expiredAt: new Date() },
    });

    await stockService.releaseReservation(paymentId).catch(() => {});
    await revertCoupon(paymentId);

    if (payment.mercadoPagoId) {
      mercadoPagoService.refundPayment(payment.mercadoPagoId).catch((err) =>
        logger.warn(`[cancelExpiredPayment] Falha ao cancelar PIX no MP: ignorado`, err)
      );
    }

    statusCache.delete(paymentId);
  },

  async getPaymentStatus(paymentId: string): Promise<{
    status: PaymentStatus;
    approvedAt?: string;
    productName?: string;
    deliveryContent?: string | null;
  }> {
    const now = Date.now();
    const cached = statusCache.get(paymentId);
    if (cached && cached.expiresAt > now) {
      return { status: cached.status };
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        status: true,
        approvedAt: true,
        pixExpiresAt: true,
        mercadoPagoId: true,
        productId: true,
        product: { select: { name: true, deliveryContent: true } },
      },
    });

    if (!payment) throw new AppError('Pagamento não encontrado.', 404);

    let status = payment.status;

    if (status === PaymentStatus.PENDING && payment.pixExpiresAt && payment.pixExpiresAt < new Date()) {
      status = PaymentStatus.EXPIRED;
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.EXPIRED, expiredAt: new Date() },
      });
      await stockService.releaseReservation(paymentId).catch(() => {});
      await revertCoupon(paymentId);
      if (payment.mercadoPagoId) {
        mercadoPagoService.refundPayment(payment.mercadoPagoId).catch(() => {});
      }
    }

    statusCache.set(paymentId, { status, expiresAt: now + statusCacheTTL });
    return {
      status,
      ...(payment.approvedAt ? { approvedAt: payment.approvedAt.toISOString() } : {}),
      ...(status === PaymentStatus.APPROVED && payment.product
        ? {
            productName: payment.product.name ?? undefined,
            deliveryContent: payment.product.deliveryContent ?? null,
          }
        : {}),
    };
  },

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; message?: string }> {
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId },
      select: { status: true, mercadoPagoId: true },
    });

    if (!payment) {
      return { cancelled: false, message: 'Pagamento não encontrado.' };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return { cancelled: false, message: `Pagamento não pode ser cancelado (status: ${payment.status}).` };
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });

    await stockService.releaseReservation(paymentId).catch(() => {});
    await revertCoupon(paymentId);

    if (payment.mercadoPagoId) {
      mercadoPagoService.refundPayment(payment.mercadoPagoId).catch(() => {});
    }

    statusCache.delete(paymentId);
    return { cancelled: true };
  },

  async getAvailableStock(productId: string): Promise<number | null> {
    const items = await prisma.stockItem.count({
      where: { productId, status: StockItemStatus.AVAILABLE },
    });
    return items;
  },
};
