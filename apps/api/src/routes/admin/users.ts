// ALTERAÇÕES: removido hack `payments: undefined`, uso de select+destructuring,
// adicionado isBlocked no retorno da listagem
// NOVO: PATCH /:id/block-toggle — bloquear/desbloquear usuário (SUPERADMIN)
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';

export const adminUsersRouter = Router();

const querySchema = z.object({
  page: z.string().default('1').transform(Number),
  perPage: z.string().default('20').transform(Number),
  search: z.string().optional(),
});

// GET /api/admin/users
adminUsersRouter.get('/', async (req: Request, res: Response) => {
  const { page, perPage, search } = querySchema.parse(req.query);
  const skip = (page - 1) * perPage;

  const where = search
    ? {
        OR: [
          { username: { contains: search, mode: 'insensitive' as const } },
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { telegramId: { contains: search } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.telegramUser.findMany({
      where,
      select: {
        id: true,
        telegramId: true,
        username: true,
        firstName: true,
        lastName: true,
        languageCode: true,
        isBlocked: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { payments: true, orders: true } },
        payments: {
          where: { status: 'APPROVED' },
          select: { amount: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: perPage,
    }),
    prisma.telegramUser.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      data: users.map(({ payments, ...u }) => ({
        ...u,
        totalSpent: payments.reduce((sum, p) => sum + Number(p.amount), 0),
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    },
  });
});

// GET /api/admin/users/:id
adminUsersRouter.get('/:id', async (req: Request, res: Response) => {
  const user = await prisma.telegramUser.findUnique({
    where: { id: req.params.id },
    include: {
      payments: {
        include: { product: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      },
      orders: {
        include: { product: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!user) {
    res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    return;
  }

  const totalSpent = user.payments
    .filter((p) => p.status === 'APPROVED')
    .reduce((sum, p) => sum + Number(p.amount), 0);

  res.json({
    success: true,
    data: {
      ...user,
      totalSpent,
      payments: user.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    },
  });
});

// PATCH /api/admin/users/:id/block-toggle — SUPERADMIN only
adminUsersRouter.patch(
  '/:id/block-toggle',
  requireRole('SUPERADMIN'),
  async (req: Request, res: Response) => {
    const user = await prisma.telegramUser.findUnique({
      where: { id: req.params.id },
      select: { id: true, isBlocked: true, firstName: true },
    });

    if (!user) {
      res.status(404).json({ success: false, error: 'Usuário não encontrado' });
      return;
    }

    const updated = await prisma.telegramUser.update({
      where: { id: req.params.id },
      data: { isBlocked: !user.isBlocked },
      select: { id: true, isBlocked: true },
    });

    res.json({
      success: true,
      data: {
        id: updated.id,
        isBlocked: updated.isBlocked,
        message: updated.isBlocked
          ? `Usuário ${user.firstName ?? req.params.id} bloqueado.`
          : `Usuário ${user.firstName ?? req.params.id} desbloqueado.`,
      },
    });
  }
);

// GET /api/admin/users/export/csv — SUPERADMIN only
adminUsersRouter.get(
  '/export/csv',
  requireRole('SUPERADMIN'),
  async (_req: Request, res: Response) => {
    const users = await prisma.telegramUser.findMany({
      select: {
        telegramId: true,
        firstName: true,
        username: true,
        isBlocked: true,
        createdAt: true,
        payments: { where: { status: 'APPROVED' }, select: { amount: true } },
        _count: { select: { orders: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const header = 'telegram_id,nome,username,total_gasto,pedidos,bloqueado,cadastrado_em';
    const rows = users.map((u) => {
      const totalSpent = u.payments.reduce((s, p) => s + Number(p.amount), 0);
      return [
        u.telegramId,
        u.firstName ?? '',
        u.username ? `@${u.username}` : '',
        totalSpent.toFixed(2),
        u._count.orders,
        u.isBlocked ? 'sim' : 'não',
        u.createdAt.toISOString(),
      ].join(',');
    });

    const csv = [header, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="usuarios.csv"');
    res.send('\uFEFF' + csv); // BOM para Excel abrir corretamente
  }
);
