// routes/admin/dashboard.ts
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthenticatedRequest } from '../../middleware/auth';

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOf7DaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const statusCounts = await prisma.payment.groupBy({
      by: ['status'],
      _count: { status: true },
    }).catch(() => []);

    const countByStatus = (status: string) =>
      (statusCounts as Array<{ status: string; _count: { status: number } }>)
        .find((s) => s.status === status)?._count?.status ?? 0;

    const revenueResult = await prisma.payment.aggregate({
      where: { status: 'APPROVED' },
      _sum: { amount: true },
    }).catch(() => ({ _sum: { amount: 0 } }));

    const todayPayments = await prisma.payment
      .count({ where: { status: 'APPROVED', approvedAt: { gte: startOfToday } } })
      .catch(() => 0);

    const todayRevenue = await prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
      _sum: { amount: true },
    }).catch(() => ({ _sum: { amount: 0 } }));

    const monthPayments = await prisma.payment
      .count({ where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } } })
      .catch(() => 0);

    const monthRevenue = await prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }).catch(() => ({ _sum: { amount: 0 } }));

    const deliveriesFailedToday = await prisma.deliveryLog
      .count({ where: { status: 'FAILED', createdAt: { gte: startOfToday } } })
      .catch(() => 0);

    const webhooksFailedToday = await prisma.webhookEvent
      .count({ where: { status: 'FAILED', createdAt: { gte: startOfToday } } })
      .catch(() => 0);

    const ordersWithFailure = await prisma.order
      .count({ where: { status: 'FAILED' } })
      .catch(() => 0);

    const recentPaymentsRaw = await prisma.payment.findMany({
      where: { status: 'APPROVED', approvedAt: { gte: startOf7DaysAgo } },
      orderBy: { approvedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        amount: true,
        status: true,
        approvedAt: true,
        productId: true,
      },
    }).catch(() => []);

    // FIX: stock é Int? (nullable) — filtra apenas produtos com stock NOT NULL e <= 3
    const lowStockProducts = await prisma.product.findMany({
      where: {
        isActive: true,
        stock: { not: null, lte: 3 },
      },
      select: { id: true, name: true, stock: true },
    }).catch(() => []);

    res.json({
      success: true,
      data: {
        stats: {
          totalRevenue:         Number(revenueResult._sum.amount || 0),
          totalApproved:        countByStatus('APPROVED'),
          totalPending:         countByStatus('PENDING'),
          totalRejected:        countByStatus('REJECTED'),
          totalExpired:         countByStatus('EXPIRED'),
          totalCancelled:       countByStatus('CANCELLED'),
          totalRefunded:        countByStatus('REFUNDED'),
          revenueToday:         Number(todayRevenue._sum.amount || 0),
          paymentsToday:        todayPayments,
          revenueThisMonth:     Number(monthRevenue._sum.amount || 0),
          paymentsThisMonth:    monthPayments,
          deliveriesFailedToday,
          webhooksFailedToday,
          ordersWithFailure,
        },
        recentPayments: recentPaymentsRaw.map((p: {
          id: string;
          amount: unknown;
          status: string;
          approvedAt: Date | null;
          productId: string | null;
        }) => ({
          id:          p.id,
          amount:      Number(p.amount || 0),
          status:      p.status,
          approvedAt:  p.approvedAt,
          productName: p.productId ? 'Produto' : 'Depósito de Saldo',
          userName:    'Usuário',
        })),
        lowStockProducts,
      },
    });
  } catch (err) {
    console.error('[dashboard] Erro inesperado:', err);
    res.status(500).json({ success: false, error: 'Erro ao carregar dashboard' });
  }
});

// GET /api/admin/dashboard/chart?days=30
adminDashboardRouter.get('/chart', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const days = Math.min(Number(req.query.days ?? 30), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const payments = await prisma.payment.findMany({
      where: { status: 'APPROVED', approvedAt: { gte: since } },
      select: { amount: true, approvedAt: true },
      orderBy: { approvedAt: 'asc' },
    });

    const byDay: Record<string, number> = {};
    for (const p of payments) {
      if (!p.approvedAt) continue;
      const key = p.approvedAt.toISOString().slice(0, 10);
      byDay[key] = (byDay[key] ?? 0) + Number(p.amount);
    }

    const result: { date: string; revenue: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      result.push({ date: key, revenue: byDay[key] ?? 0 });
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[dashboard/chart] Erro:', err);
    res.status(500).json({ success: false, error: 'Erro ao carregar gráfico' });
  }
});
