// routes/admin/payments.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PaymentStatus, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';
import { paymentService } from '../../services/paymentService';
import { mercadoPagoService } from '../../services/mercadoPagoService';

export const adminPaymentsRouter = Router();

const querySchema = z.object({
  page: z.string().default('1').transform(Number),
  perPage: z.string().default('20').transform(Number),
  status: z.string().optional(),
  orderStatus: z.string().optional(),
  productId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
});

// GET /api/admin/payments
adminPaymentsRouter.get(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const query = querySchema.parse(req.query);
    const { page, perPage, status, orderStatus, productId, startDate, endDate, search } = query;

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
// Consulta o MP via mercadoPagoService (token já configurado no env)
// e força processApprovedPayment se o MP confirmar aprovação.
adminPaymentsRouter.post(
  '/:id/reprocess',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const paymentId = req.params.id;

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      res.status(404).json({ success: false, error: 'Pagamento não encontrado' });
      return;
    }

    // Se já aprovado no nosso banco, não reprocessa
    if (payment.status === 'APPROVED') {
      res.json({ success: true, message: 'Pagamento já está aprovado', alreadyApproved: true });
      return;
    }

    if (!payment.mercadoPagoId) {
      res.status(400).json({
        success: false,
        error: 'Este pagamento não tem ID do Mercado Pago registrado',
      });
      return;
    }

    // Consulta o status real no Mercado Pago
    let mpDetail: Awaited<ReturnType<typeof mercadoPagoService.getPaymentById>>;
    try {
      mpDetail = await mercadoPagoService.getPaymentById(payment.mercadoPagoId);
    } catch (err: any) {
      res.status(502).json({
        success: false,
        error: `Erro ao consultar Mercado Pago: ${err?.message || 'erro desconhecido'}`,
      });
      return;
    }

    if (mpDetail.status !== 'approved') {
      res.json({
        success: false,
        mpStatus: mpDetail.status,
        error: `O Mercado Pago retornou status "${mpDetail.status}" — pagamento ainda não aprovado no MP`,
      });
      return;
    }

    // MP confirmou aprovação → dispara o fluxo completo de entrega
    try {
      await paymentService.processApprovedPayment(paymentId);
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: `Erro ao processar pagamento: ${err?.message || 'erro desconhecido'}`,
      });
      return;
    }

    res.json({
      success: true,
      message: 'Pagamento reprocessado com sucesso. O bot enviará o produto ao usuário.',
    });
  }
);
