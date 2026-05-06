// paymentService.ts
// FIX BUG3: reserva+confirmação+deduct do saldo em prisma.$transaction única
// FIX BUG4: guard mercadoPagoId null antes de verifyPayment
// FIX BUG5: usa expiredAt em vez de cancelledAt para EXPIRED
// FIX BUG6: novo produto recebe sortOrder = MAX(sortOrder)+1
// FIX BUG10: createPayment serializado por telegramId p/ evitar concorrência
// FIX BUG12: estoque reservado antes de criar payment no MP
// FIX BUG14: _payWithPix aceita couponCode e desconta no amount
// FIX BUG15: mixed payment via PIX
// OPT #1: usa transação Prisma p/ confirmar pagamento e criar order/delivery atomicamente
// OPT #2: deduz saldo em transação atômica p/ evitar race condition
// OPT #3: batch select (product + user + stock) antes de criar o pagamento
// OPT #4: _confirmApproval extrai lógica de confirmação, reutilizado no webhook
// OPT #5: índice implícito em mercadoPagoId para busca rápida no webhook
// OPT #6: getPaymentStatus com cache em memória TTL 5s
// OPT #7: webhook processa em background (res.sendStatus(200) imediato)
// OPT #8: confirmApproval deduplica via payment.approvedAt (idempotente)
// FIX-WEBHOOK: handleMercadoPagoWebhook exportado e registrado na rota POST /webhook
// FIX-COUPON-VALIDATION: validateCoupon recebe productId para validar restrições por produto
// FEAT-REFERRAL-BONUS: crédito de bônus de indicação aplicado ao confirmar pagamento
// FIX-MIXED-COUPON: desconto do cupom aplicado ao pixAmount no pagamento misto
// FIX-STOCK-CONFIRM: confirmApproval usa deliveryService.deliverStock (sem product.type hardcoded)
// FIX-PIX-AMOUNT: pixAmount calculado apenas sobre a parte PIX (não sobre o total)
// VARREDURA-FIX #1: _payWithPix não usa mais couponDiscount undefined
// VARREDURA-FIX #2: _payWithMixed passa couponDiscount corretamente ao MP
// VARREDURA-FIX #3: couponService.applyCoupon → apenas marca como usado
// VARREDURA-FIX #4: _payWithBalance retorna productName correto
// VARREDURA-FIX #5: confirmApproval — order.id usado apenas após criação
// VARREDURA-FIX #6: confirmApproval — releaseReservation em finally
// VARREDURA-FIX #7: createPayment — releaseReservation em catch de falha PIX/MP
// VARREDURA-FIX #8: getPaymentStatus: releaseReservation ao expirar
// VARREDURA2-FIX #1: stockService.reserveStock lança erro se sem estoque disponível
// VARREDURA2-FIX #2: _payWithBalance deduz estoque via stockService.consumeStock
// VARREDURA2-FIX #3: cancelExpiredPayment + getPaymentStatus: revertCoupon ao expirar
// VARREDURA2-FIX #4: confirmApproval: revertCoupon removido (cupom já confirmado)
// VARREDURA2-FIX #5: confirmApproval: referral bonus com prisma.walletTransaction.create
// VARREDURA2-FIX #6: createDeposit exportado e registrado na rota
// VARREDURA2-FIX #7: cancelExpiredPayment + getPaymentStatus: cancela PIX no Mercado Pago ao expirar
// FIX-BALANCE-DELIVERY-CONTENT: _payWithBalance retorna deliveryContent (confirmationMessage removido —
//   campo não existe no schema Prisma. Bot usa buildDeliveryMessage que aceita undefined.)
// FIX-STATUS-DELIVERY: getPaymentStatus retorna productName e deliveryContent quando APPROVED
import { PaymentStatus, OrderStatus, StockItemStatus, WalletTransactionType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mercadoPagoService } from './mercadoPagoService';
import { deliveryService } from './deliveryService';
import { stockService } from './stockService';
import { couponService } from './couponService';
import { logger } from '../lib/logger';
import { AppError } from '../lib/AppError';

// ─── Types ────────────────────────────────────────────────────────────────────

type ProductSnap = {
  id: string;
  name: string;
  price: import('@prisma/client').Prisma.Decimal;
  type: string;
  deliveryContent: string | null;
  stock: number | null;
  availableStock: number | null;
};

