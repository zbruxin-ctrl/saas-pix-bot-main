// Rotas de pagamento (usadas pelo bot)
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { paymentService } from '../services/paymentService';
import { paymentRateLimit } from '../middleware/rateLimit';
import { requireBotSecret } from '../middleware/auth';
import { logger } from '../lib/logger';

export const paymentsRouter = Router();

// Schema de validação para criação de pagamento
const createPaymentSchema = z.object({
  telegramId: z.string().min(1),
  productId: z.string().min(1),
  firstName: z.string().optional(),
  username: z.string().optional(),
});

// Cria um pagamento PIX
// POST /api/payments/create
paymentsRouter.post(
  '/create',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const data = createPaymentSchema.parse(req.body);

    const result = await paymentService.createPayment(data);

    logger.info(`Pagamento criado via API: ${result.paymentId}`);

    res.status(201).json({
      success: true,
      data: result,
    });
  }
);

// Verifica status de um pagamento
// GET /api/payments/:id/status
paymentsRouter.get(
  '/:id/status',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const status = await paymentService.getPaymentStatus(id);

    res.json({
      success: true,
      data: status,
    });
  }
);

// Lista produtos disponíveis (usado pelo bot)
// GET /api/payments/products
paymentsRouter.get(
  '/products',
  requireBotSecret,
  async (_req: Request, res: Response) => {
    const { prisma } = await import('../lib/prisma');

    const products = await prisma.product.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        deliveryType: true,
        stock: true,
        metadata: true,
      },
      orderBy: { price: 'asc' },
    });

    res.json({
      success: true,
      data: products.map((p) => ({
        ...p,
        price: Number(p.price),
      })),
    });
  }
);
