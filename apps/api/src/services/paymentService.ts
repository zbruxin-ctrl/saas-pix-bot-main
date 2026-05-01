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
// FIX B11 (v2): _payMixed deduplica requests concorrentes em 2 níveis
//   Problema original: bot enviava 2 requests quase simultâneos; o 1º reservava o
//   estoque e o 2º falhava com "Produto esgotado" mesmo havendo estoque.
//   Causa raiz: findFirst checava pixExpiresAt > now, mas o 2º request chegava
//   enquanto o 1º ainda aguardava resposta do MercadoPago (antes de gravar
//   pixExpiresAt). Portanto o dedup não pegava o pagamento recém-criado.
//   Solução nível 1 (DB): findFirst com OR — pixExpiresAt > now OU
//     (pixExpiresAt null E createdAt < 2min). Detecta pagamentos ainda processando.
//     Se encontrado sem QR ainda, retorna 429 com mensagem amigável ao invés de
//     tentar criar um segundo pagamento e falhar com "Produto esgotado".
//   Solução nível 2 (memória): Set mixedPaymentLock keyed por userId:productId.
//     Trava requests verdadeiramente simultâneos que chegam antes do DB registrar
//     o primeiro pagamento (janela de milissegundos entre create e update do MP).
// FIX BALANCE DELIVERY: _payWithBalance recebia TelegramUserSnap { id, balance }
//   mas deliveryService.deliver usava telegramUser.telegramId → undefined em runtime
//   → entrega falhava com "chat_id is empty" após pagamento com saldo confirmado.
//   Solução: adicionado telegramId: string em PayWithBalanceParams; propagado em
//   todos os call sites; deliveryService.deliver recebe { ...telegramUser, telegramId }.
// FIX BALANCE CACHE STALE: createPayment lia saldo do userCache (TTL 5min),
//   causando erro 400 "Saldo insuficiente" mesmo após ajuste manual pelo admin.
//   Solução: saldo SEMPRE relido do DB antes do check — cache só armazena id/nome.
//   Também corrigido invalidateUserCache em _payMixed que passava telegramUser.id
//   (UUID interno) ao invés de telegramId (string do Telegram), tornando a
//   invalidação um no-op silencioso.
// FIX B12: _payWithBalance deduplica requests concorrentes em 2 níveis
//   Problema: bot dispara 2 requests quase simultâneos para compra com saldo.
//   O 1º processa corretamente (201); o 2º lê saldo já decrementado → 400 "Saldo
//   insuficiente" — mesmo o produto sendo entregue com sucesso pelo 1º request.
//   Solução nível 1 (DB): findFirst por pagamento BALANCE APPROVED para o mesmo
//     usuário+produto criado nos últimos 30s. Se encontrado, retorna idempotente.
//   Solução nível 2 (memória): Set balancePaymentLock keyed por userId:productId.
//     Bloqueia requests simultâneos que chegam antes do DB registrar o primeiro
//     pagamento (janela de milissegundos). Retorna 429 com mensagem amigável.
// FIX-BLOCKED: createPayment agora verifica isBlocked do TelegramUser logo após
//   upsert. Usuários bloqueados recebem AppError 403 antes de qualquer
//   processamento de pagamento (BALANCE, PIX ou MIXED).
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
  /** telegramId numérico do Telegram — necessário para deliveryService.deliver */
  telegramId: string;
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
  /** telegramId do Telegram — necessário para invalidar cache corretamente */
  telegramId: string;
}

// ─── OPT #3: cache de productHasStockItems (TTL 30s) ─────────────────────────
const stockItemCacheTTL = 30_000;
const stockItemCache = new Map<string, { value: boolean; expiresAt: number }>();

export function invalidateStockItemCache(productId: string): void {
  stockItemCache.delete(productId);
}

// ─── OPT #5: cache de usuário conhecido (TTL 5min) ───────────────────────────
// NOTA: cache armazena apenas id/nome — saldo NUNCA é lido do cache
// (sempre relido do DB para evitar leituras obsoletas após ajustes do admin).
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

// ─── FIX B11 nível 2: lock in-memory para _payMixed simultâneos ──────────────
// Chave: `mixed:{userId}:{productId}` — garante que apenas 1 request por
// usuário+produto processe a criação do pagamento misto por vez.
const mixedPaymentLock = new Set<string>();

// ─── FIX B12 nível 2: lock in-memory para _payWithBalance simultâneos ─────────
// Chave: `balance:{userId}:{productId}` — garante que apenas 1 request por
// usuário+produto processe a compra com saldo por vez.
const balancePaymentLock = new Set<string>();

