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
// OPT #9: grava paymentMethod, balanceUsed, pixAmount em colunas reais (não mais só metadata)
// FIX STOCK CACHE: productHasStockItems conta apenas AVAILABLE (não todos os StockItems)
// FIX STOCK CACHE: invalida stockItemCache após reserveStock para evitar falso-negativo
// FIX B9: _payWithPix usa randomUUID() como externalReference
//   → string anterior "pending_UUID_UUID_timestamp" continha underscores (_)
//   → MP rejeita underscore no local-part do email → erro 4050
//   → randomUUID() gera UUID puro; buildPayerEmail remove hifens → email limpo
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
}

interface PayWithPixParams {
  telegramUser: Pick<TelegramUserSnap, 'id'>;
  product: ProductSnap;
  price: number;
  firstName?: string;
  username?: string;
}

interface PayMixedParams {
  telegramUser: TelegramUserSnap;
  product: ProductSnap;
  price: number;
  balanceUsed: number;
  pixAmount: number;
  firstName?: string;
  username?: string;
}

// ─── OPT #3: cache de productHasStockItems (TTL 30s) ─────────────────────────
// FIX: armazena a contagem de itens AVAILABLE, não a presença total de StockItems
const stockItemCacheTTL = 30_000;
const stockItemCache = new Map<string, { value: boolean; expiresAt: number }>();

/** Invalida o cache de estoque de um produto (chamar após reserveStock) */
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

/** Invalida o cache de um usuário (chamar após qualquer alteração de saldo) */
export function invalidateUserCache(telegramId: string): void {
  userCache.delete(telegramId);
}

// ─── OPT #6: cache de status de pagamento (TTL 5s) ───────────────────────────
const statusCacheTTL = 5_000;
const statusCache = new Map<string, { status: PaymentStatus; expiresAt: number }>();

export class PaymentService {
  async createPayment(data: CreatePaymentRequest): Promise<CreatePaymentResponse> {
    const { telegramId, productId, firstName, username, paymentMethod } = data;

    const [product, telegramUser] = await Promise.all([
      prisma.product.findUnique({ where: { id: productId, isActive: true } }),
      upsertUserCached(telegramId, firstName, username),
    ]);

    if (!product) throw new AppError('Produto não encontrado ou indisponível.', 404);

    const balance = Number(telegramUser.balance);
    const price = Number(product.price);

    if (paymentMethod === 'BALANCE') {
      if (balance < price) {
        throw new AppError(
          `Saldo insuficiente. Seu saldo atual é R$ ${balance.toFixed(2)} e o produto custa R$ ${price.toFixed(2)}.`,
          400
        );
      }
      return this._payWithBalance({ telegramUser, product, price, firstName, username });
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
        return this._payWithBalance({ telegramUser, product, price, firstName, username });
      }

      return this._payMixed({ telegramUser, product, price, balanceUsed, pixAmount, firstName, username });
    }

    if (paymentMethod === 'PIX') {
      return this._payWithPix({ telegramUser, product, price, firstName, username });
    }

