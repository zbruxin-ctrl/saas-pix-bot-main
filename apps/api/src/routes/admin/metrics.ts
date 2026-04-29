// routes/admin/metrics.ts
// FEAT #8: Métricas de saúde do dashboard
// GET /api/admin/metrics  — taxa de conversão PIX, uptime do bot, total de vendas
import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';

export const metricsRouter = Router();

const BOT_START_TIME = Date.now();

metricsRouter.get(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (_req: Request, res: Response) => {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since7d  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totalUsers, newUsers24h, newUsers7d,
      totalPayments, approvedPayments, rejectedPayments, pendingPayments,
      totalOrders, deliveredOrders,
      revenueData24h, revenueData7d, revenueData30d,
      avgResponseTime,
    ] = await Promise.all([
      prisma.telegramUser.count(),
      prisma.telegramUser.count({ where: { createdAt: { gte: since24h } } }),
      prisma.telegramUser.count({ where: { createdAt: { gte: since7d  } } }),

      prisma.payment.count(),
      prisma.payment.count({ where: { status: 'APPROVED' } }),
      prisma.payment.count({ where: { status: { in: ['REJECTED', 'CANCELLED'] } } }),
      prisma.payment.count({ where: { status: 'PENDING' } }),

      prisma.order.count(),
      prisma.order.count({ where: { status: 'DELIVERED' } }),

      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'APPROVED', createdAt: { gte: since24h } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'APPROVED', createdAt: { gte: since7d  } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, where: { status: 'APPROVED', createdAt: { gte: since30d } } }),

      // Tempo médio em ms entre criação e aprovação dos pagamentos aprovados nos últimos 30 dias
      // Neon suporta EPOCH natively
      prisma.$queryRaw<[{ avg_ms: number }]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("approvedAt" - "createdAt")) * 1000)::int AS avg_ms
        FROM "Payment"
        WHERE status = 'APPROVED'
          AND "approvedAt" IS NOT NULL
          AND "createdAt" >= ${since30d}
      `.catch(() => [{ avg_ms: 0 }]),
    ]);

    const pixConversionRate = totalPayments > 0
      ? Math.round((approvedPayments / totalPayments) * 10000) / 100
      : 0;

    const uptimeMs  = Date.now() - BOT_START_TIME;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    const uptimeHrs = Math.floor(uptimeMin / 60);

    res.json({
      success: true,
      data: {
        users: { total: totalUsers, new24h: newUsers24h, new7d: newUsers7d },
        payments: {
          total: totalPayments,
          approved: approvedPayments,
          rejected: rejectedPayments,
          pending: pendingPayments,
          pixConversionRate,
        },
        orders: { total: totalOrders, delivered: deliveredOrders },
        revenue: {
          last24h: Number(revenueData24h._sum.amount ?? 0),
          last7d:  Number(revenueData7d._sum.amount  ?? 0),
          last30d: Number(revenueData30d._sum.amount ?? 0),
        },
        bot: {
          uptimeMs,
          uptimeHuman: `${uptimeHrs}h ${uptimeMin % 60}m ${uptimeSec % 60}s`,
          avgPaymentApprovalMs: avgResponseTime[0]?.avg_ms ?? 0,
        },
      },
    });
  }
);
