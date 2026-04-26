import { prisma } from '../lib/prisma';
import { AppError } from '../middleware/errorHandler';
import type { WalletTransactionType } from '@saas-pix/shared';

export class WalletService {
  /** Retorna saldo pelo telegramId (string do Telegram, não UUID interno) */
  async getBalanceByTelegramId(telegramId: string): Promise<number> {
    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: { balance: true },
    });
    if (!user) return 0;
    return Number(user.balance);
  }

  /** Histórico de transações pelo UUID interno do TelegramUser */
  async getTransactions(telegramUserId: string, limit = 20) {
    return prisma.walletTransaction.findMany({
      where: { telegramUserId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Credita saldo — sempre usa prisma.$transaction para atomicidade */
  async deposit(
    telegramUserId: string,
    amount: number,
    description: string,
    paymentId?: string,
  ) {
    if (amount <= 0) throw new AppError('Valor de depósito inválido', 400);
    return prisma.$transaction(async (tx) => {
      const updated = await tx.telegramUser.update({
        where: { id: telegramUserId },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });
      await tx.walletTransaction.create({
        data: {
          telegramUserId,
          type: 'DEPOSIT' as WalletTransactionType,
          amount,
          description,
          paymentId: paymentId ?? null,
        },
      });
      return Number(updated.balance);
    });
  }

  /** Debita saldo — lança AppError 400 se insuficiente */
  async deduct(
    telegramUserId: string,
    amount: number,
    description: string,
    paymentId?: string,
  ) {
    if (amount <= 0) throw new AppError('Valor de débito inválido', 400);
    return prisma.$transaction(async (tx) => {
      const user = await tx.telegramUser.findUnique({
        where: { id: telegramUserId },
        select: { balance: true },
      });
      if (!user) throw new AppError('Usuário não encontrado', 404);
      if (Number(user.balance) < amount) {
        throw new AppError(
          `Saldo insuficiente. Disponível: R$ ${Number(user.balance).toFixed(2)}`,
          400,
        );
      }
      const updated = await tx.telegramUser.update({
        where: { id: telegramUserId },
        data: { balance: { decrement: amount } },
        select: { balance: true },
      });
      await tx.walletTransaction.create({
        data: {
          telegramUserId,
          type: 'PURCHASE' as WalletTransactionType,
          amount,
          description,
          paymentId: paymentId ?? null,
        },
      });
      return Number(updated.balance);
    });
  }

  /** Ajuste manual pelo admin (amount positivo = crédito, negativo = débito) */
  async adminAdjust(
    telegramUserId: string,
    amount: number,
    justification: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.telegramUser.findUnique({
        where: { id: telegramUserId },
        select: { balance: true },
      });
      if (!user) throw new AppError('Usuário não encontrado', 404);

      const isCredit = amount > 0;
      const absAmount = Math.abs(amount);

      if (!isCredit && Number(user.balance) < absAmount) {
        throw new AppError(
          `Saldo insuficiente para ajuste. Disponível: R$ ${Number(user.balance).toFixed(2)}`,
          400,
        );
      }

      const updated = await tx.telegramUser.update({
        where: { id: telegramUserId },
        data: {
          balance: isCredit
            ? { increment: absAmount }
            : { decrement: absAmount },
        },
        select: { balance: true },
      });

      await tx.walletTransaction.create({
        data: {
          telegramUserId,
          type: isCredit ? ('DEPOSIT' as WalletTransactionType) : ('REFUND' as WalletTransactionType),
          amount: absAmount,
          description: `Ajuste admin: ${justification}`,
          paymentId: null,
        },
      });

      return Number(updated.balance);
    });
  }
}

export const walletService = new WalletService();
