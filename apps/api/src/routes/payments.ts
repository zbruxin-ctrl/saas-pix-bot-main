// Rotas de pagamento (usadas pelo bot)
// FIX BUG8: GET /products movido para ANTES de GET /:id/status
// FIX BUG1: POST /:id/cancel
// FIX STOCK-DISPLAY: /products retorna availableStock calculado corretamente
// WALLET: POST /deposit e GET /balance
// SORT: /products ordena por sortOrder, depois createdAt
// OPT #5 v2: 1 groupBy para todos os COUNTs
// OPT #11: /balance resolve com include em 1 query
// FEATURE: GET /orders?telegramId=xxx
// FEAT-MAINT: GET /bot-config expe maintenance_mode + maintenance_message + isBlocked
//   POST /create e POST /deposit retornam 503 quando maintenance_mode=true
//   POST /create e POST /deposit retornam 403 quando usuario esta bloqueado
// FEAT-BLOCKED: /bot-config inclui isBlocked do usuario (por telegramId query param)
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { StockItemStatus } from '@prisma/client';
import { paymentService } from '../services/paymentService';
import { paymentRateLimit } from '../middleware/rateLimit';
import { requireBotSecret } from '../middleware/auth';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getSetting } from './admin/settings';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  telegramId: z.string().min(1),
  productId: z.string().min(1),
  firstName: z.string().optional(),
  username: z.string().optional(),
  paymentMethod: z.string().optional(),
});

const createDepositSchema = z.object({
  telegramId: z.string().min(1),
  amount: z.number().min(1).max(10000),
  firstName: z.string().optional(),
  username: z.string().optional(),
});

// ─── Helpers ───────────────────────────────────────────────────────
async function isMaintenanceActive(): Promise<{ active: boolean; message: string }> {
  const [mode, msg] = await Promise.all([
    getSetting('maintenance_mode'),
    getSetting('maintenance_message'),
  ]);
  return { active: mode === 'true', message: msg };
}

async function isUserBlocked(telegramId: string): Promise<boolean> {
  const user = await prisma.telegramUser.findUnique({
    where: { telegramId },
    select: { isBlocked: true },
  });
  return user?.isBlocked ?? false;
}

// ─── Rotas estáticas PRIMEIRO ─────────────────────────────────────────────────

// GET /api/payments/bot-config?telegramId=xxx
// Retorna maintenance_mode, maintenance_message e isBlocked do usuario
paymentsRouter.get(
  '/bot-config',
  requireBotSecret,
  async (req: Request, res: Response) => {
    try {
      const telegramId = req.query.telegramId as string | undefined;

      const [maintenanceMode, maintenanceMessage, blocked] = await Promise.all([
        getSetting('maintenance_mode'),
        getSetting('maintenance_message'),
        telegramId ? isUserBlocked(telegramId) : Promise.resolve(false),
      ]);

      res.json({
        success: true,
        data: {
          maintenanceMode: maintenanceMode === 'true',
          maintenanceMessage,
          isBlocked: blocked,
        },
      });
    } catch (err) {
      logger.error('[bot-config] Erro:', err);
      res.json({ success: true, data: { maintenanceMode: false, maintenanceMessage: '', isBlocked: false } });
    }
  }
);

// POST /api/payments/create
paymentsRouter.post(
  '/create',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const { active, message } = await isMaintenanceActive();
    if (active) {
      res.status(503).json({ success: false, error: message || 'Estamos em manutenção. Voltamos em breve!' });
      return;
    }
    // Verifica bloqueio antes de criar pagamento
    const data = createPaymentSchema.parse(req.body);
    const blocked = await isUserBlocked(data.telegramId);
    if (blocked) {
      res.status(403).json({ success: false, error: 'Sua conta está suspensa. Entre em contato com o suporte.' });
      return;
    }
    const result = await paymentService.createPayment(data as Parameters<typeof paymentService.createPayment>[0]);
    logger.info(`Pagamento criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// POST /api/payments/deposit
paymentsRouter.post(
  '/deposit',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    const { active, message } = await isMaintenanceActive();
    if (active) {
      res.status(503).json({ success: false, error: message || 'Estamos em manutenção. Voltamos em breve!' });
      return;
    }
    const data = createDepositSchema.parse(req.body);
    const blocked = await isUserBlocked(data.telegramId);
    if (blocked) {
      res.status(403).json({ success: false, error: 'Sua conta está suspensa. Entre em contato com o suporte.' });
      return;
    }
    const result = await paymentService.createDepositPayment(data);
    logger.info(`[Deposit] PIX de depósito criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// GET /api/payments/balance?telegramId=xxx
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
      select: {
        id: true,
        balance: true,
        walletTransactions: {
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
        },
      },
    });

    if (!user) {
      res.json({ success: true, data: { balance: 0, transactions: [] } });
      return;
    }

    res.json({
      success: true,
      data: {
        balance: Number(user.balance),
        transactions: user.walletTransactions.map((t) => ({
          ...t,
          amount: Number(t.amount),
          createdAt: t.createdAt.toISOString(),
        })),
      },
    });
  }
);

// GET /api/payments/products
paymentsRouter.get(
  '/products',
  requireBotSecret,
  async (_req: Request, res: Response) => {
    const [products, stockCounts] = await Promise.all([
      prisma.product.findMany({
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
      }),
      prisma.stockItem.groupBy({
        by: ['productId'],
        where: { status: StockItemStatus.AVAILABLE },
        _count: { id: true },
      }),
    ]);

    const stockMap = new Map<string, number>();
    for (const s of stockCounts) {
      stockMap.set(s.productId, s._count.id);
    }

    const productsWithStock = products.map((p) => {
      let availableStock: number | null;
      if (p._count.stockItems > 0) {
        availableStock = stockMap.get(p.id) ?? 0;
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
    });

    const available = productsWithStock.filter(
      (p) => p.availableStock === null || p.availableStock > 0
    );

    res.json({ success: true, data: available });
  }
);

// GET /api/payments/orders?telegramId=xxx
paymentsRouter.get(
  '/orders',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { telegramId } = req.query as { telegramId?: string };
    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: { id: true },
    });

    if (!user) {
      res.json({ success: true, data: [] });
      return;
    }

    const orders = await prisma.order.findMany({
      where: { telegramUserId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        createdAt: true,
        deliveredAt: true,
        product: { select: { name: true } },
        payment: { select: { amount: true, paymentMethod: true } },
      },
    });

    res.json({
      success: true,
      data: orders.map((o) => ({
        id: o.id,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
        deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
        productName: o.product?.name ?? 'Produto',
        amount: o.payment ? Number(o.payment.amount) : null,
        paymentMethod: o.payment?.paymentMethod ?? null,
      })),
    });
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
