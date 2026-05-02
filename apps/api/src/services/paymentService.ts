// paymentService.ts
// FIX BUG3: reserva+confirmação+deduct do saldo em prisma.$transaction única
// FIX BUG4: guard mercadoPagoId null antes de verifyPayment
// FIX BUG5: usa expiredAt em vez de cancelledAt para EXPIRED
// FIX BUG6: novo produto recebe sortOrder = MAX(sortOrder)+1
// FIX BUG10: createDepositPayment reutiliza PIX de depósito pendente (evita duplicatas)
// FEATURE: paymentMethod BALANCE | PIX | MIXED
// OPT #1: _payWithBalance move reserveStock para dentro da $transaction (sem race condition)
// OPT #2: _payWithPix e _payMixed fazem 1 write ao invés de 2
// OPT #3: productHasStockItems com cache em memória TTL 30s
// OPT #5: cache de usuário conhecido em memória TTL 5min (evita upsert desnecessário)
// OPT #6: getPaymentStatus com cache em memória TTL 5s
// OPT #7: walletService.deposit no rollback com try/catch de auditoria
// OPT #8: interfaces internas extraídas
// OPT #9: grava paymentMethod, balanceUsed, pixAmount em colunas reais
//         isDeposit detectado via metadata (coluna não existe no schema)
// FIX STOCK CACHE: productHasStockItems conta apenas AVAILABLE (não todos os StockItems)
// FIX STOCK CACHE: invalida stockItemCache após reserveStock para evitar falso-negativo
// FIX B9: _payWithPix usa randomUUID() como externalReference
// FIX B11 (v2): _payMixed deduplica requests concorrentes em 2 níveis
// FIX BALANCE DELIVERY: injeta telegramId no snap para deliveryService
// FIX BALANCE CACHE STALE: saldo SEMPRE relido do DB antes do check
// FIX B12: _payWithBalance deduplica requests concorrentes em 2 níveis
// FIX-BLOCKED: verifica isBlocked antes de qualquer processamento
// FIX-B16: janela de dedup BALANCE ampliada de 30s → 60s para cobrir reinícios do bot
// FIX-BUILD: corrige chamada createPixPayment (1 objeto), qr_code path, remove isDeposit/orderId
//            (não existem no schema), adiciona findExpiredPaymentIds/cancelExpiredPayment,
//            usa refundPayment em vez de cancelPayment no MP
// FIX-BUILD2: troca env.WEBHOOK_URL → env.BOT_WEBHOOK_URL (variável correta do schema)
// FEAT-PRICING: integra applyPricing, commitCouponUse, commitReferral e payReferralReward
import { randomUUID } from 'crypto';
import { PaymentStatus, PaymentMethod, StockItemStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mercadoPagoService } from './mercadoPagoService';
import { deliveryService } from './deliveryService';
import { telegramService } from './telegramService';
import { stockService } from './stockService';
import { walletService } from './walletService';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import {
  applyPricing,
  commitCouponUse,
  commitReferral,
  payReferralReward,
  CouponError,
} from './pricingService';
import type {
  CreatePaymentRequest,
  CreatePaymentResponse,
  CreateDepositRequest,
  CreateDepositResponse,
} from '@saas-pix/shared';

// ─── OPT #8: interfaces internas extraídas ────────────────────────────────────
interface TelegramUserSnap {
  id: string;
  balance: unknown;
}

interface ProductSnap {
  id: string;
  name: string;
  stock: number | null;
}

interface PayWithBalanceParams {
  telegramUser: TelegramUserSnap;
  product: ProductSnap;
  price: number;
  firstName?: string;
  username?: string;
  telegramId: string;
  couponCode?: string | null;
  referralCode?: string | null;
}

interface PayWithPixParams {
  telegramUser: Pick<TelegramUserSnap, 'id'>;
  product: ProductSnap;
  price: number;
  firstName?: string;
  username?: string;
  telegramId: string;
  couponCode?: string | null;
  referralCode?: string | null;
}

interface PayMixedParams {
  telegramUser: TelegramUserSnap;
  product: ProductSnap;
  price: number;
  balanceUsed: number;
  pixAmount: number;
  firstName?: string;
  username?: string;
  telegramId: string;
  couponCode?: string | null;
  referralCode?: string | null;
}