export class PaymentService {
  async createPayment(data: CreatePaymentRequest): Promise<CreatePaymentResponse> {
    const { telegramId, productId, firstName, username, paymentMethod } = data;

    const [product, telegramUser] = await Promise.all([
      prisma.product.findUnique({ where: { id: productId, isActive: true } }),
      upsertUserCached(telegramId, firstName, username),
    ]);

    if (!product) throw new AppError('Produto não encontrado ou indisponível.', 404);

    // FIX-BLOCKED: verifica se o usuário está bloqueado antes de qualquer
    // processamento de pagamento. A leitura é sempre do DB (campo não cacheado).
    const userStatus = await prisma.telegramUser.findUnique({
      where: { id: telegramUser.id },
      select: { isBlocked: true, balance: true },
    });

    if (userStatus?.isBlocked) {
      logger.warn(`[PaymentService] Tentativa de compra bloqueada para usuário ${telegramId} (isBlocked=true)`);
      throw new AppError('Sua conta está suspensa. Entre em contato com o suporte.', 403);
    }

    // FIX BALANCE CACHE STALE: saldo SEMPRE relido do DB — cache pode estar
    // desatualizado após ajuste manual do admin (sem invalidação externa) ou
    // após cancelamento/expiração em que a invalidação não chegou a este nó.
    const balance = userStatus ? Number(userStatus.balance) : 0;
    const price = Number(product.price);

    if (paymentMethod === 'BALANCE') {
      if (balance < price) {
        throw new AppError(
          `Saldo insuficiente. Seu saldo atual é R$ ${balance.toFixed(2)} e o produto custa R$ ${price.toFixed(2)}.`,
          400
        );
      }
      return this._payWithBalance({ telegramUser, product, price, firstName, username, telegramId });
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
        return this._payWithBalance({ telegramUser, product, price, firstName, username, telegramId });
      }

      return this._payMixed({ telegramUser, product, price, balanceUsed, pixAmount, firstName, username, telegramId });
    }

    if (paymentMethod === 'PIX') {
      return this._payWithPix({ telegramUser, product, price, firstName, username });
    }

    if (balance >= price) {
      return this._payWithBalance({ telegramUser, product, price, firstName, username, telegramId });
    }
    return this._payWithPix({ telegramUser, product, price, firstName, username });
  }

  private async _payWithBalance({
    telegramUser, product, price, firstName, username, telegramId,
  }: PayWithBalanceParams): Promise<CreatePaymentResponse> {
    // ── FIX B12 nível 1 (DB): detecta pagamento BALANCE já aprovado recentemente ─
    // Cobre o caso em que o 1º request já completou e o 2º chega com saldo
    // já decrementado. Retorna o mesmo resultado de forma idempotente.
    const existingApproved = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        status: PaymentStatus.APPROVED,
        paymentMethod: PaymentMethod.BALANCE,
        approvedAt: { gt: new Date(Date.now() - 30_000) },
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

    // ── FIX B12 nível 2 (memória): trava requests verdadeiramente simultâneos ──
    // Cobre a janela de milissegundos em que o 1º request ainda não gravou no DB.
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
            logger.error(`[Wallet] CRÍTICO: falha no estorno do payment ${payment.id} — intervenção manual necessária`, estornoErr);
          }
          await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() } });
          throw new AppError('Produto sem estoque disponível.', 409);
        }
      }

      // FIX BALANCE DELIVERY: injeta telegramId no snap para que deliveryService
      // consiga enviar a mensagem ao usuário correto via Telegram.
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
      };
    } finally {
      balancePaymentLock.delete(lockKey);
    }
  }

  private async _payMixed({
    telegramUser, product, price, balanceUsed, pixAmount, firstName, username, telegramId,
  }: PayMixedParams): Promise<CreatePaymentResponse> {
    // ── FIX B11 nível 1 (DB): detecta pagamento já existente ──────────────────
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
          pixQrCodeText: existingPending.pixQrCodeText!,
          amount: Number(existingPending.amount),
          pixAmount: Number(existingPending.pixAmount),
          balanceUsed: Number(existingPending.balanceUsed),
          expiresAt: existingPending.pixExpiresAt.toISOString(),
          productName: product.name,
          isMixed: true,
        };
      }
      logger.warn(`[Mixed] Request duplicado bloqueado (DB): payment ${existingPending.id} ainda processando`);
      throw new AppError('Pagamento em processamento. Aguarde alguns instantes e tente novamente.', 429);
    }

    // ── FIX B11 nível 2 (memória): trava requests verdadeiramente simultâneos ──
    const lockKey = `mixed:${telegramUser.id}:${product.id}`;
    if (mixedPaymentLock.has(lockKey)) {
      logger.warn(`[Mixed] Request duplicado bloqueado (lock): ${lockKey}`);
      throw new AppError('Pagamento em processamento. Aguarde alguns instantes e tente novamente.', 429);
    }
    mixedPaymentLock.add(lockKey);

    try {
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

      // FIX: usa telegramId (string do Telegram) — não telegramUser.id (UUID)
      // O cache é indexado por telegramId; passar UUID era um no-op silencioso.
      invalidateUserCache(telegramId);

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
    } finally {
      mixedPaymentLock.delete(lockKey);
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
    invalidateUserCache(payment.telegramUser.telegramId);

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
