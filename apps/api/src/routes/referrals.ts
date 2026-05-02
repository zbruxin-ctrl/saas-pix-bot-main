// referrals.ts — rotas do programa de indicação
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireBotSecret } from '../middleware/auth';
import { registerReferral } from '../services/referralService';
import { prisma } from '../lib/prisma';

export const referralsRouter = Router();

const registerSchema = z.object({
  referrerTelegramId: z.string().min(1),
  referredTelegramId: z.string().min(1),
});

// POST /api/referrals/register
// Registra que um usuário chegou via link de indicação de outro.
referralsRouter.post(
  '/register',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0].message });
      return;
    }

    const { referrerTelegramId, referredTelegramId } = parsed.data;
    const result = await registerReferral(referrerTelegramId, referredTelegramId);

    if (!result.registered) {
      // Não é um erro crítico — retorna 200 mas informa o motivo
      res.json({ success: false, reason: result.reason });
      return;
    }

    res.json({ success: true });
  }
);

// GET /api/referrals/stats?telegramId=xxx
// Retorna quantos usuários o telegramId indicou e quanto já ganhou.
referralsRouter.get(
  '/stats',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { telegramId } = req.query as { telegramId?: string };

    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: { id: true },
    });

    if (!user) {
      res.json({ success: true, data: { totalReferred: 0, totalEarned: 0, referrals: [] } });
      return;
    }

    const referrals = await prisma.referral.findMany({
      where: { referrerId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rewardPaid: true,
        rewardAmount: true,
        createdAt: true,
        referred: { select: { firstName: true, username: true } },
      },
    });

    const totalEarned = referrals
      .filter((r) => r.rewardPaid)
      .reduce((sum, r) => sum + Number(r.rewardAmount), 0);

    res.json({
      success: true,
      data: {
        totalReferred: referrals.length,
        totalEarned: parseFloat(totalEarned.toFixed(2)),
        referrals: referrals.map((r) => ({
          id: r.id,
          name: r.referred.firstName ?? r.referred.username ?? 'Usuário',
          rewardPaid: r.rewardPaid,
          rewardAmount: Number(r.rewardAmount),
          createdAt: r.createdAt.toISOString(),
        })),
      },
    });
  }
);
