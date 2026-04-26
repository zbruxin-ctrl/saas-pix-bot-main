// Rotas admin para gerenciamento de pagamentos
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const adminPaymentsRouter = Router();

const querySchema = z.object({
  page: z.string().default('1').transform(Number),
  perPage: z.string().default('20').transform(Number),
  status: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
});

// GET /api/admin/payments
adminPaymentsRouter.get('/', async (req: Request, res: Response) => {
  const query = querySchema.parse(req.query);
  const { page, perPage, status, startDate, endDate, search } = query;

  const skip = (page - 1) * perPage;
  const where: Prisma.PaymentWhereInput = {};

  if (status && Object.values(PaymentStatus).includes(status as PaymentStatus)) {
    where.status = status as PaymentStatus;
  }

  if (startDate || endDate) {
    where.createdAt = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
  }

  if (search) {
    where.OR = [
      { mercadoPagoId: { contains: search, mode: 'insensitive' } },
      { id: { contains: search, mode: 'insensitive' } },
      {
        telegramUser: {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { firstName: { contains: search, mode: 'insensitive' } },
            { telegramId: { contains: search } },
          ],
        },
      },
    ];
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        product: { select: { name: true, price: true } },
        telegramUser: { select: { username: true, firstName: true, telegramId: true } },
        order: { select: { status: true, deliveredAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: perPage,
    }),
    prisma.payment.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      data: payments.map((p) => ({
        ...p,
        amount: Number(p.amount),
        product: p.product
          ? {
              ...p.product,
              price: Number(p.product.price),
            }
          : null,
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    },
  });
});

// GET /api/admin/payments/:id
adminPaymentsRouter.get('/:id', async (req: Request, res: Response) => {
  const payment = await prisma.payment.findUnique({
    where: { id: req.params.id },
    include: {
      product: true,
      telegramUser: true,
      order: {
        include: {
          deliveryLogs: { orderBy: { createdAt: 'asc' } },
          deliveryMedias: { orderBy: { sortOrder: 'asc' } },
        },
      },
      webhookEvents: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!payment) {
    res.status(404).json({ success: false, error: 'Pagamento não encontrado' });
    return;
  }

  res.json({
    success: true,
    data: {
      ...payment,
      amount: Number(payment.amount),
      product: payment.product
        ? {
            ...payment.product,
            price: Number(payment.product.price),
          }
        : null,
    },
  });
});