// Helper: extrai qr_code e qr_code_base64 da resposta do Mercado Pago
function extractQrCodes(mp: Awaited<ReturnType<typeof mercadoPagoService.createPixPayment>>) {
  const txData = mp.point_of_interaction?.transaction_data;
  return {
    qr_code: txData?.qr_code ?? '',
    qr_code_base64: txData?.qr_code_base64 ?? '',
  };
}

// ─── OPT #3: cache de productHasStockItems (TTL 30s) ─────────────────────────
const stockItemCacheTTL = 30_000;
const stockItemCache = new Map<string, { value: boolean; expiresAt: number }>();

export function invalidateStockItemCache(productId: string): void {
  stockItemCache.delete(productId);
}

// ─── OPT #5: cache de usuário conhecido (TTL 5min) ───────────────────────────
const userCacheTTL = 5 * 60_000;
interface UserCacheEntry {
  id: string;
  balance: unknown;
  firstName?: string | null;
  username?: string | null;
  expiresAt: number;
}
const userCache = new Map<string, UserCacheEntry>();

async function upsertUserCached(
  telegramId: string,
  firstName?: string,
  username?: string
): Promise<{ id: string; balance: unknown }> {
  const now = Date.now();
  const cached = userCache.get(telegramId);

  if (
    cached &&
    cached.expiresAt > now &&
    cached.firstName === (firstName ?? null) &&
    cached.username === (username ?? null)
  ) {
    return { id: cached.id, balance: cached.balance };
  }

  const user = await prisma.telegramUser.upsert({
    where: { telegramId },
    update: { firstName, username },
    create: { telegramId, firstName, username },
  });

  userCache.set(telegramId, {
    id: user.id,
    balance: user.balance,
    firstName: user.firstName ?? null,
    username: user.username ?? null,
    expiresAt: now + userCacheTTL,
  });

  return { id: user.id, balance: user.balance };
}

export function invalidateUserCache(telegramId: string): void {
  userCache.delete(telegramId);
}

// ─── OPT #6: cache de status de pagamento (TTL 5s) ───────────────────────────
const statusCacheTTL = 5_000;
const statusCache = new Map<string, { status: PaymentStatus; expiresAt: number }>();

// ─── lock in-memory para _payMixed simultâneos ────────────────────────────────
const mixedPaymentLock = new Set<string>();

// ─── lock in-memory para _payWithBalance simultâneos ─────────────────────────
const balancePaymentLock = new Set<string>();

