// Rotas de usuários Telegram no painel admin
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';

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
      include: {
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
      data: users.map((u) => ({
        ...u,
        totalSpent: u.payments.reduce((sum, p) => sum + Number(p.amount), 0),
        payments: undefined, // remove do retorno
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

  res.json({
    success: true,
    data: {
      ...user,
      payments: user.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    },
  });
});
