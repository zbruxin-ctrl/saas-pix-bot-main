// Rotas de pagamento (usadas pelo bot)
// FIX BUG1: adiciona POST /:id/cancel para que o bot possa gravar CANCELLED no banco
// FIX STOCK-DISPLAY: /products agora retorna availableStock calculado corretamente
//   para produtos FIFO (conta StockItems AVAILABLE) e numéricos (campo stock).
//   Produtos sem estoque disponível são filtrados da lista.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { StockItemStatus } from '@prisma/client';
import { paymentService } from '../services/paymentService';
import { paymentRateLimit } from '../middleware/rateLimit';
import { requireBotSecret } from '../middleware/auth';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

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

// Cancela um pagamento PENDING a pedido do usuário no bot
// POST /api/payments/:id/cancel
paymentsRouter.post(
  '/:id/cancel',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const result = await paymentService.cancelPayment(id);

    if (!result.cancelled) {
      res.status(400).json({ success: false, message: result.reason });
      return;
    }

    logger.info(`Pagamento ${id} cancelado via bot`);
    res.json({ success: true, message: result.reason });
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
        _count: { select: { stockItems: true } },
      },
      orderBy: { price: 'asc' },
    });

    // Calcula estoque real para cada produto
    const productsWithStock = await Promise.all(
      products.map(async (p) => {
        let availableStock: number | null;

        if (p._count.stockItems > 0) {
          // Modo FIFO: conta StockItems AVAILABLE
          availableStock = await prisma.stockItem.count({
            where: { productId: p.id, status: StockItemStatus.AVAILABLE },
          });
        } else if (p.stock !== null) {
          // Modo numérico
          availableStock = p.stock;
        } else {
          // Produto ilimitado
          availableStock = null;
        }

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          price: Number(p.price),
          deliveryType: p.deliveryType,
          metadata: p.metadata,
          // null = ilimitado, number = quantidade disponível
          availableStock,
        };
      })
    );

    // Filtra produtos esgotados (availableStock === 0)
    // null (ilimitado) e qualquer número > 0 passam normalmente
    const available = productsWithStock.filter(
      (p) => p.availableStock === null || p.availableStock > 0
    );

    res.json({
      success: true,
      data: available,
    });
  }
);
