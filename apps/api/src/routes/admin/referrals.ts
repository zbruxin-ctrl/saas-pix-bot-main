// routes/admin/referrals.ts
// GET /admin/referrals          — listagem com stats
// GET /admin/referrals/summary  — totais (referrers, recompensas pagas, pendentes)
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';

export const adminReferralsRouter = Router();

adminReferralsRouter.use(requireRole('ADMIN', 'SUPERADMIN'));

adminReferralsRouter.get('/summary', async (_req: AuthenticatedRequest, res: Response) => {
  const [total, paid, unpaid] = await Promise.all([
    prisma.referral.count(),
    prisma.referral.count({ where: { rewardPaid: true } }),
    prisma.referral.count({ where: { rewardPaid: false } }),
  ]);

  const [paidSum, unpaidSum] = await Promise.all([
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: true } }),
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: false } }),
  ]);

  res.json({
    success: true,
    data: {
      total,
      paid,
      unpaid,
      totalPaidAmount: Number(paidSum._sum.rewardAmount ?? 0),
      totalUnpaidAmount: Number(unpaidSum._sum.rewardAmount ?? 0),
    },
  });
});

adminReferralsRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const skip = (page - 1) * limit;

  const [referrals, total] = await Promise.all([
    prisma.referral.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        referrer: { select: { telegramId: true, firstName: true, username: true } },
        referred: { select: { telegramId: true, firstName: true, username: true } },
        payment: { select: { id: true, amount: true, status: true, approvedAt: true } },
      },
    }),
    prisma.referral.count(),
  ]);

  res.json({
    success: true,
    data: referrals,
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  });
});
