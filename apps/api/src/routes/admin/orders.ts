// routes/admin/orders.ts
// FIX M6: GET /api/admin/orders com filtro por status, período e produto
// Complementa o detalhe de pagamento — permite ver todos os pedidos numa listagem dedicada
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export const adminOrdersRouter = Router();

const querySchema = z.object({
  page: z.string().default('1').transform(Number),
  perPage: z.string().default('20').transform(Number),
  status: z.string().optional(),
  productId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
});

// GET /api/admin/orders
adminOrdersRouter.get('/', async (req: Request, res: Response) => {
  const query = querySchema.parse(req.query);
  const { page, perPage, status, productId, startDate, endDate, search } = query;

  const skip = (page - 1) * perPage;
  const where: Prisma.OrderWhereInput = {};

  if (status && Object.values(OrderStatus).includes(status as OrderStatus)) {
    where.status = status as OrderStatus;
  }

  if (productId) {
    where.productId = productId;
  }

  if (startDate || endDate) {
    where.createdAt = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
  }

  if (search) {
    where.OR = [
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

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        product: { select: { name: true, price: true } },
        telegramUser: { select: { username: true, firstName: true, telegramId: true } },
        payment: { select: { amount: true, mercadoPagoId: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: perPage,
    }),
    prisma.order.count({ where }),
  ]);

  res.json({
    success: true,
    data: {
      data: orders.map((o) => ({
        ...o,
        payment: o.payment
          ? { ...o.payment, amount: Number(o.payment.amount) }
          : null,
        product: o.product
          ? { ...o.product, price: Number(o.product.price) }
          : null,
      })),
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    },
  });
});

// GET /api/admin/orders/:id
adminOrdersRouter.get('/:id', async (req: Request, res: Response) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      product: true,
      telegramUser: true,
      payment: true,
      deliveryLogs: { orderBy: { createdAt: 'asc' } },
      deliveryMedias: { orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!order) {
    res.status(404).json({ success: false, error: 'Pedido não encontrado' });
    return;
  }

  res.json({
    success: true,
    data: {
      ...order,
      payment: order.payment
        ? { ...order.payment, amount: Number(order.payment.amount) }
        : null,
      product: order.product
        ? { ...order.product, price: Number(order.product.price) }
        : null,
    },
  });
});
