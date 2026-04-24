import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';

export const adminProductsRouter = Router();

const productSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().min(5).max(500),
  price: z.number().positive().max(99999),
  deliveryType: z.enum(['TEXT', 'LINK', 'TOKEN', 'ACCOUNT']),
  deliveryContent: z.string().min(1),
  isActive: z.boolean().default(true),
  stock: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

// GET
adminProductsRouter.get('/', async (_req, res: Response) => {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    success: true,
    data: products.map((p) => ({
      ...p,
      price: Number(p.price),
    })),
  });
});

// POST
adminProductsRouter.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.parse(req.body);

    const product = await prisma.product.create({
      data: {
        ...data,
        metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });

    res.status(201).json({
      success: true,
      data: { ...product, price: Number(product.price) },
    });
  }
);

// PUT
adminProductsRouter.put(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.partial().parse(req.body);

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...data,
        metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });

    res.json({
      success: true,
      data: { ...product, price: Number(product.price) },
    });
  }
);

// DELETE (soft delete)
adminProductsRouter.delete(
  '/:id',
  requireRole('SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true });
  }
);