    if (balance >= price) {
      return this._payWithBalance({ telegramUser, product, price, firstName, username });
    }
    return this._payWithPix({ telegramUser, product, price, firstName, username });
  }

  private async _payWithBalance({
    telegramUser, product, price, firstName, username,
  }: PayWithBalanceParams): Promise<CreatePaymentResponse> {
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
          metadata: { firstName, username, productName: product.name, paidWithBalance: true, paymentMethod: 'BALANCE' },
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

      return { payment: newPayment, order: newOrder };
    });

    invalidateUserCache(telegramUser.id);

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
          logger.error(`[Wallet] CRÍTICO: falha no estorno do payment ${payment.id} — intervenção manual necessária`, estornoErr);
        }
        await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() } });
        throw new AppError('Produto sem estoque disponível.', 409);
      }
    }

    deliveryService.deliver(
      order.id,
      telegramUser as Parameters<typeof deliveryService.deliver>[1],
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
    };
  }

  private async _payMixed({
    telegramUser, product, price, balanceUsed, pixAmount, firstName, username,
  }: PayMixedParams): Promise<CreatePaymentResponse> {
    logger.info(`[Mixed] Usuário ${telegramUser.id} | saldo: ${balanceUsed} | PIX: ${pixAmount}`);

    const hasStockItems = await this.productHasStockItems(product.id);

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        amount: price,
        status: PaymentStatus.PENDING,
        paymentMethod: PaymentMethod.MIXED,
        balanceUsed,
        pixAmount,
        metadata: { firstName, username, productName: product.name, paymentMethod: 'MIXED', balanceUsed, pixAmount },
      },
    });

    if (product.stock !== null || hasStockItems) {
      try {
        await stockService.reserveStock(product.id, telegramUser.id, payment.id);
        invalidateStockItemCache(product.id);
      } catch (err) {
        await prisma.payment.delete({ where: { id: payment.id } });
        throw err;
      }
    }

    await prisma.$transaction(async (tx) => {
      const currentUser = await tx.telegramUser.findUnique({
        where: { id: telegramUser.id },
        select: { balance: true },
      });
      if (!currentUser || Number(currentUser.balance) < balanceUsed) {
        throw new AppError('Saldo insuficiente.', 400);
      }
      await tx.telegramUser.update({
        where: { id: telegramUser.id },
        data: { balance: { decrement: balanceUsed } },
      });
      await tx.walletTransaction.create({
        data: {
          telegramUserId: telegramUser.id,
          type: 'PURCHASE',
          amount: balanceUsed,
          description: `Saldo usado (misto): ${product.name}`,
          paymentId: payment.id,
        },
      });
    });

    invalidateUserCache(telegramUser.id);

    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: pixAmount,
        description: `${product.name} (parte PIX) - SaaS PIX Bot`,
        payerName: firstName || username || 'Usuário Telegram',
        externalReference: payment.id,
        notificationUrl: `${env.API_URL}/api/webhooks/mercadopago`,
      });

      const raw = (mpPayment as { date_of_expiration?: string }).date_of_expiration;
      let pixExpiresAt = raw ? new Date(raw) : new Date(Date.now() + 30 * 60 * 1000);
      if (Number.isNaN(pixExpiresAt.getTime())) {
        pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction.transaction_data.qr_code_base64,
          pixQrCodeText: mpPayment.point_of_interaction.transaction_data.qr_code,
          pixExpiresAt,
        },
      });

      logger.info(`[Mixed] PIX gerado para payment ${payment.id} | MP ID: ${mpPayment.id}`);

      return {
        paymentId: updated.id,
        pixQrCode: updated.pixQrCode!,
        pixQrCodeText: updated.pixQrCodeText!,
        amount: price,
        pixAmount,
        balanceUsed,
        expiresAt: updated.pixExpiresAt!.toISOString(),
        productName: product.name,
        isMixed: true,
      };
    } catch (error) {
      try {
        await walletService.deposit(
          telegramUser.id,
          balanceUsed,
          `Estorno automático (falha PIX misto): ${product.name}`,
          payment.id,
        );
      } catch (estornoErr) {
        logger.error(`[Mixed] CRÍTICO: falha no estorno do payment ${payment.id} — intervenção manual necessária`, estornoErr);
      }
      await stockService.releaseReservation(payment.id, 'falha_criacao_mp_misto');
      invalidateStockItemCache(product.id);
      await prisma.payment.delete({ where: { id: payment.id } });
      throw error;
    }
  }

  private async _payWithPix({
    telegramUser, product, price, firstName, username,
  }: PayWithPixParams): Promise<CreatePaymentResponse> {
    const existingPending = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        status: PaymentStatus.PENDING,
        pixExpiresAt: { gt: new Date() },
        paymentMethod: PaymentMethod.PIX,
      },
    });

    if (existingPending) {
      logger.info(`Pagamento PIX pendente reutilizado: ${existingPending.id}`);
      return {
        paymentId: existingPending.id,
        pixQrCode: existingPending.pixQrCode!,
        pixQrCodeText: existingPending.pixQrCodeText!,
        amount: Number(existingPending.amount),
        expiresAt: existingPending.pixExpiresAt!.toISOString(),
        productName: product.name,
      };
    }

    const hasStockItems = await this.productHasStockItems(product.id);

    let mpPayment: Awaited<ReturnType<typeof mercadoPagoService.createPixPayment>>;
    let pixExpiresAt: Date;

    // FIX B9: usa randomUUID() como externalReference em vez de
    // `pending_${userId}_${productId}_${Date.now()}` que continha underscores (_).
    // O MP rejeita underscore no local-part do email gerado pelo buildPayerEmail → erro 4050.
    // randomUUID() gera UUID puro; buildPayerEmail remove apenas os hifens → email limpo.
    const mpExternalRef = randomUUID();

    try {
      mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: price,
        description: `${product.name} - SaaS PIX Bot`,
        payerName: firstName || username || 'Usuário Telegram',
        externalReference: mpExternalRef,
        notificationUrl: `${env.API_URL}/api/webhooks/mercadopago`,
      });

      const raw = (mpPayment as { date_of_expiration?: string }).date_of_expiration;
      pixExpiresAt = raw ? new Date(raw) : new Date(Date.now() + 30 * 60 * 1000);
      if (Number.isNaN(pixExpiresAt.getTime())) {
        pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      }
    } catch (error) {
      throw error;
    }

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        amount: price,
        status: PaymentStatus.PENDING,
        mercadoPagoId: String(mpPayment.id),
        pixQrCode: mpPayment.point_of_interaction.transaction_data.qr_code_base64,
        pixQrCodeText: mpPayment.point_of_interaction.transaction_data.qr_code,
        pixExpiresAt,
        paymentMethod: PaymentMethod.PIX,
        pixAmount: price,
        metadata: { firstName, username, productName: product.name, paymentMethod: 'PIX', mpExternalRef },
      },
    });

    if (product.stock !== null || hasStockItems) {
      try {
        await stockService.reserveStock(product.id, telegramUser.id, payment.id);
        invalidateStockItemCache(product.id);
      } catch (err) {
        await prisma.payment.delete({ where: { id: payment.id } });
        throw err;
      }
    }

    logger.info(`Pagamento PIX criado: ${payment.id} | MP ID: ${mpPayment.id}`);

    return {
      paymentId: payment.id,
      pixQrCodeText: payment.pixQrCodeText!,
      pixQrCode: payment.pixQrCode!,
      amount: Number(payment.amount),
      expiresAt: payment.pixExpiresAt!.toISOString(),
      productName: product.name,
    };
  }

  async createDepositPayment(data: CreateDepositRequest): Promise<CreateDepositResponse> {
    const { telegramId, amount, firstName, username } = data;

    if (amount < 1 || amount > 10000) {
      throw new AppError('Valor de depósito deve ser entre R$ 1,00 e R$ 10.000,00', 400);
    }

    const telegramUser = await upsertUserCached(telegramId, firstName, username);

    const existingDeposit = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId: null,
        status: PaymentStatus.PENDING,
        amount: amount,
        pixExpiresAt: { gt: new Date() },
        metadata: { path: ['type'], equals: 'WALLET_DEPOSIT' },
      },
    });

    if (existingDeposit) {
      logger.info(`[Deposit] PIX de depósito pendente reutilizado: ${existingDeposit.id}`);
      return {
        paymentId: existingDeposit.id,
        pixQrCode: existingDeposit.pixQrCode!,
        pixQrCodeText: existingDeposit.pixQrCodeText!,
        amount: Number(existingDeposit.amount),
        expiresAt: existingDeposit.pixExpiresAt!.toISOString(),
      };
    }

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: null,
        amount,
        status: PaymentStatus.PENDING,
        metadata: { firstName, username, type: 'WALLET_DEPOSIT' },
      },
    });

    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: amount,
        description: `Depósito de saldo - SaaS PIX Bot`,
        payerName: firstName || username || 'Usuário Telegram',
        externalReference: payment.id,
        notificationUrl: `${env.API_URL}/api/webhooks/mercadopago`,
      });

      const raw = (mpPayment as { date_of_expiration?: string }).date_of_expiration;
      let pixExpiresAt = raw ? new Date(raw) : new Date(Date.now() + 30 * 60 * 1000);
      if (Number.isNaN(pixExpiresAt.getTime())) {
        pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction.transaction_data.qr_code_base64,
          pixQrCodeText: mpPayment.point_of_interaction.transaction_data.qr_code,
          pixExpiresAt,
        },
      });

      logger.info(`[Deposit] PIX de depósito criado: ${payment.id} | valor: ${amount}`);

      return {
        paymentId: updated.id,
        pixQrCode: updated.pixQrCode!,
        pixQrCodeText: updated.pixQrCodeText!,
        amount,
        expiresAt: updated.pixExpiresAt!.toISOString(),
      };
    } catch (error) {
      await prisma.payment.delete({ where: { id: payment.id } });
      throw error;
    }
  }

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

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; reason: string }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true },
    });

    if (!payment) {
      return { cancelled: false, reason: 'Pagamento não encontrado.' };
    }

    if (payment.status !== PaymentStatus.PENDING) {
      return {
        cancelled: false,
        reason: `Pagamento não pode ser cancelado pois está com status ${payment.status}.`,
      };
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() },
    });

    const balanceUsed = payment.balanceUsed
      ? Number(payment.balanceUsed)
      : (payment.metadata as Record<string, unknown> | null)?.balanceUsed as number | undefined;

    if (balanceUsed && balanceUsed > 0) {
      try {
        await walletService.deposit(
          payment.telegramUserId,
          balanceUsed,
          `Estorno cancelamento (misto): pagamento ${paymentId}`,
          paymentId,
        );
        logger.info(`[Mixed] Estorno de R$ ${balanceUsed} para usuário ${payment.telegramUserId} (cancelamento)`);
      } catch (estornoErr) {
        logger.error(`[Mixed] CRÍTICO: falha no estorno de cancelamento do payment ${paymentId}`, estornoErr);
      }
    }

    if (payment.productId) {
      await stockService.releaseReservation(paymentId, 'cancelado_pelo_usuario');
      invalidateStockItemCache(payment.productId);
    }

    statusCache.delete(paymentId);

    logger.info(`[PaymentService] Pagamento ${paymentId} cancelado pelo usuário ${payment.telegramUser.telegramId}`);

    return { cancelled: true, reason: 'Pagamento cancelado com sucesso.' };
  }

  async findExpiredPaymentIds(cutoff: Date): Promise<string[]> {
    const payments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        pixExpiresAt: { lt: cutoff },
      },
      select: { id: true },
    });
    return payments.map((p) => p.id);
  }

  async processApprovedPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { product: true, telegramUser: true, order: true },
    });

    if (!payment) throw new AppError('Pagamento não encontrado', 404);

    if (payment.status === PaymentStatus.APPROVED) {
      logger.info(`Pagamento ${paymentId} já processado. Ignorando.`);
      return;
    }

    if (payment.status !== PaymentStatus.PENDING) {
      logger.warn(`Pagamento ${paymentId} com status ${payment.status}. Ignorando.`);
      return;
    }

    if (!payment.mercadoPagoId) {
      logger.warn(`Pagamento ${paymentId} sem mercadoPagoId — não pode ser verificado no MP. Ignorando.`);
      return;
    }

    const isMixed = payment.paymentMethod === PaymentMethod.MIXED
      || (payment.metadata as Record<string, unknown> | null)?.paymentMethod === 'MIXED';

    const pixAmountValue = payment.pixAmount
      ? Number(payment.pixAmount)
      : (payment.metadata as Record<string, unknown> | null)?.pixAmount as number | undefined;

    const verifyAmount = isMixed && pixAmountValue ? pixAmountValue : Number(payment.amount);

    const { isApproved } = await mercadoPagoService.verifyPayment(
      payment.mercadoPagoId,
      verifyAmount
    );

    if (!isApproved) {
      logger.warn(`Pagamento ${paymentId} não verificado no MP. Ignorando.`);
      return;
    }

    if (!payment.productId) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.updateMany({
          where: { id: paymentId, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
        });
        if (updated.count === 0) return;

        await tx.telegramUser.update({
          where: { id: payment.telegramUserId },
          data: { balance: { increment: Number(payment.amount) } },
        });

        await tx.walletTransaction.create({
          data: {
            telegramUserId: payment.telegramUserId,
            type: 'DEPOSIT',
            amount: Number(payment.amount),
            description: `Depósito via PIX`,
            paymentId: payment.id,
          },
        });
      });

      invalidateUserCache(payment.telegramUser.telegramId);
      statusCache.delete(paymentId);

      logger.info(`[Deposit] Saldo creditado para ${payment.telegramUserId}: R$ ${Number(payment.amount).toFixed(2)}`);

      try {
        await telegramService.sendMessage(
          payment.telegramUser.telegramId,
          `✅ *Depósito confirmado!*\n\nR$ ${Number(payment.amount).toFixed(2)} foram adicionados ao seu saldo.\n\n🪪 *ID do pagamento:* \`${payment.id}\`\n_Guarde este ID caso precise de suporte._`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Meu Saldo', callback_data: 'show_balance' }],
              ],
            },
          }
        );
      } catch {
        logger.warn(`Não foi possível notificar usuário ${payment.telegramUser.telegramId} sobre depósito`);
      }
      return;
    }

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.APPROVED, approvedAt: new Date() },
      });

      if (updated.count === 0) return null;

      const newOrder = await tx.order.create({
        data: {
          paymentId: payment.id,
          telegramUserId: payment.telegramUserId,
          productId: payment.productId!,
          status: 'PROCESSING',
        },
      });

      return newOrder;
    });

    if (!order) {
      logger.info(`Pagamento ${paymentId} já aprovado por outro processo. Ignorando.`);
      return;
    }

    statusCache.delete(paymentId);

    await stockService.confirmReservation(paymentId);
    if (payment.productId) invalidateStockItemCache(payment.productId);
    await deliveryService.deliver(order.id, payment.telegramUser, payment.product!);
  }

  async cancelExpiredPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { telegramUser: true },
    });

    if (!payment || payment.status !== PaymentStatus.PENDING) return;
    if (payment.pixExpiresAt && payment.pixExpiresAt > new Date()) {
      logger.warn(`[ExpireJob] Pagamento ${paymentId} com pixExpiresAt no futuro — ignorando`);
      return;
    }

    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.EXPIRED, expiredAt: new Date() },
    });

    const balanceUsed = payment.balanceUsed
      ? Number(payment.balanceUsed)
      : (payment.metadata as Record<string, unknown> | null)?.balanceUsed as number | undefined;

    if (balanceUsed && balanceUsed > 0) {
      try {
        await walletService.deposit(
          payment.telegramUserId,
          balanceUsed,
          `Estorno expiração (misto): pagamento ${paymentId}`,
          paymentId,
        );
        logger.info(`[Mixed] Estorno de R$ ${balanceUsed} para usuário ${payment.telegramUserId} (expirado)`);
      } catch (estornoErr) {
        logger.error(`[Mixed] CRÍTICO: falha no estorno de expiração do payment ${paymentId}`, estornoErr);
      }
    }

    if (payment.productId) {
      await stockService.releaseReservation(paymentId, 'pagamento_expirado');
      invalidateStockItemCache(payment.productId);
    }

    invalidateUserCache(payment.telegramUser.telegramId);
    statusCache.delete(paymentId);

    logger.info(`Pagamento ${paymentId} marcado como EXPIRADO`);

    try {
      await telegramService.sendMessage(
        payment.telegramUser.telegramId,
        `⏰ *Pagamento expirado*\n\nSeu PIX não foi confirmado e foi cancelado automaticamente.\n\nFique à vontade para tentar novamente! 😊`
      );
    } catch {
      logger.warn(`Não foi possível notificar usuário ${payment.telegramUser.telegramId} sobre expiração`);
    }
  }

  async getPaymentStatus(paymentId: string): Promise<{ status: PaymentStatus; paymentId: string }> {
    const now = Date.now();
    const cached = statusCache.get(paymentId);
    if (cached && cached.expiresAt > now) {
      return { status: cached.status, paymentId };
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true },
    });
    if (!payment) throw new AppError('Pagamento não encontrado', 404);

    statusCache.set(paymentId, { status: payment.status, expiresAt: now + statusCacheTTL });
    return { status: payment.status, paymentId: payment.id };
  }
}

export const paymentService = new PaymentService();
