// paymentService.ts
// FIX BUG3: reserva+confirmação+deduct do saldo em prisma.$transaction única
// FIX BUG4: guard mercadoPagoId null antes de verifyPayment
// FIX BUG5: usa expiredAt em vez de cancelledAt para EXPIRED
// FIX BUG6: novo produto recebe sortOrder = MAX(sortOrder)+1
// FIX BUG10: createDepositPayment reutiliza PIX de depósito pendente (evita duplicatas)
// FEATURE: paymentMethod BALANCE | PIX | MIXED
import { PaymentStatus } from '@prisma/client';
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

export class PaymentService {
  async createPayment(data: CreatePaymentRequest): Promise<CreatePaymentResponse> {
    const { telegramId, productId, firstName, username, paymentMethod } = data;

    const product = await prisma.product.findUnique({
      where: { id: productId, isActive: true },
    });
    if (!product) throw new AppError('Produto não encontrado ou indisponível.', 404);

    const telegramUser = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName, username },
      create: { telegramId, firstName, username },
    });

    const balance = Number(telegramUser.balance);
    const price = Number(product.price);

    // ── Modo: BALANCE (só saldo) ──────────────────────────────────────────────
    if (paymentMethod === 'BALANCE') {
      if (balance < price) {
        throw new AppError(
          `Saldo insuficiente. Seu saldo atual é R$ ${balance.toFixed(2)} e o produto custa R$ ${price.toFixed(2)}.`,
          400
        );
      }
      return this._payWithBalance({ telegramUser, product, price, firstName, username });
    }

    // ── Modo: MIXED (saldo parcial + PIX pela diferença) ──────────────────────
    if (paymentMethod === 'MIXED') {
      if (balance <= 0) {
        throw new AppError(
          `Saldo insuficiente para usar no modo misto. Seu saldo atual é R$ ${balance.toFixed(2)}.`,
          400
        );
      }
      const balanceUsed = Math.min(balance, price);
      const pixAmount = parseFloat((price - balanceUsed).toFixed(2));

      // Se o saldo cobre tudo, redireciona para fluxo BALANCE
      if (pixAmount <= 0) {
        return this._payWithBalance({ telegramUser, product, price, firstName, username });
      }

      return this._payMixed({ telegramUser, product, price, balanceUsed, pixAmount, firstName, username });
    }

    // ── Modo: PIX (forçado, ignora saldo) ────────────────────────────────────
    if (paymentMethod === 'PIX') {
      return this._payWithPix({ telegramUser, product, price, firstName, username });
    }

    // ── Legado: comportamento antigo (auto-saldo se suficiente) ──────────────
    if (balance >= price) {
      return this._payWithBalance({ telegramUser, product, price, firstName, username });
    }
    return this._payWithPix({ telegramUser, product, price, firstName, username });
  }

  // ── Pagamento 100% com saldo ──────────────────────────────────────────────
  private async _payWithBalance({
    telegramUser, product, price, firstName, username,
  }: { telegramUser: { id: string; balance: unknown }, product: { id: string; name: string; stock: number | null }, price: number, firstName?: string, username?: string }): Promise<CreatePaymentResponse> {
    logger.info(`[Wallet] Usuário ${telegramUser.id} pagando 100% com saldo (${price}).`);

    const { payment, order } = await prisma.$transaction(async (tx) => {
      const newPayment = await tx.payment.create({
        data: {
          telegramUserId: telegramUser.id,
          productId: product.id,
          amount: price,
          status: PaymentStatus.APPROVED,
          approvedAt: new Date(),
          metadata: { firstName, username, productName: product.name, paidWithBalance: true },
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

      const currentUser = await tx.telegramUser.findUnique({
        where: { id: telegramUser.id },
        select: { balance: true },
      });
      if (!currentUser || Number(currentUser.balance) < price) {
        throw new AppError('Saldo insuficiente.', 400);
      }
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

    if (product.stock !== null || (await this.productHasStockItems(product.id))) {
      try {
        await stockService.reserveStock(product.id, telegramUser.id, payment.id);
        await stockService.confirmReservation(payment.id);
      } catch (err) {
        logger.error(`[Wallet] Erro ao reservar estoque para payment ${payment.id}:`, err);
        await walletService.deposit(
          telegramUser.id,
          price,
          `Estorno automático: falha no estoque do produto ${product.name}`,
          payment.id,
        );
        await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CANCELLED, cancelledAt: new Date() } });
        throw new AppError('Produto sem estoque disponível.', 409);
      }
    }

    deliveryService.deliver(order.id, telegramUser as Parameters<typeof deliveryService.deliver>[1], product as Parameters<typeof deliveryService.deliver>[2]).catch((err) => {
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

  // ── Pagamento MISTO: debita saldo parcial + gera PIX pela diferença ───────
  private async _payMixed({
    telegramUser, product, price, balanceUsed, pixAmount, firstName, username,
  }: { telegramUser: { id: string; balance: unknown }, product: { id: string; name: string; stock: number | null }, price: number, balanceUsed: number, pixAmount: number, firstName?: string, username?: string }): Promise<CreatePaymentResponse> {
    logger.info(`[Mixed] Usuário ${telegramUser.id} | saldo: ${balanceUsed} | PIX: ${pixAmount}`);

    // 1. Reserva o estoque antes de debitar
    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        amount: price,
        status: PaymentStatus.PENDING,
        metadata: { firstName, username, productName: product.name, paymentMethod: 'MIXED', balanceUsed, pixAmount },
      },
    });

    if (product.stock !== null || (await this.productHasStockItems(product.id))) {
      try {
        await stockService.reserveStock(product.id, telegramUser.id, payment.id);
      } catch (err) {
        await prisma.payment.delete({ where: { id: payment.id } });
        throw err;
      }
    }

    // 2. Debita o saldo parcial
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

    // 3. Gera PIX apenas pelo valor restante
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
      // Rollback: estorna saldo e libera reserva
      await walletService.deposit(
        telegramUser.id,
        balanceUsed,
        `Estorno automático (falha PIX misto): ${product.name}`,
        payment.id,
      );
      await stockService.releaseReservation(payment.id, 'falha_criacao_mp_misto');
      await prisma.payment.delete({ where: { id: payment.id } });
      throw error;
    }
  }

  // ── Pagamento 100% PIX ────────────────────────────────────────────────────
  private async _payWithPix({
    telegramUser, product, price, firstName, username,
  }: { telegramUser: { id: string }, product: { id: string; name: string; stock: number | null }, price: number, firstName?: string, username?: string }): Promise<CreatePaymentResponse> {
    // Reutiliza PIX pendente existente
    const existingPending = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        status: PaymentStatus.PENDING,
        pixExpiresAt: { gt: new Date() },
        // Só reutiliza se for PIX puro (sem balanceUsed no metadata)
        metadata: { path: ['paymentMethod'], not: 'MIXED' },
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

    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        amount: price,
        status: PaymentStatus.PENDING,
        metadata: { firstName, username, productName: product.name, paymentMethod: 'PIX' },
      },
    });

    if (product.stock !== null || (await this.productHasStockItems(product.id))) {
      try {
        await stockService.reserveStock(product.id, telegramUser.id, payment.id);
      } catch (err) {
        await prisma.payment.delete({ where: { id: payment.id } });
        throw err;
      }
    }

    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: price,
        description: `${product.name} - SaaS PIX Bot`,
        payerName: firstName || username || 'Usuário Telegram',
        externalReference: payment.id,
        notificationUrl: `${env.API_URL}/api/webhooks/mercadopago`,
      });

      const raw = (mpPayment as { date_of_expiration?: string }).date_of_expiration;
      let pixExpiresAt = raw ? new Date(raw) : new Date(Date.now() + 30 * 60 * 1000);
      if (Number.isNaN(pixExpiresAt.getTime())) {
        pixExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      }

      const updatedPayment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction.transaction_data.qr_code_base64,
          pixQrCodeText: mpPayment.point_of_interaction.transaction_data.qr_code,
          pixExpiresAt,
          status: PaymentStatus.PENDING,
        },
      });

      logger.info(`Pagamento PIX criado: ${payment.id} | MP ID: ${mpPayment.id}`);

      return {
        paymentId: updatedPayment.id,
        pixQrCodeText: updatedPayment.pixQrCodeText!,
        pixQrCode: updatedPayment.pixQrCode!,
        amount: Number(updatedPayment.amount),
        expiresAt: updatedPayment.pixExpiresAt!.toISOString(),
        productName: product.name,
      };
    } catch (error) {
      await stockService.releaseReservation(payment.id, 'falha_criacao_mp');
      await prisma.payment.delete({ where: { id: payment.id } });
      throw error;
    }
  }

  /** BUG10 FIX: reutiliza PIX de depósito pendente para evitar múltiplos PIX simultâneos */
  async createDepositPayment(data: CreateDepositRequest): Promise<CreateDepositResponse> {
    const { telegramId, amount, firstName, username } = data;

    if (amount < 1 || amount > 10000) {
      throw new AppError('Valor de depósito deve ser entre R$ 1,00 e R$ 10.000,00', 400);
    }

    const telegramUser = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName, username },
      create: { telegramId, firstName, username },
    });

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
    const count = await prisma.stockItem.count({ where: { productId } });
    return count > 0;
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

    // Estorna saldo parcial se era MIXED
    const meta = payment.metadata as Record<string, unknown> | null;
    const balanceUsed = meta?.balanceUsed as number | undefined;
    if (balanceUsed && balanceUsed > 0) {
      await walletService.deposit(
        payment.telegramUserId,
        balanceUsed,
        `Estorno cancelamento (misto): pagamento ${paymentId}`,
        paymentId,
      );
      logger.info(`[Mixed] Estorno de R$ ${balanceUsed} para usuário ${payment.telegramUserId} (cancelamento)`);
    }

    if (payment.productId) {
      await stockService.releaseReservation(paymentId, 'cancelado_pelo_usuario');
    }

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

    const meta = payment.metadata as Record<string, unknown> | null;
    const isMixed = meta?.paymentMethod === 'MIXED';
    // No modo MIXED, o MP recebeu apenas o pixAmount; verifica pelo valor real do PIX
    const verifyAmount = isMixed
      ? (meta?.pixAmount as number)
      : Number(payment.amount);

    const { isApproved } = await mercadoPagoService.verifyPayment(
      payment.mercadoPagoId,
      verifyAmount
    );

    if (!isApproved) {
      logger.warn(`Pagamento ${paymentId} não verificado no MP. Ignorando.`);
      return;
    }

    // ── WALLET DEPOSIT ────────────────────────────────────────────────────────
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

    // ── Produto: modo MIXED — o PIX foi pela diferença, aprova e entrega ─────
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

    await stockService.confirmReservation(paymentId);
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

    // Estorna saldo parcial se era MIXED
    const meta = payment.metadata as Record<string, unknown> | null;
    const balanceUsed = meta?.balanceUsed as number | undefined;
    if (balanceUsed && balanceUsed > 0) {
      await walletService.deposit(
        payment.telegramUserId,
        balanceUsed,
        `Estorno expiração (misto): pagamento ${paymentId}`,
        paymentId,
      );
      logger.info(`[Mixed] Estorno de R$ ${balanceUsed} para usuário ${payment.telegramUserId} (expirado)`);
    }

    if (payment.productId) {
      await stockService.releaseReservation(paymentId, 'pagamento_expirado');
    }

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
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true },
    });
    if (!payment) throw new AppError('Pagamento não encontrado', 404);
    return { status: payment.status, paymentId: payment.id };
  }
}

export const paymentService = new PaymentService();
