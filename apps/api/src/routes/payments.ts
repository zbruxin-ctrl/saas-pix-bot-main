// Rotas de pagamento (usadas pelo bot)
// FIX BUG8: GET /products movido para ANTES de GET /:id/status (Express capturava /products como /:id)
// FIX BUG1: adiciona POST /:id/cancel para que o bot possa gravar CANCELLED no banco
// FIX STOCK-DISPLAY: /products agora retorna availableStock calculado corretamente
// WALLET: adiciona POST /deposit e GET /balance
// SORT: /products ordena por sortOrder, depois createdAt
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { StockItemStatus } from '@prisma/client';
import { paymentService } from '../services/paymentService';
import { paymentRateLimit } from '../middleware/rateLimit';
import { requireBotSecret } from '../middleware/auth';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  telegramId: z.string().min(1),
  productId: z.string().min(1),
  firstName: z.string().optional(),
  username: z.string().optional(),
});

const createDepositSchema = z.object({
  telegramId: z.string().min(1),
  amount: z.number().min(1).max(10000),
  firstName: z.string().optional(),
  username: z.string().optional(),
});

// ─── Rotas estáticas PRIMEIRO (antes de qualquer /:param) ─────────────────────

// POST /api/payments/create
paymentsRouter.post(
  '/create',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const data = createPaymentSchema.parse(req.body);
    const result = await paymentService.createPayment(data);
    logger.info(`Pagamento criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// POST /api/payments/deposit
// Cria um PIX de depósito de saldo (sem produto vinculado)
paymentsRouter.post(
  '/deposit',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const data = createDepositSchema.parse(req.body);
    const result = await paymentService.createDepositPayment(data);
    logger.info(`[Deposit] PIX de depósito criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// GET /api/payments/balance?telegramId=xxx
// Retorna saldo e últimas 10 transações do usuário
paymentsRouter.get(
  '/balance',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { telegramId } = req.query as { telegramId?: string };
    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: { id: true, balance: true },
    });

    if (!user) {
      res.json({ success: true, data: { balance: 0, transactions: [] } });
      return;
    }

    const transactions = await prisma.walletTransaction.findMany({
      where: { telegramUserId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        type: true,
        amount: true,
        description: true,
        paymentId: true,
        createdAt: true,
      },
    });

    res.json({
      success: true,
      data: {
        balance: Number(user.balance),
        transactions: transactions.map((t) => ({
          ...t,
          amount: Number(t.amount),
          createdAt: t.createdAt.toISOString(),
        })),
      },
    });
  }
);

// GET /api/payments/products
// IMPORTANTE: deve ficar ANTES de GET /:id/status para o Express não capturar /products como /:id
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
        sortOrder: true,
        metadata: true,
        _count: { select: { stockItems: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const productsWithStock = await Promise.all(
      products.map(async (p) => {
        let availableStock: number | null;

        if (p._count.stockItems > 0) {
          availableStock = await prisma.stockItem.count({
            where: { productId: p.id, status: StockItemStatus.AVAILABLE },
          });
        } else if (p.stock !== null) {
          availableStock = p.stock;
        } else {
          availableStock = null;
        }

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          price: Number(p.price),
          deliveryType: p.deliveryType,
          sortOrder: p.sortOrder,
          metadata: p.metadata,
          availableStock,
        };
      })
    );

    const available = productsWithStock.filter(
      (p) => p.availableStock === null || p.availableStock > 0
    );

    res.json({ success: true, data: available });
  }
);

// ─── Rotas dinâmicas DEPOIS das estáticas ─────────────────────────────────────

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

// GET /api/payments/:id/status
paymentsRouter.get(
  '/:id/status',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const status = await paymentService.getPaymentStatus(id);
    res.json({ success: true, data: status });
  }
);
