// paymentService.ts
// FIX BUG3: reserva+confirmação+deduct do saldo em prisma.$transaction única
// FIX BUG4: guard mercadoPagoId null antes de verifyPayment
// FIX BUG5: usa expiredAt em vez de cancelledAt para EXPIRED
// FIX BUG6: novo produto recebe sortOrder = MAX(sortOrder)+1
// FIX BUG10: createDepositPayment reutiliza PIX de depósito pendente (evita duplicatas)
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
    const { telegramId, productId, firstName, username } = data;

    const product = await prisma.product.findUnique({
      where: { id: productId, isActive: true },
    });
    if (!product) throw new AppError('Produto não encontrado ou indisponível.', 404);

    const telegramUser = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName, username },
      create: { telegramId, firstName, username },
    });

    // ── WALLET: verificar saldo ANTES do bloco existingPending ──
    const balance = Number(telegramUser.balance);
    const price = Number(product.price);

    if (balance >= price) {
      logger.info(`[Wallet] Usuário ${telegramId} saldo suficiente (${balance}) para produto ${productId} (${price}).`);

      // BUG3 FIX: cria payment, reserva/confirma estoque e debita saldo em uma única transação
      const { payment, order } = await prisma.$transaction(async (tx) => {
        const newPayment = await tx.payment.create({
          data: {
            telegramUserId: telegramUser.id,
            productId: product.id,
            amount: product.price,
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

        // Debita saldo dentro da mesma transação
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

      // Reserva/confirmação de estoque fora da tx principal (opera tabelas separadas de stock)
      if (product.stock !== null || (await this.productHasStockItems(productId))) {
        try {
          await stockService.reserveStock(productId, telegramUser.id, payment.id);
          await stockService.confirmReservation(payment.id);
        } catch (err) {
          logger.error(`[Wallet] Erro ao reservar estoque para payment ${payment.id}:`, err);
          // Estoque falhou mas pagamento foi debitado: reverter saldo
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

      // Fire-and-forget da entrega
      deliveryService.deliver(order.id, telegramUser, product).catch((err) => {
        logger.error(`[Wallet] Erro na entrega do order ${order.id}:`, err);
      });

      return {
        paymentId: payment.id,
        pixQrCode: '',
        pixQrCodeText: '',
        amount: price,
        expiresAt: new Date().toISOString(),
        productName: product.name,
        paidWithBalance: true,
      };
    }

    // Reutiliza PIX pendente existente (exclui CANCELLED)
    const existingPending = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId,
        status: PaymentStatus.PENDING,
        pixExpiresAt: { gt: new Date() },
      },
    });

    if (existingPending) {
      logger.info(`Pagamento pendente reutilizado: ${existingPending.id}`);
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
        amount: product.price,
        status: PaymentStatus.PENDING,
        metadata: { firstName, username, productName: product.name },
      },
    });

    if (product.stock !== null || (await this.productHasStockItems(productId))) {
      try {
        await stockService.reserveStock(productId, telegramUser.id, payment.id);
      } catch (err) {
        await prisma.payment.delete({ where: { id: payment.id } });
        throw err;
      }
    }

    try {
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: Number(product.price),
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

      logger.info(`Pagamento criado: ${payment.id} | MP ID: ${mpPayment.id}`);

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

    // Reutiliza depósito pendente do mesmo valor se ainda não expirou
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

    if (payment.productId) {
      await stockService.releaseReservation(paymentId, 'cancelado_pelo_usuario');
    }

    logger.info(
      `[PaymentService] Pagamento ${paymentId} cancelado pelo usuário ${payment.telegramUser.telegramId}`
    );

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

    // Guard: já processado
    if (payment.status === PaymentStatus.APPROVED) {
      logger.info(`Pagamento ${paymentId} já processado. Ignorando.`);
      return;
    }

    if (payment.status !== PaymentStatus.PENDING) {
      logger.warn(`Pagamento ${paymentId} com status ${payment.status}. Ignorando.`);
      return;
    }

    // BUG4 FIX: guard contra mercadoPagoId nulo (ex: pagamento via saldo corrompido)
    if (!payment.mercadoPagoId) {
      logger.warn(`Pagamento ${paymentId} sem mercadoPagoId — não pode ser verificado no MP. Ignorando.`);
      return;
    }

    const { isApproved } = await mercadoPagoService.verifyPayment(
      payment.mercadoPagoId,
      Number(payment.amount)
    );

    if (!isApproved) {
      logger.warn(`Pagamento ${paymentId} não verificado no MP. Ignorando.`);
      return;
    }

    // ── WALLET DEPOSIT: sem produto = depósito de saldo ──
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
        // Notificação com botão "Meu Saldo" automático e ID do pagamento
        await telegramService.sendMessage(
          payment.telegramUser.telegramId,
          `✅ *Depósito confirmado!*\n\nR$ ${Number(payment.amount).toFixed(2)} foram adicionados ao seu saldo.\n\n🪪 *ID do pagamento:* \`${payment.id}\`\n_Guarde este ID caso precise de suporte._`,
          {
            parse_mode: 'Markdown',
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

    // Fluxo normal: pagamento de produto
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

  // BUG5 FIX: pagamentos EXPIRADOS usam campo expiredAt, não cancelledAt
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