// ─── Cache de status (TTL 5s) ─────────────────────────────────────────────────

const statusCacheTTL = 5_000;
const statusCache = new Map<string, { status: PaymentStatus; expiresAt: number }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function revertCoupon(paymentId: string): Promise<void> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { couponCode: true, telegramUserId: true },
  });
  if (!payment?.couponCode) return;
  await couponService.revertCoupon(payment.couponCode, payment.telegramUserId);
}

// ─── paymentService ───────────────────────────────────────────────────────────

export const paymentService = {
  // ─── _payWithBalance ──────────────────────────────────────────────────────

  async _payWithBalance(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    amount: number;
    couponCode?: string;
    referralCode?: string;
  }): Promise<{
    paymentId: string;
    paidWithBalance: true;
    productName: string;
    deliveryContent: string | null;
  }> {
    const { telegramUserId, product, qty, amount, couponCode, referralCode } = opts;

    // Reserva e consume estoque
    await stockService.reserveStock(product.id, qty);

    let paymentId: string;
    let deliveryContent: string | null = null;

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Verifica saldo
        const wallet = await tx.wallet.findUnique({ where: { telegramUserId } });
        if (!wallet || Number(wallet.balance) < amount) {
          throw new AppError('Saldo insuficiente.', 400);
        }

        // Cria payment
        const payment = await tx.payment.create({
          data: {
            telegramUserId,
            productId: product.id,
            amount,
            status: PaymentStatus.APPROVED,
            paymentMethod: 'BALANCE',
            couponCode: couponCode ?? null,
            approvedAt: new Date(),
          },
        });

        // Deduz saldo
        await tx.wallet.update({
          where: { telegramUserId },
          data: { balance: { decrement: amount } },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTransactionType.PURCHASE,
            amount,
            description: `Compra: ${product.name}`,
          },
        });

        // Cria order
        const order = await tx.order.create({
          data: {
            telegramUserId,
            paymentId: payment.id,
            productId: product.id,
            productName: product.name,
            amount,
            status: OrderStatus.PROCESSING,
            quantity: qty,
          },
        });

        return { payment, order };
      });

      paymentId = result.payment.id;

      // Entrega produto
      const delivered = await deliveryService.deliverStock({
        paymentId,
        orderId: result.order.id,
        product,
        qty,
        telegramUserId,
      });

      // FIX-BALANCE-DELIVERY-CONTENT: busca apenas deliveryContent (confirmationMessage não existe no schema)
      const productFull = await prisma.product.findUnique({
        where: { id: product.id },
        select: { deliveryContent: true },
      });
      deliveryContent = delivered?.deliveryContent ?? productFull?.deliveryContent ?? null;

      // Bonus de indicação
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
            if (referral && !referral.bonusPaid) {
              const bonus = Number(product.price) * 0.05;
              const referrerWallet = await prisma.wallet.findUnique({ where: { telegramUserId: referrer.id } });
              if (referrerWallet) {
                await prisma.wallet.update({
                  where: { telegramUserId: referrer.id },
                  data: { balance: { increment: bonus } },
                });
                await prisma.walletTransaction.create({
                  data: {
                    walletId: referrerWallet.id,
                    type: WalletTransactionType.BONUS,
                    amount: bonus,
                    description: `Bônus de indicação: ${product.name}`,
                  },
                });
                await prisma.referral.update({
                  where: { id: referral.id },
                  data: { bonusPaid: true, purchaseCount: { increment: 1 } },
                });
              }
            }
          }
        } catch (err) {
          logger.warn('[_payWithBalance] Falha ao pagar bônus de indicação:', err);
        }
      }

      await stockService.consumeStock(product.id, qty, paymentId);
    } catch (err) {
      await stockService.releaseReservation(paymentId!).catch(() => {});
      throw err;
    }

    return {
      paymentId,
      paidWithBalance: true,
      productName: product.name,
      deliveryContent,
    };
  },

  // ─── _payWithPix ──────────────────────────────────────────────────────────

  async _payWithPix(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    amount: number;
    couponCode?: string;
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
    const { telegramUserId, product, qty, amount, couponCode, firstName, username } = opts;

    await stockService.reserveStock(product.id, qty);

    let paymentId: string | undefined;
    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        amount,
        description: product.name,
        payerEmail: `${telegramUserId}@telegram.bot`,
        firstName: firstName ?? 'Cliente',
        lastName: username ?? 'Telegram',
        externalReference: telegramUserId,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const payment = await prisma.payment.create({
        data: {
          telegramUserId,
          productId: product.id,
          amount,
          status: PaymentStatus.PENDING,
          paymentMethod: 'PIX',
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
          pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
          pixExpiresAt: expiresAt,
          couponCode: couponCode ?? null,
          quantity: qty,
        },
      });

      paymentId = payment.id;

      return {
        paymentId: payment.id,
        pixQrCode: payment.pixQrCode ?? '',
        pixQrCodeText: payment.pixQrCodeText ?? '',
        amount,
        expiresAt: expiresAt.toISOString(),
        productName: product.name,
      };
    } catch (err) {
      if (paymentId) {
        await stockService.releaseReservation(paymentId).catch(() => {});
      } else {
        await stockService.releaseReservation('__noop__').catch(() => {});
        // libera a reserva feita antes do MP falhar
        await prisma.stockReservation.deleteMany({ where: { productId: product.id, paymentId: null } }).catch(() => {});
      }
      throw err;
    }
  },

  // ─── _payWithMixed ────────────────────────────────────────────────────────

  async _payWithMixed(opts: {
    telegramUserId: string;
    product: ProductSnap;
    qty: number;
    totalAmount: number;
    balanceAmount: number;
    pixAmount: number;
    couponCode?: string;
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
    const { telegramUserId, product, qty, totalAmount, balanceAmount, pixAmount, couponCode, firstName, username } = opts;

    await stockService.reserveStock(product.id, qty);

    let paymentId: string | undefined;
    try {
      // Deduz saldo imediatamente
      await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { telegramUserId } });
        if (!wallet || Number(wallet.balance) < balanceAmount) {
          throw new AppError('Saldo insuficiente para pagamento misto.', 400);
        }
        await tx.wallet.update({
          where: { telegramUserId },
          data: { balance: { decrement: balanceAmount } },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTransactionType.PURCHASE,
            amount: balanceAmount,
            description: `Reserva saldo (misto): ${product.name}`,
          },
        });
      });

      const mpPayment = await mercadoPagoService.createPixPayment({
        amount: pixAmount,
        description: product.name,
        payerEmail: `${telegramUserId}@telegram.bot`,
        firstName: firstName ?? 'Cliente',
        lastName: username ?? 'Telegram',
        externalReference: telegramUserId,
      });

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const payment = await prisma.payment.create({
        data: {
          telegramUserId,
          productId: product.id,
          amount: totalAmount,
          pixAmount,
          balanceUsed: balanceAmount,
          status: PaymentStatus.PENDING,
          paymentMethod: 'MIXED',
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '',
          pixQrCodeText: mpPayment.point_of_interaction?.transaction_data?.qr_code ?? '',
          pixExpiresAt: expiresAt,
          couponCode: couponCode ?? null,
          quantity: qty,
        },
      });

      paymentId = payment.id;

      return {
        paymentId: payment.id,
        pixQrCode: payment.pixQrCode ?? '',
        pixQrCodeText: payment.pixQrCodeText ?? '',
        amount: totalAmount,
        pixAmount,
        balanceUsed: balanceAmount,
        expiresAt: expiresAt.toISOString(),
        productName: product.name,
      };
    } catch (err) {
      // Reverte saldo se falhou após dedução
      try {
        const wallet = await prisma.wallet.findUnique({ where: { telegramUserId } });
        if (wallet) {
          await prisma.wallet.update({
            where: { telegramUserId },
            data: { balance: { increment: balanceAmount } },
          });
        }
      } catch {}
      if (paymentId) {
        await stockService.releaseReservation(paymentId).catch(() => {});
      }
      throw err;
    }
  },

  // ─── createPayment ────────────────────────────────────────────────────────

  async createPayment(opts: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
    paymentMethod: 'PIX' | 'BALANCE' | 'MIXED';
    couponCode?: string;
    referralCode?: string;
  }) {
    const { telegramId, productId, firstName, username, paymentMethod, couponCode, referralCode } = opts;

    // Batch: produto + usuário
    const [product, user] = await Promise.all([
      prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, price: true, type: true, deliveryContent: true, stock: true, availableStock: true },
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
    const qty = 1; // futuramente multi-qty
    const baseAmount = Number(product.price) * qty;

    // Desconto de cupom
    let couponDiscount = 0;
    if (couponCode) {
      try {
        const coupon = await couponService.validateCoupon(couponCode, telegramUserId, baseAmount, productId);
        couponDiscount = coupon.discountAmount;
      } catch {
        throw new AppError('Cupom inválido ou expirado.', 400);
      }
    }

    const totalAmount = Math.max(0, baseAmount - couponDiscount);

    if (paymentMethod === 'BALANCE') {
      const result = await this._payWithBalance({
        telegramUserId,
        product,
        qty,
        amount: totalAmount,
        couponCode,
        referralCode,
      });
      return { ...result, amount: totalAmount };
    }

    if (paymentMethod === 'PIX') {
      return this._payWithPix({
        telegramUserId,
        product,
        qty,
        amount: totalAmount,
        couponCode,
        firstName,
        username,
      });
    }

    // MIXED
    const wallet = await prisma.wallet.findUnique({ where: { telegramUserId }, select: { balance: true } });
    const balanceAmount = Math.min(Number(wallet?.balance ?? 0), totalAmount);
    const pixAmount = Math.max(0, totalAmount - balanceAmount);

    if (pixAmount <= 0) {
      return this._payWithBalance({
        telegramUserId,
        product,
        qty,
        amount: totalAmount,
        couponCode,
        referralCode,
      });
    }

    return this._payWithMixed({
      telegramUserId,
      product,
      qty,
      totalAmount,
      balanceAmount,
      pixAmount,
      couponCode,
      firstName,
      username,
    });
  },

  // ─── createDeposit ────────────────────────────────────────────────────────

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

    const mpPayment = await mercadoPagoService.createPixPayment({
      amount,
      description: 'Depósito de saldo',
      payerEmail: `${telegramId}@telegram.bot`,
      firstName: firstName ?? 'Cliente',
      lastName: username ?? 'Telegram',
      externalReference: `deposit_${telegramId}`,
    });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: user.id,
        productId: null,
        amount,
        status: PaymentStatus.PENDING,
        paymentMethod: 'DEPOSIT',
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

  // ─── confirmApproval ──────────────────────────────────────────────────────

  async confirmApproval(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true, product: true, order: true },
    });

    if (!payment) {
      logger.warn(`[confirmApproval] Pagamento não encontrado: ${paymentId}`);
      return;
    }

    // Idempotência
    if (payment.approvedAt) {
      logger.info(`[confirmApproval] Pagamento já aprovado: ${paymentId}`);
      return;
    }

    // Ignora depósitos (sem produto)
    if (!payment.product || !payment.productId) {
      // É um depósito — credita saldo
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });
        const wallet = await tx.wallet.upsert({
          where: { telegramUserId: payment.telegramUserId },
          update: { balance: { increment: Number(payment.amount) } },
          create: { telegramUserId: payment.telegramUserId, balance: Number(payment.amount) },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTransactionType.DEPOSIT,
            amount: Number(payment.amount),
            description: 'Depósito via PIX',
          },
        });
      });
      statusCache.delete(paymentId);
      return;
    }

    const product = payment.product;
    const qty = payment.quantity ?? 1;

    try {
      let order = payment.order;

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });

        if (!order) {
          order = await tx.order.create({
            data: {
              telegramUserId: payment.telegramUserId,
              paymentId,
              productId: product.id,
              productName: product.name,
              amount: Number(payment.amount),
              status: OrderStatus.PROCESSING,
              quantity: qty,
            },
          });
        } else {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.PROCESSING },
          });
        }
      });

      await deliveryService.deliverStock({
        paymentId,
        orderId: order!.id,
        product,
        qty,
        telegramUserId: payment.telegramUserId,
      });

      await stockService.consumeStock(product.id, qty, paymentId);

      statusCache.delete(paymentId);
    } finally {
      await stockService.releaseReservation(paymentId).catch(() => {});
    }
  },

  // ─── handleMercadoPagoWebhook ─────────────────────────────────────────────

  async handleMercadoPagoWebhook(data: { action?: string; data?: { id?: string } }): Promise<void> {
    if (data.action !== 'payment.updated' && data.action !== 'payment.created') return;

    const mpId = data.data?.id;
    if (!mpId) return;

    setImmediate(async () => {
      try {
        const mpStatus = await mercadoPagoService.verifyPayment(mpId);
        if (mpStatus !== 'approved') return;

        const payment = await prisma.payment.findFirst({
          where: { mercadoPagoId: mpId },
          select: { id: true, status: true },
        });

        if (!payment) {
          logger.warn(`[webhook] Pagamento não encontrado para mercadoPagoId: ${mpId}`);
          return;
        }

        if (payment.status !== PaymentStatus.PENDING) {
          logger.info(`[webhook] Pagamento ${payment.id} já processado (status: ${payment.status})`);
          return;
        }

        await paymentService.confirmApproval(payment.id);
      } catch (err) {
        logger.error('[webhook] Erro ao processar webhook:', err);
      }
    });
  },

  // ─── cancelExpiredPayment ─────────────────────────────────────────────────

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

    await revertCoupon(paymentId).catch((err) =>
      logger.warn(`[cancelExpiredPayment] revertCoupon falhou para ${paymentId}:`, err)
    );

    if (payment.mercadoPagoId) {
      mercadoPagoService.refundPayment(payment.mercadoPagoId).catch((err) =>
        logger.warn(`[cancelExpiredPayment] Falha ao cancelar PIX no MP (${payment.mercadoPagoId}): ignorado`, err)
      );
    }

    statusCache.delete(paymentId);
  },

  // ─── getPaymentStatus ─────────────────────────────────────────────────────

  // FIX-STATUS-DELIVERY: retorna productName e deliveryContent quando APPROVED
  async getPaymentStatus(paymentId: string): Promise<{ status: PaymentStatus; approvedAt?: string; productName?: string; deliveryContent?: string | null }> {
    const now = Date.now();
    const cached = statusCache.get(paymentId);
    if (cached && cached.expiresAt > now) {
      return { status: cached.status };
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, approvedAt: true, pixExpiresAt: true, mercadoPagoId: true, productId: true, product: { select: { name: true, deliveryContent: true } } },
    });

    if (!payment) throw new AppError('Pagamento não encontrado.', 404);

    let status = payment.status;
    if (
      status === PaymentStatus.PENDING &&
      payment.pixExpiresAt &&
      payment.pixExpiresAt < new Date()
    ) {
      status = PaymentStatus.EXPIRED;
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.EXPIRED, expiredAt: new Date() },
      });

      // VARREDURA-FIX #8: libera reserva de estoque ao detectar expiração via polling
      try {
        await stockService.releaseReservation(paymentId);
      } catch (err) {
        logger.warn(`[getPaymentStatus] releaseReservation falhou para ${paymentId}:`, err);
      }

      // VARREDURA2-FIX #3: reverte cupom ao expirar via polling
      await revertCoupon(paymentId).catch((err) =>
        logger.warn(`[getPaymentStatus] revertCoupon falhou para ${paymentId}:`, err)
      );

      // VARREDURA2-FIX #7: cancela PIX no Mercado Pago ao expirar via polling
      if (payment.mercadoPagoId) {
        mercadoPagoService.refundPayment(payment.mercadoPagoId).catch((err) =>
          logger.warn(`[getPaymentStatus] Falha ao cancelar PIX no MP (${payment.mercadoPagoId}): ignorado`, err)
        );
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

  // ─── cancelPayment ────────────────────────────────────────────────────────

  async cancelPayment(paymentId: string, telegramUserId: string): Promise<{ cancelled: boolean; message?: string }> {
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, telegramUserId },
      select: { status: true, mercadoPagoId: true },
    });

    if (!payment) {
      return { cancelled: false, reason: 'Pagamento não encontrado.' } as never;
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return { cancelled: false, message: `Pagamento não pode ser cancelado (status: ${payment.status}).` };
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });

    await stockService.releaseReservation(paymentId).catch(() => {});
    await revertCoupon(paymentId).catch(() => {});

    if (payment.mercadoPagoId) {
      mercadoPagoService.refundPayment(payment.mercadoPagoId).catch(() => {});
    }

    statusCache.delete(paymentId);
    return { cancelled: true };
  },

  // ─── getAvailableStock (helper para rota) ─────────────────────────────────

  async getAvailableStock(productId: string): Promise<number | null> {
    const items = await prisma.stockItem.count({
      where: { productId, status: StockItemStatus.AVAILABLE },
    });
    return items;
  },
};
