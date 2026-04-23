// Serviço de pagamentos - lógica de negócio principal
import { PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mercadoPagoService } from './mercadoPagoService';
import { deliveryService } from './deliveryService';
import { telegramService } from './telegramService';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import type { CreatePaymentRequest, CreatePaymentResponse } from '@saas-pix/shared';

export class PaymentService {

  // Cria ou busca usuário Telegram, depois cria pagamento PIX
  async createPayment(data: CreatePaymentRequest): Promise<CreatePaymentResponse> {
    const { telegramId, productId, firstName, username } = data;

    // Busca o produto
    const product = await prisma.product.findUnique({
      where: { id: productId, isActive: true },
    });

    if (!product) {
      throw new AppError('Produto não encontrado ou indisponível.', 404);
    }

    // Verifica estoque
    if (product.stock !== null && product.stock <= 0) {
      throw new AppError('Produto esgotado no momento. Tente novamente mais tarde.', 409);
    }

    // Cria ou atualiza usuário Telegram
    const telegramUser = await prisma.telegramUser.upsert({
      where: { telegramId },
      update: { firstName, username },
      create: { telegramId, firstName, username },
    });

    // Verifica se já existe pagamento pendente para este usuário/produto
    const existingPending = await prisma.payment.findFirst({
      where: {
        telegramUserId: telegramUser.id,
        productId,
        status: PaymentStatus.PENDING,
        pixExpiresAt: { gt: new Date() }, // ainda não expirou
      },
    });

    if (existingPending) {
      // Retorna o pagamento pendente existente
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

    // Cria pagamento no banco primeiro (para ter o ID como referência)
    const payment = await prisma.payment.create({
      data: {
        telegramUserId: telegramUser.id,
        productId: product.id,
        amount: product.price,
        status: PaymentStatus.PENDING,
        metadata: {
          firstName,
          username,
          productName: product.name,
        },
      },
    });

    try {
      // Cria PIX no Mercado Pago
      const mpPayment = await mercadoPagoService.createPixPayment({
        transactionAmount: Number(product.price),
        description: `${product.name} - SaaS PIX Bot`,
        payerEmail: `${telegramId}@telegram.user`,
        payerName: firstName || username || 'Usuário Telegram',
        externalReference: payment.id, // ID interno como referência
        notificationUrl: `${env.API_URL}/api/webhooks/mercadopago`,
      });

      // Atualiza pagamento com dados do MP
      const updatedPayment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          mercadoPagoId: String(mpPayment.id),
          pixQrCode: mpPayment.point_of_interaction.transaction_data.qr_code_base64,
          pixQrCodeText: mpPayment.point_of_interaction.transaction_data.qr_code,
          pixExpiresAt: new Date(mpPayment.date_of_expiration),
          status: PaymentStatus.PENDING,
        },
      });

      logger.info(`Pagamento criado: ${payment.id} | MP ID: ${mpPayment.id}`);

      return {
        paymentId: updatedPayment.id,
        pixQrCode: updatedPayment.pixQrCode!,
        pixQrCodeText: updatedPayment.pixQrCodeText!,
        amount: Number(updatedPayment.amount),
        expiresAt: updatedPayment.pixExpiresAt!.toISOString(),
        productName: product.name,
      };
    } catch (error) {
      // Remove pagamento se falhou no MP
      await prisma.payment.delete({ where: { id: payment.id } });
      throw error;
    }
  }

  // Processa confirmação de pagamento aprovado (chamado pelo webhook)
  async processApprovedPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        product: true,
        telegramUser: true,
        order: true,
      },
    });

    if (!payment) {
      throw new AppError('Pagamento não encontrado', 404);
    }

    // Idempotência: não processa se já foi aprovado
    if (payment.status === PaymentStatus.APPROVED) {
      logger.info(`Pagamento ${paymentId} já processado. Ignorando.`);
      return;
    }

    if (payment.status !== PaymentStatus.PENDING) {
      logger.warn(`Pagamento ${paymentId} está com status ${payment.status}. Ignorando.`);
      return;
    }

    // Verifica no Mercado Pago se o pagamento realmente foi aprovado
    const { isApproved } = await mercadoPagoService.verifyPayment(
      payment.mercadoPagoId!,
      Number(payment.amount)
    );

    if (!isApproved) {
      logger.warn(`Pagamento ${paymentId} não verificado no MP. Ignorando.`);
      return;
    }

    // Atualiza status do pagamento e cria pedido em transação
    const order = await prisma.$transaction(async (tx) => {
      // Atualiza pagamento
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.APPROVED,
          approvedAt: new Date(),
        },
      });

      // Decrementa estoque se necessário
      if (payment.product.stock !== null) {
        await tx.product.update({
          where: { id: payment.productId },
          data: { stock: { decrement: 1 } },
        });
      }

      // Cria pedido
      const newOrder = await tx.order.create({
        data: {
          paymentId: payment.id,
          telegramUserId: payment.telegramUserId,
          productId: payment.productId,
          status: 'PROCESSING',
        },
      });

      return newOrder;
    });

    // Entrega o produto via Telegram (fora da transação)
    await deliveryService.deliver(order.id, payment.telegramUser, payment.product);

    // Notifica o usuário sobre o pagamento aprovado
    await telegramService.sendPaymentConfirmation(
      payment.telegramUser.telegramId,
      payment.product.name,
      Number(payment.amount)
    );
  }

  // Busca status de um pagamento pelo ID interno
  async getPaymentStatus(paymentId: string): Promise<{ status: PaymentStatus; paymentId: string }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true },
    });

    if (!payment) {
      throw new AppError('Pagamento não encontrado', 404);
    }

    return { status: payment.status, paymentId: payment.id };
  }
}

export const paymentService = new PaymentService();
