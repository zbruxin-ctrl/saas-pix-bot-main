// routes/admin/payments.ts
// FEAT #4: preset de período (?preset=today|7d|month) no filtro de pagamentos
// FEAT: GET /export/csv — exporta pagamentos aprovados em CSV
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PaymentStatus, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';
import { paymentService } from '../../services/paymentService';
import { mercadoPagoService } from '../../services/mercadoPagoService';

export const adminPaymentsRouter = Router();

/** Converte preset de período em {gte, lte} */
function resolvePreset(preset?: string): { gte?: Date; lte?: Date } {
  if (!preset) return {};
  const now = new Date();
  switch (preset) {
    case 'today': {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      return { gte: start, lte: end };
    }
    case '7d': {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { gte: start };
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { gte: start };
    }
    default:
      return {};
  }
}

const querySchema = z.object({
  page: z.string().default('1').transform(Number),
  perPage: z.string().default('20').transform(Number),
  status: z.string().optional(),
  orderStatus: z.string().optional(),
  productId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  preset: z.enum(['today', '7d', 'month']).optional(), // FEAT #4
  search: z.string().optional(),
});

// GET /api/admin/payments
adminPaymentsRouter.get(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const query = querySchema.parse(req.query);
    const { page, perPage, status, orderStatus, productId, startDate, endDate, preset, search } = query;

    const skip = (page - 1) * perPage;
    const where: Prisma.PaymentWhereInput = {};

    if (status && Object.values(PaymentStatus).includes(status as PaymentStatus)) {
      where.status = status as PaymentStatus;
    }

    if (productId) {
      where.productId = productId;
    }

    if (orderStatus && Object.values(OrderStatus).includes(orderStatus as OrderStatus)) {
      where.order = { status: orderStatus as OrderStatus };
    }

    // FEAT #4: preset tem prioridade sobre startDate/endDate manuais
    const presetRange = resolvePreset(preset);
    const dateRange = Object.keys(presetRange).length > 0
      ? presetRange
      : {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate   ? { lte: new Date(endDate)   } : {}),
        };

    if (Object.keys(dateRange).length > 0) {
      where.createdAt = dateRange;
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
            ? { ...p.product, price: Number(p.product.price) }
            : null,
        })),
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      },
    });
  }
);

// GET /api/admin/payments/export/csv
adminPaymentsRouter.get(
  '/export/csv',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const { status, productId, startDate, endDate, preset } = querySchema.parse(req.query);

    const where: Prisma.PaymentWhereInput = {};
    if (status && Object.values(PaymentStatus).includes(status as PaymentStatus)) {
      where.status = status as PaymentStatus;
    }
    if (productId) where.productId = productId;

    const presetRange = resolvePreset(preset);
    const dateRange = Object.keys(presetRange).length > 0
      ? presetRange
      : {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate   ? { lte: new Date(endDate)   } : {}),
        };
    if (Object.keys(dateRange).length > 0) where.createdAt = dateRange;

    const payments = await prisma.payment.findMany({
      where,
      include: {
        product: { select: { name: true } },
        telegramUser: { select: { firstName: true, username: true, telegramId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });

    const header = 'id,produto,usuario,telegram_id,valor,status,criado_em,aprovado_em';
    const rows = payments.map((p) => [
      p.id,
      p.product?.name ?? 'Depósito',
      p.telegramUser?.firstName ?? '',
      p.telegramUser?.telegramId ?? '',
      Number(p.amount).toFixed(2),
      p.status,
      p.createdAt.toISOString(),
      p.approvedAt?.toISOString() ?? '',
    ].join(','));

    const csv = [header, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pagamentos.csv"');
    res.send('\uFEFF' + csv);
  }
);

// GET /api/admin/payments/:id
adminPaymentsRouter.get(
  '/:id',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const paymentId = req.params.id;

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
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

    let stockItem: { content: string; status: string } | null = null;
    try {
      stockItem = await prisma.stockItem.findUnique({
        where: { paymentId },
        select: { content: true, status: true },
      });
    } catch {
      stockItem = null;
    }

    res.json({
      success: true,
      data: {
        ...payment,
        amount: Number(payment.amount),
        product: payment.product
          ? { ...payment.product, price: Number(payment.product.price) }
          : null,
        stockItem: stockItem ?? null,
      },
    });
  }
);

// POST /api/admin/payments/:id/reprocess
adminPaymentsRouter.post(
  '/:id/reprocess',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const paymentId = req.params.id;

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) {
      res.status(404).json({ success: false, error: 'Pagamento não encontrado' });
      return;
    }

    if (payment.status === 'APPROVED') {
      res.json({ success: true, message: 'Pagamento já está aprovado', alreadyApproved: true });
      return;
    }

    if (!payment.mercadoPagoId) {
      res.status(400).json({ success: false, error: 'Este pagamento não tem ID do Mercado Pago registrado' });
      return;
    }

    let mpDetail: Awaited<ReturnType<typeof mercadoPagoService.getPaymentById>>;
    try {
      mpDetail = await mercadoPagoService.getPaymentById(payment.mercadoPagoId);
    } catch (err: any) {
      res.status(502).json({ success: false, error: `Erro ao consultar Mercado Pago: ${err?.message || 'erro desconhecido'}` });
      return;
    }

    if (mpDetail.status !== 'approved') {
      res.json({ success: false, mpStatus: mpDetail.status, error: `O Mercado Pago retornou status "${mpDetail.status}"` });
      return;
    }

    try {
      await paymentService.processApprovedPayment(paymentId);
    } catch (err: any) {
      res.status(500).json({ success: false, error: `Erro ao processar pagamento: ${err?.message || 'erro desconhecido'}` });
      return;
    }

    res.json({ success: true, message: 'Pagamento reprocessado com sucesso. O bot enviará o produto ao usuário.' });
  }
);
