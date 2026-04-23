// CRUD de produtos no painel admin
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';
import { AuthenticatedRequest } from '../../middleware/auth';

export const adminProductsRouter = Router();

const productSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres').max(100),
  description: z.string().min(5).max(500),
  price: z.number().positive('Preço deve ser positivo').max(99999),
  deliveryType: z.enum(['TEXT', 'LINK', 'TOKEN', 'ACCOUNT']),
  deliveryContent: z.string().min(1, 'Conteúdo de entrega é obrigatório'),
  isActive: z.boolean().default(true),
  stock: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

// GET /api/admin/products
adminProductsRouter.get('/', async (_req: Request, res: Response) => {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { payments: true, orders: true } },
    },
  });

  res.json({
    success: true,
    data: products.map((p) => ({
      ...p,
      price: Number(p.price),
    })),
  });
});

// POST /api/admin/products - Requer ADMIN ou superior
adminProductsRouter.post(
  '/',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.parse(req.body);

    const product = await prisma.product.create({ data });

    res.status(201).json({
      success: true,
      data: { ...product, price: Number(product.price) },
    });
  }
);

// PUT /api/admin/products/:id
adminProductsRouter.put(
  '/:id',
  requireRole('ADMIN', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.partial().parse(req.body);

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data,
    });

    res.json({
      success: true,
      data: { ...product, price: Number(product.price) },
    });
  }
);

// DELETE /api/admin/products/:id - Apenas SUPER_ADMIN
adminProductsRouter.delete(
  '/:id',
  requireRole('SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Soft delete: desativa em vez de apagar
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true, message: 'Produto desativado' });
  }
);