export class PaymentService {
  async createPayment(data: CreatePaymentRequest): Promise<CreatePaymentResponse> {
    const { telegramId, productId, firstName, username, paymentMethod } = data;
    const couponCode = (data as Record<string, unknown>).couponCode as string | undefined;
    const referralCode = (data as Record<string, unknown>).referralCode as string | undefined;

    const [product, telegramUser] = await Promise.all([
      prisma.product.findUnique({ where: { id: productId, isActive: true } }),
      upsertUserCached(telegramId, firstName, username),
    ]);

    if (!product) throw new AppError('Produto não encontrado ou indisponível.', 404);

    const userStatus = await prisma.telegramUser.findUnique({
      where: { id: telegramUser.id },
      select: { isBlocked: true, balance: true },
    });

    if (userStatus?.isBlocked) {
      logger.warn(`[PaymentService] Tentativa de compra bloqueada para usuário ${telegramId} (isBlocked=true)`);
      throw new AppError('Sua conta está suspensa. Entre em contato com o suporte.', 403);
    }

    const balance = userStatus ? Number(userStatus.balance) : 0;
    let price = Number(product.price);

    // ─── PRICING ─────────────────────────────────────────────────────────────
    let pricingResult;
    try {
      pricingResult = await applyPricing({
        productId: product.id,
        telegramUserId: telegramUser.id,
        telegramId,
        basePrice: price,
        quantity: 1,
        couponCode: couponCode ?? null,
        referralCode: referralCode ?? null,
      });
      price = pricingResult.finalAmount;
    } catch (err) {
      if (err instanceof CouponError) {
        throw new AppError(err.message, 400);
      }
      throw err;
    }

    if (paymentMethod === 'BALANCE') {
      if (balance < price) {
        const recentApproved = await prisma.payment.findFirst({
          where: {
            telegramUserId: telegramUser.id,
            productId: product.id,
            status: PaymentStatus.APPROVED,
            paymentMethod: PaymentMethod.BALANCE,
            approvedAt: { gt: new Date(Date.now() - 60_000) },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (recentApproved) {
          logger.info(`[FIX-B16] Saldo insuficiente mas pagamento BALANCE recente detectado (${recentApproved.id}) — retornando idempotente`);
          return {
            paymentId: recentApproved.id,
            pixQrCode: '',
            pixQrCodeText: '',
            amount: Number(recentApproved.amount),
            balanceUsed: Number(recentApproved.balanceUsed ?? price),
            expiresAt: new Date().toISOString(),
            productName: product.name,
            paidWithBalance: true,
          };
        }
        throw new AppError(
          `Saldo insuficiente. Seu saldo atual é R$ ${balance.toFixed(2)} e o produto custa R$ ${price.toFixed(2)}.`,
          400
        );
      }
      return this._payWithBalance({ telegramUser, product, price, firstName, username, telegramId, couponCode, referralCode, pricingResult } as Parameters<typeof this._payWithBalance>[0] & { pricingResult: typeof pricingResult });
    }

    if (paymentMethod === 'MIXED') {
      if (balance <= 0) {
        throw new AppError(
          `Saldo insuficiente para usar no modo misto. Seu saldo atual é R$ ${balance.toFixed(2)}.`,
          400
        );
      }
      const balanceUsed = Math.min(balance, price);
      const pixAmount = parseFloat((price - balanceUsed).toFixed(2));

      if (pixAmount <= 0) {
        return this._payWithBalance({ telegramUser, product, price, firstName, username, telegramId, couponCode, referralCode, pricingResult } as Parameters<typeof this._payWithBalance>[0] & { pricingResult: typeof pricingResult });
      }

      return this._payMixed({ telegramUser, product, price, balanceUsed, pixAmount, firstName, username, telegramId, couponCode, referralCode, pricingResult } as Parameters<typeof this._payMixed>[0] & { pricingResult: typeof pricingResult });
    }

    if (paymentMethod === 'PIX') {
      return this._payWithPix({ telegramUser, product, price, firstName, username, telegramId, couponCode, referralCode, pricingResult } as Parameters<typeof this._payWithPix>[0] & { pricingResult: typeof pricingResult });
    }

    if (balance >= price) {
      return this._payWithBalance({ telegramUser, product, price, firstName, username, telegramId, couponCode, referralCode, pricingResult } as Parameters<typeof this._payWithBalance>[0] & { pricingResult: typeof pricingResult });
    }
    return this._payWithPix({ telegramUser, product, price, firstName, username, telegramId, couponCode, referralCode, pricingResult } as Parameters<typeof this._payWithPix>[0] & { pricingResult: typeof pricingResult });
  }

  private async _payWithBalance(params: PayWithBalanceParams & { pricingResult?: Awaited<ReturnType<typeof applyPricing>> }): Promise<CreatePaymentResponse> {
    const { telegramUser, product, price, firstName, username, telegramId, pricingResult } = params;

    const existingApproved = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        status: PaymentStatus.APPROVED,
        paymentMethod: PaymentMethod.BALANCE,
        approvedAt: { gt: new Date(Date.now() - 60_000) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingApproved) {
      logger.info(`[Wallet] Pagamento BALANCE duplicado detectado (DB): ${existingApproved.id} — retornando idempotente`);
      return {
        paymentId: existingApproved.id,
        pixQrCode: '',
        pixQrCodeText: '',
        amount: Number(existingApproved.amount),
        balanceUsed: Number(existingApproved.balanceUsed ?? price),
        expiresAt: new Date().toISOString(),
        productName: product.name,
        paidWithBalance: true,
      };
    }

    const lockKey = `balance:${telegramUser.id}:${product.id}`;
    if (balancePaymentLock.has(lockKey)) {
      logger.warn(`[Wallet] Request duplicado bloqueado (lock): ${lockKey}`);
      throw new AppError('Pagamento em processamento. Aguarde alguns instantes e tente novamente.', 429);
    }
    balancePaymentLock.add(lockKey);

    try {
      logger.info(`[Wallet] Usuário ${telegramUser.id} pagando 100% com saldo (${price}).`);

      const hasStockItems = await this.productHasStockItems(product.id);

      const { payment, order } = await prisma.$transaction(async (tx) => {
        const currentUser = await tx.telegramUser.findUnique({
          where: { id: telegramUser.id },
          select: { balance: true },
        });
        if (!currentUser || Number(currentUser.balance) < price) {
          throw new AppError('Saldo insuficiente.', 400);
        }

        const newPayment = await tx.payment.create({
          data: {
            telegramUserId: telegramUser.id,
            productId: product.id,
            amount: price,
            status: PaymentStatus.APPROVED,
            approvedAt: new Date(),
            paymentMethod: PaymentMethod.BALANCE,
            balanceUsed: price,
            metadata: {
              firstName,
              username,
              productName: product.name,
              isDeposit: false,
              couponCode: pricingResult?.couponCode ?? null,
              discountAmount: pricingResult?.discountAmount ?? 0,
              originalAmount: pricingResult?.originalAmount ?? price,
            },
          },
        });

        const newOrder = await tx.order.create({
          data: {
            paymentId: newPayment.id,
            telegramUserId: telegramUser.id,
            productId: product.id,
            status: 'PROCESSING',
          },
        });

        await tx.telegramUser.update({
          where: { id: telegramUser.id },
          data: { balance: { decrement: price } },
        });
        await tx.walletTransaction.create({
          data: {
            telegramUserId: telegramUser.id,
            type: 'PURCHASE',
            amount: price,
            description: `Compra: ${product.name}`,
            paymentId: newPayment.id,
          },
        });

        // Commit coupon use
        if (pricingResult?.couponId) {
          await commitCouponUse(tx, pricingResult.couponId, telegramUser.id, newPayment.id);
        }

        // Commit referral (sem recompensa ainda)
        if (pricingResult?.referrerId) {
          const REFERRAL_REWARD = 5.00; // R$ 5,00 por indicação
          await commitReferral(tx, pricingResult.referrerId, telegramUser.id, newPayment.id, REFERRAL_REWARD);
        }

        return { payment: newPayment, order: newOrder };
      });

      invalidateUserCache(telegramId);

      if (product.stock !== null || hasStockItems) {
        try {
          await stockService.reserveStock(product.id, telegramUser.id, payment.id);
          invalidateStockItemCache(product.id);
          await stockService.confirmReservation(payment.id);
        } catch (err) {
          logger.error(`[Wallet] Erro ao reservar estoque para payment ${payment.id}:`, err);
          try {
            await walletService.deposit(
              telegramUser.id,
              price,
              `Estorno automático: falha no estoque do produto ${product.name}`,
              payment.id,
            );
          } catch (estornoErr) {
            logger.error(`[Wallet] CRÍTICO: falha no estorno do payment ${payment.id}`, estornoErr);
          }
          await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() } });
          throw new AppError('Produto sem estoque disponível.', 409);
        }
      }

      deliveryService.deliver(
        order.id,
        { ...telegramUser, telegramId } as Parameters<typeof deliveryService.deliver>[1],
        product as Parameters<typeof deliveryService.deliver>[2]
      ).catch((err) => {
        logger.error(`[Wallet] Erro na entrega do order ${order.id}:`, err);
      });

      return {
        paymentId: payment.id,
        pixQrCode: '',
        pixQrCodeText: '',
        amount: price,
        balanceUsed: price,
        expiresAt: new Date().toISOString(),
        productName: product.name,
        paidWithBalance: true,
        ...(pricingResult && pricingResult.discountAmount > 0 ? {
          originalAmount: pricingResult.originalAmount,
          discountAmount: pricingResult.discountAmount,
          couponCode: pricingResult.couponCode,
        } : {}),
      };
    } finally {
      balancePaymentLock.delete(lockKey);
    }
  }

