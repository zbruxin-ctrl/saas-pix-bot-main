// routes/admin/payments.ts
// FIX B2: remove Promise.all no GET /:id para respeitar connection_limit=1 do Neon free
// FIX B1: remove cast (prisma.stockItem as any) — usa findUnique tipado com try/catch
// FIX S4: requireRole adicionado em todas as rotas
// REPROCESS: POST /:id/reprocess — consulta o MP e força aprovação se payment_status=approved
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PaymentStatus, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';
import { paymentService } from '../../services/paymentService';
import axios from 'axios';

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
// Consulta o Mercado Pago pelo mercadoPagoId e, se aprovado lá,
// chama processApprovedPayment para forçar aprovação + entrega.
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

    if (!payment.mercadoPagoId) {
      res.status(400).json({
        success: false,
        error: 'Este pagamento não tem ID do Mercado Pago registrado',
      });
      return;
    }

    if (payment.status === 'APPROVED') {
      res.json({ success: true, message: 'Pagamento já está aprovado', alreadyApproved: true });
      return;
    }

    // Consulta o MP para confirmar que foi pago
    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) {
      res.status(500).json({ success: false, error: 'MP_ACCESS_TOKEN não configurado no servidor' });
      return;
    }

    let mpData: any;
    try {
      const mpRes = await axios.get(
        `https://api.mercadopago.com/v1/payments/${payment.mercadoPagoId}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );
      mpData = mpRes.data;
    } catch (err: any) {
      const httpStatus = err?.response?.status;
      const message = err?.response?.data?.message || err.message;
      res.status(502).json({
        success: false,
        error: `Erro ao consultar Mercado Pago (${httpStatus}): ${message}`,
      });
      return;
    }

    if (mpData.status !== 'approved') {
      res.json({
        success: false,
        mpStatus: mpData.status,
        error: `O Mercado Pago retornou status "${mpData.status}" — pagamento ainda não aprovado no MP`,
      });
      return;
    }

    // Pagamento aprovado no MP mas não processado — dispara o fluxo completo
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
