// ALTERAÇÕES: removido hack `payments: undefined`, uso de select+destructuring,
// adicionado isBlocked no retorno da listagem
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
