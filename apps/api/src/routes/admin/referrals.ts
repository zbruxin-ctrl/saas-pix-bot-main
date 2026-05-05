// routes/admin/referrals.ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';

export const adminReferralsRouter = Router();
adminReferralsRouter.use(requireRole('ADMIN', 'SUPERADMIN'));

adminReferralsRouter.get('/summary', async (_req: AuthenticatedRequest, res: Response) => {
  const [total, converted, pendingPayment] = await Promise.all([
    prisma.referral.count(),
    prisma.referral.count({ where: { rewardPaid: true } }),
    prisma.referral.count({ where: { rewardPaid: false, paymentId: { not: null } } }),
  ]);

  const registered = total - converted - pendingPayment;

  const [paidSum, pendingSum] = await Promise.all([
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: true } }),
    prisma.referral.aggregate({ _sum: { rewardAmount: true }, where: { rewardPaid: false, paymentId: { not: null } } }),
  ]);

  res.json({
    success: true,
    data: {
      total,
      registered,
      pendingPayment,
      converted,
      totalPaidAmount:    Number(paidSum._sum.rewardAmount   ?? 0),
      totalPendingAmount: Number(pendingSum._sum.rewardAmount ?? 0),
    },
  });
});

// POST /api/admin/referrals/backfill
// Cria manualmente um vínculo de indicação perdido (para registros anteriores ao fix do upsert).
// Body: { referrerTelegramId: string, referredTelegramId: string }
const backfillSchema = z.object({
  referrerTelegramId: z.string().min(1),
  referredTelegramId: z.string().min(1),
});

adminReferralsRouter.post('/backfill', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = backfillSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0].message });
    return;
  }

  const { referrerTelegramId, referredTelegramId } = parsed.data;

  if (referrerTelegramId === referredTelegramId) {
    res.status(400).json({ success: false, error: 'Auto-indicação não permitida.' });
    return;
  }

  // Garante que o indicador existe (upsert — mesmo comportamento do fix)
  const [referrer, referred] = await Promise.all([
    prisma.telegramUser.upsert({
      where:  { telegramId: referrerTelegramId },
      update: {},
      create: { telegramId: referrerTelegramId },
      select: { id: true },
    }),
    prisma.telegramUser.findUnique({
      where:  { telegramId: referredTelegramId },
      select: { id: true },
    }),
  ]);

  if (!referred) {
    res.status(404).json({ success: false, error: 'Usuário indicado não encontrado no banco.' });
    return;
  }

  // Verifica se já existe um referral para o indicado
  const existing = await prisma.referral.findUnique({ where: { referredId: referred.id } });
  if (existing) {
    res.status(409).json({
      success: false,
      error: 'Este usuário já possui um vínculo de indicação.',
      existing: {
        id:         existing.id,
        rewardPaid: existing.rewardPaid,
        createdAt:  existing.createdAt,
      },
    });
    return;
  }

  const referral = await prisma.referral.create({
    data: { referrerId: referrer.id, referredId: referred.id },
    include: {
      referrer: { select: { telegramId: true, firstName: true } },
      referred: { select: { telegramId: true, firstName: true } },
    },
  });

  res.json({
    success: true,
    message: 'Vínculo de indicação criado com sucesso.',
    data: {
      id:       referral.id,
      referrer: referral.referrer,
      referred: referral.referred,
    },
  });
});

adminReferralsRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const page  = Math.max(1, Number(req.query.page  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const skip  = (page - 1) * limit;
  const search = req.query.search as string | undefined;

  const stateFilter = req.query.state as string | undefined;
  const stateWhere: Record<string, unknown> =
    stateFilter === 'converted'  ? { rewardPaid: true } :
    stateFilter === 'pending'    ? { rewardPaid: false, paymentId: { not: null } } :
    stateFilter === 'registered' ? { rewardPaid: false, paymentId: null } :
    {};

  const searchWhere = search ? {
    OR: [
      { referrer: { firstName: { contains: search, mode: 'insensitive' as const } } },
      { referrer: { username:  { contains: search, mode: 'insensitive' as const } } },
      { referrer: { telegramId: search } },
      { referred: { firstName: { contains: search, mode: 'insensitive' as const } } },
      { referred: { username:  { contains: search, mode: 'insensitive' as const } } },
      { referred: { telegramId: search } },
    ],
  } : {};

  const where = { ...stateWhere, ...searchWhere };

  const [referrals, total, agg, totalConverted] = await Promise.all([
    prisma.referral.findMany({
      skip, take: limit, where,
      orderBy: { createdAt: 'desc' },
      include: {
        referrer: { select: { telegramId: true, firstName: true, username: true } },
        referred: { select: { telegramId: true, firstName: true, username: true } },
        payment:  { select: { id: true, amount: true, status: true, approvedAt: true } },
      },
    }),
    prisma.referral.count({ where }),
    prisma.referral.aggregate({ _count: { _all: true }, _sum: { rewardAmount: true } }),
    prisma.referral.count({ where: { rewardPaid: true } }),
  ]);

  const data = referrals.map((r) => ({
    id:         r.id,
    referrer:   r.referrer,
    referred:   r.referred,
    createdAt:  r.createdAt,
    state:      r.rewardPaid ? 'converted' : r.paymentId ? 'pending' : 'registered',
    rewardPaid: Number(r.rewardAmount ?? 0),
    payment:    r.payment ?? null,
  }));

  res.json({
    success: true,
    data,
    total,
    totalPages: Math.ceil(total / limit),
    page,
    summary: {
      totalReferrals:   agg._count._all,
      totalConverted,
      totalRewardsPaid: Number(agg._sum.rewardAmount ?? 0),
    },
  });
});
