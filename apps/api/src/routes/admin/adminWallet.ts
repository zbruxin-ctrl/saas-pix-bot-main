// adminWallet.ts
// GET /:telegramUserId/balance — consulta saldo e histórico (ADMIN+)
// POST /:telegramUserId/adjust — ajuste manual de saldo (SUPERADMIN only)
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/auth';
import { walletService } from '../../services/walletService';
import { prisma } from '../../lib/prisma';

export const adminWalletRouter = Router();

// GET /api/admin/wallet/:telegramUserId/balance
adminWalletRouter.get(
  '/:telegramUserId/balance',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const { telegramUserId } = req.params;

    const user = await prisma.telegramUser.findUnique({
      where: { id: telegramUserId },
      select: { id: true, balance: true, telegramId: true, firstName: true, username: true },
    });

    if (!user) {
      res.status(404).json({ success: false, error: 'Usuário não encontrado' });
      return;
    }

    const transactions = await walletService.getTransactions(telegramUserId, 20);

    res.json({
      success: true,
      data: {
        telegramId: user.telegramId,
        firstName: user.firstName,
        username: user.username,
        balance: Number(user.balance),
        transactions: transactions.map((t) => ({
          id: t.id,
          type: t.type,
          amount: Number(t.amount),
          description: t.description,
          paymentId: t.paymentId,
          createdAt: t.createdAt.toISOString(),
        })),
      },
    });
  }
);

// POST /api/admin/wallet/:telegramUserId/adjust
adminWalletRouter.post(
  '/:telegramUserId/adjust',
  requireRole('SUPERADMIN'),
  async (req: Request, res: Response) => {
    const { telegramUserId } = req.params;

    const schema = z.object({
      amount: z.number().refine((v) => v !== 0, { message: 'Valor não pode ser zero' }),
      justification: z.string().min(5, 'Justificativa deve ter ao menos 5 caracteres'),
    });

    const { amount, justification } = schema.parse(req.body);

    const newBalance = await walletService.adminAdjust(telegramUserId, amount, justification);

    res.json({
      success: true,
      data: { newBalance, message: `Saldo ajustado com sucesso. Novo saldo: R$ ${newBalance.toFixed(2)}` },
    });
  }
);