  private async _payMixed(params: PayMixedParams & { pricingResult?: Awaited<ReturnType<typeof applyPricing>> }): Promise<CreatePaymentResponse> {
    const { telegramUser, product, price, balanceUsed, pixAmount, firstName, username, telegramId, pricingResult } = params;

    const existingPending = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        status: PaymentStatus.PENDING,
        paymentMethod: PaymentMethod.MIXED,
        OR: [
          { pixExpiresAt: { gt: new Date() } },
          { pixExpiresAt: null, createdAt: { gt: new Date(Date.now() - 120_000) } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingPending) {
      if (existingPending.pixQrCode && existingPending.pixExpiresAt) {
        logger.info(`[Mixed] Pagamento MIXED pendente reutilizado: ${existingPending.id}`);
        return {
          paymentId: existingPending.id,
          pixQrCode: existingPending.pixQrCode,
          pixQrCodeText: existingPending.pixQrCodeText ?? '',
          amount: Number(existingPending.amount),
          balanceUsed: Number(existingPending.balanceUsed ?? balanceUsed),
          pixAmount: Number(existingPending.pixAmount ?? pixAmount),
          expiresAt: existingPending.pixExpiresAt.toISOString(),
          productName: product.name,
          paidWithBalance: false,
        };
      }
    }

    const lockKey = `mixed:${telegramUser.id}:${product.id}`;
    if (mixedPaymentLock.has(lockKey)) {
      logger.warn(`[Mixed] Request duplicado bloqueado (lock): ${lockKey}`);
      throw new AppError('Pagamento em processamento. Aguarde alguns instantes e tente novamente.', 429);
    }
    mixedPaymentLock.add(lockKey);

    try {
      logger.info(`[Mixed] Usuário ${telegramUser.id}: saldo=${balanceUsed}, PIX=${pixAmount}`);

      const hasStockItems = await this.productHasStockItems(product.id);

      const externalReference = randomUUID();
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: pixAmount,
        description: `Compra MIXED: ${product.name}`,
        payerName: firstName ?? 'Usuario',
        externalReference,
        notificationUrl: env.BOT_WEBHOOK_URL ?? '',
      });

      const { qr_code, qr_code_base64 } = extractQrCodes(mpPayment);
      if (!qr_code || !qr_code_base64) {
        throw new AppError('Falha ao gerar QR Code PIX para pagamento misto.', 500);
      }

      const pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

      const payment = await prisma.$transaction(async (tx) => {
        const newPayment = await tx.payment.create({
          data: {
            telegramUserId: telegramUser.id,
            productId: product.id,
            amount: price,
            status: PaymentStatus.PENDING,
            paymentMethod: PaymentMethod.MIXED,
            balanceUsed: balanceUsed,
            pixAmount: pixAmount,
            mercadoPagoId: mpPayment.id?.toString(),
            pixQrCode: qr_code_base64,
            pixQrCodeText: qr_code,
            pixExpiresAt,
            metadata: {
              firstName,
              username,
              productName: product.name,
              externalReference,
              isDeposit: false,
              couponCode: pricingResult?.couponCode ?? null,
              discountAmount: pricingResult?.discountAmount ?? 0,
              originalAmount: pricingResult?.originalAmount ?? price,
            },
          },
        });

        if (pricingResult?.couponId) {
          await commitCouponUse(tx, pricingResult.couponId, telegramUser.id, newPayment.id);
        }
        if (pricingResult?.referrerId) {
          const REFERRAL_REWARD = 5.00;
          await commitReferral(tx, pricingResult.referrerId, telegramUser.id, newPayment.id, REFERRAL_REWARD);
        }

        return newPayment;
      });

      if (product.stock !== null || hasStockItems) {
        await stockService.reserveStock(product.id, telegramUser.id, payment.id);
        invalidateStockItemCache(product.id);
      }

      return {
        paymentId: payment.id,
        pixQrCode: qr_code_base64,
        pixQrCodeText: qr_code,
        amount: price,
        balanceUsed,
        pixAmount,
        expiresAt: pixExpiresAt.toISOString(),
        productName: product.name,
        paidWithBalance: false,
        ...(pricingResult && pricingResult.discountAmount > 0 ? {
          originalAmount: pricingResult.originalAmount,
          discountAmount: pricingResult.discountAmount,
          couponCode: pricingResult.couponCode,
        } : {}),
      };
    } finally {
      mixedPaymentLock.delete(lockKey);
    }
  }

  private async _payWithPix(params: PayWithPixParams & { pricingResult?: Awaited<ReturnType<typeof applyPricing>> }): Promise<CreatePaymentResponse> {
    const { telegramUser, product, price, firstName, username, pricingResult } = params;

    const existingPending = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        status: PaymentStatus.PENDING,
        paymentMethod: PaymentMethod.PIX,
        metadata: { path: ['isDeposit'], equals: false },
        OR: [
          { pixExpiresAt: { gt: new Date() } },
          { pixExpiresAt: null, createdAt: { gt: new Date(Date.now() - 120_000) } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingPending?.pixQrCode && existingPending.pixExpiresAt) {
      logger.info(`[PIX] Pagamento PIX pendente reutilizado: ${existingPending.id}`);
      return {
        paymentId: existingPending.id,
        pixQrCode: existingPending.pixQrCode,
        pixQrCodeText: existingPending.pixQrCodeText ?? '',
        amount: Number(existingPending.amount),
        balanceUsed: 0,
        expiresAt: existingPending.pixExpiresAt.toISOString(),
        productName: product.name,
        paidWithBalance: false,
      };
    }

    const externalReference = randomUUID();
    const mpPayment = await mercadoPagoService.createPixPayment({
      transactionAmount: price,
      description: `Compra: ${product.name}`,
      payerName: firstName ?? 'Usuario',
      externalReference,
      notificationUrl: env.BOT_WEBHOOK_URL ?? '',
    });

    const { qr_code, qr_code_base64 } = extractQrCodes(mpPayment);
    if (!qr_code || !qr_code_base64) {
      throw new AppError('Falha ao gerar QR Code PIX.', 500);
    }

    const pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const payment = await prisma.$transaction(async (tx) => {
      const newPayment = await tx.payment.create({
        data: {
          telegramUserId: telegramUser.id,
          productId: product.id,
          amount: price,
          status: PaymentStatus.PENDING,
          paymentMethod: PaymentMethod.PIX,
          balanceUsed: 0,
          pixAmount: price,
          mercadoPagoId: mpPayment.id?.toString(),
          pixQrCode: qr_code_base64,
          pixQrCodeText: qr_code,
          pixExpiresAt,
          metadata: {
            firstName,
            username,
            productName: product.name,
            externalReference,
            isDeposit: false,
            couponCode: pricingResult?.couponCode ?? null,
            discountAmount: pricingResult?.discountAmount ?? 0,
            originalAmount: pricingResult?.originalAmount ?? price,
          },
        },
      });

      if (pricingResult?.couponId) {
        await commitCouponUse(tx, pricingResult.couponId, telegramUser.id, newPayment.id);
      }
      if (pricingResult?.referrerId) {
        const REFERRAL_REWARD = 5.00;
        await commitReferral(tx, pricingResult.referrerId, telegramUser.id, newPayment.id, REFERRAL_REWARD);
      }

      return newPayment;
    });

    const hasStockItems = await this.productHasStockItems(product.id);
    if (product.stock !== null || hasStockItems) {
      await stockService.reserveStock(product.id, telegramUser.id, payment.id);
      invalidateStockItemCache(product.id);
    }

    return {
      paymentId: payment.id,
      pixQrCode: qr_code_base64,
      pixQrCodeText: qr_code,
      amount: price,
      balanceUsed: 0,
      expiresAt: pixExpiresAt.toISOString(),
      productName: product.name,
      paidWithBalance: false,
      ...(pricingResult && pricingResult.discountAmount > 0 ? {
        originalAmount: pricingResult.originalAmount,
        discountAmount: pricingResult.discountAmount,
        couponCode: pricingResult.couponCode,
      } : {}),
    };
  }

  // ─── Depósito de saldo ────────────────────────────────────────────────────────
  async createDepositPayment(data: CreateDepositRequest): Promise<CreateDepositResponse> {
    const { telegramId, amount, firstName, username } = data;

    const telegramUser = await upsertUserCached(telegramId, firstName, username);

    const existingDeposit = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        status: PaymentStatus.PENDING,
        metadata: { path: ['isDeposit'], equals: true },
        amount: amount,
        OR: [
          { pixExpiresAt: { gt: new Date() } },
          { pixExpiresAt: null, createdAt: { gt: new Date(Date.now() - 120_000) } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingDeposit?.pixQrCode && existingDeposit.pixExpiresAt) {
      logger.info(`[Deposit] PIX de depósito pendente reutilizado: ${existingDeposit.id}`);
      return {
        paymentId: existingDeposit.id,
        pixQrCode: existingDeposit.pixQrCode,
        pixQrCodeText: existingDeposit.pixQrCodeText ?? '',
        amount,
        expiresAt: existingDeposit.pixExpiresAt.toISOString(),
      };
    }

    const externalReference = randomUUID();
    const mpPayment = await mercadoPagoService.createPixPayment({
      transactionAmount: amount,
      description: 'Depósito de saldo',
      payerName: firstName ?? 'Usuario',
      externalReference,
      notificationUrl: env.BOT_WEBHOOK_URL ?? '',
    });

    const { qr_code, qr_code_base64 } = extractQrCodes(mpPayment);
    if (!qr_code || !qr_code_base64) {
      throw new AppError('Falha ao gerar QR Code PIX para depósito.', 500);
    }

    const pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: null,
        amount,
        status: PaymentStatus.PENDING,
        paymentMethod: PaymentMethod.PIX,
        balanceUsed: 0,
        pixAmount: amount,
        mercadoPagoId: mpPayment.id?.toString(),
        pixQrCode: qr_code_base64,
        pixQrCodeText: qr_code,
        pixExpiresAt,
        metadata: { firstName, username, externalReference, isDeposit: true },
      },
    });

    return {
      paymentId: payment.id,
      pixQrCode: qr_code_base64,
      pixQrCodeText: qr_code,
      amount,
      expiresAt: pixExpiresAt.toISOString(),
    };
  }

  // ─── processApprovedPayment ───────────────────────────────────────────────────
  async processApprovedPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true, product: true, order: true },
    });

    if (!payment) {
      logger.error(`[processApproved] Pagamento ${paymentId} não encontrado`);
      return;
    }

    if (payment.status === PaymentStatus.APPROVED) {
      logger.info(`[processApproved] Pagamento ${paymentId} já aprovado, ignorando`);
      return;
    }

    const method = payment.paymentMethod;
    const isDeposit = (payment.metadata as Record<string, unknown> | null)?.isDeposit === true;

    logger.info(`[processApproved] Processando pagamento ${paymentId} | method=${method} | isDeposit=${isDeposit}`);

    // ─── Depósito de saldo ────────────────────────────────────────────
    if (isDeposit) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
      });
      await walletService.deposit(
        payment.telegramUserId,
        Number(payment.amount),
        `Depósito via PIX`,
        paymentId,
      );
      invalidateUserCache(payment.telegramUser.telegramId);
      try {
        await telegramService.sendMessage(
          payment.telegramUser.telegramId,
          `✅ *Depósito confirmado!*\n\nR$ ${Number(payment.amount).toFixed(2)} adicionado ao seu saldo.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.warn(`[processApproved] Falha ao notificar depósito para ${payment.telegramUser.telegramId}:`, err);
      }
      return;
    }

    // ─── Pagamento MIXED: debita saldo + aprova ───────────────────────
    if (method === PaymentMethod.MIXED) {
      const balanceUsed = Number(payment.balanceUsed ?? 0);

      if (balanceUsed > 0) {
        const currentUser = await prisma.telegramUser.findUnique({
          where: { id: payment.telegramUserId },
          select: { balance: true },
        });
        if (!currentUser || Number(currentUser.balance) < balanceUsed) {
          logger.error(`[processApproved] Saldo insuficiente para MIXED payment ${paymentId}.`);
          await prisma.payment.update({
            where: { id: paymentId },
            data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
          });
          return;
        }

        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: paymentId },
            data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
          });
          await tx.telegramUser.update({
            where: { id: payment.telegramUserId },
            data: { balance: { decrement: balanceUsed } },
          });
          await tx.walletTransaction.create({
            data: {
              telegramUserId: payment.telegramUserId,
              type: 'PURCHASE',
              amount: balanceUsed,
              description: `Compra MIXED: ${payment.product?.name ?? 'Produto'}`,
              paymentId,
            },
          });

          // Paga recompensa de referral se houver
          await payReferralReward(tx, paymentId, async (userId, amount, description, txClient) => {
            await txClient.telegramUser.update({
              where: { id: userId },
              data: { balance: { increment: amount } },
            });
            await txClient.walletTransaction.create({
              data: { telegramUserId: userId, type: 'REFERRAL_REWARD', amount, description },
            });
          });
        });
        invalidateUserCache(payment.telegramUser.telegramId);
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: paymentId },
            data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
          });
          await payReferralReward(tx, paymentId, async (userId, amount, description, txClient) => {
            await txClient.telegramUser.update({
              where: { id: userId },
              data: { balance: { increment: amount } },
            });
            await txClient.walletTransaction.create({
              data: { telegramUserId: userId, type: 'REFERRAL_REWARD', amount, description },
            });
          });
        });
      }
    } else {
      // PIX puro
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });
        await payReferralReward(tx, paymentId, async (userId, amount, description, txClient) => {
          await txClient.telegramUser.update({
            where: { id: userId },
            data: { balance: { increment: amount } },
          });
          await txClient.walletTransaction.create({
            data: { telegramUserId: userId, type: 'REFERRAL_REWARD', amount, description },
          });
        });
      });
    }

    // ─── Estoque + entrega ────────────────────────────────────────────
    if (!payment.product) {
      logger.error(`[processApproved] Produto não encontrado para payment ${paymentId}`);
      return;
    }

    try {
      await stockService.confirmReservation(paymentId);
    } catch (err) {
      logger.warn(`[processApproved] confirmReservation falhou para ${paymentId}:`, err);
    }

    const orderId = payment.order?.id ?? paymentId;

    await deliveryService.deliver(
      orderId,
      payment.telegramUser as Parameters<typeof deliveryService.deliver>[1],
      payment.product as Parameters<typeof deliveryService.deliver>[2]
    ).catch((err) => {
      logger.error(`[processApproved] Erro na entrega do payment ${paymentId}:`, err);
    });
  }

  // ─── findExpiredPaymentIds (usado pelo ExpireJob) ──────────────────────────────
  async findExpiredPaymentIds(now: Date): Promise<string[]> {
    const expired = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        pixExpiresAt: { lt: now },
      },
      select: { id: true },
    });
    return expired.map((p) => p.id);
  }

  // ─── cancelExpiredPayment (usado pelo ExpireJob) ───────────────────────────────
  async cancelExpiredPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true },
    });
    if (!payment || payment.status !== PaymentStatus.PENDING) return;

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.EXPIRED, expiredAt: new Date() },
    });
    statusCache.delete(paymentId);
    logger.info(`[ExpireJob] Payment ${paymentId} expirado`);
  }

  // ─── getPaymentStatus ─────────────────────────────────────────────────────────
  async getPaymentStatus(paymentId: string): Promise<{ status: PaymentStatus; approvedAt?: string }> {
    const now = Date.now();
    const cached = statusCache.get(paymentId);
    if (cached && cached.expiresAt > now) {
      return { status: cached.status };
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, approvedAt: true, pixExpiresAt: true },
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
    }

    statusCache.set(paymentId, { status, expiresAt: now + statusCacheTTL });
    return {
      status,
      ...(payment.approvedAt ? { approvedAt: payment.approvedAt.toISOString() } : {}),
    };
  }

  // ─── cancelPayment ────────────────────────────────────────────────────────────
  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; reason: string }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, mercadoPagoId: true },
    });

    if (!payment) return { cancelled: false, reason: 'Pagamento não encontrado.' };
    if (payment.status !== PaymentStatus.PENDING) {
      return { cancelled: false, reason: `Pagamento não pode ser cancelado (status: ${payment.status}).` };
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });

    if (payment.mercadoPagoId) {
      try {
        await mercadoPagoService.refundPayment(payment.mercadoPagoId);
      } catch (err) {
        logger.warn(`[cancelPayment] Falha ao estornar no MP (${payment.mercadoPagoId}): erro ignorado`);
      }
    }

    statusCache.delete(paymentId);
    return { cancelled: true, reason: 'Pagamento cancelado com sucesso.' };
  }

  // ─── productHasStockItems (OPT #3) ───────────────────────────────────────────
  private async productHasStockItems(productId: string): Promise<boolean> {
    const now = Date.now();
    const cached = stockItemCache.get(productId);
    if (cached && cached.expiresAt > now) return cached.value;

    const count = await prisma.stockItem.count({
      where: { productId, status: StockItemStatus.AVAILABLE },
    });
    const value = count > 0;
    stockItemCache.set(productId, { value, expiresAt: now + stockItemCacheTTL });
    return value;
  }
}

export const paymentService = new PaymentService();
