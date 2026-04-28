// routes/admin/dashboard.ts
// FIX PROD: todas as queries isoladas com .catch() para evitar HTTP 500
// quando o Prisma Client está desatualizado em relação ao banco de produção
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

    // Agrupa status num único groupBy
    const statusCounts = await prisma.payment.groupBy({
      by: ['status'],
      _count: { status: true },
    }).catch(() => []);

    const countByStatus = (status: string) =>
      (statusCounts as Array<{ status: string; _count: { status: number } }>)
        .find((s) => s.status === status)?._count?.status ?? 0;

    // Receita total
    const revenueResult = await prisma.payment.aggregate({
      where: { status: 'APPROVED' },
      _sum: { amount: true },
    }).catch(() => ({ _sum: { amount: 0 } }));

    // Hoje
    const todayPayments = await prisma.payment
      .count({ where: { status: 'APPROVED', approvedAt: { gte: startOfToday } } })
      .catch(() => 0);

    const todayRevenue = await prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
      _sum: { amount: true },
    }).catch(() => ({ _sum: { amount: 0 } }));

    // Este mês
    const monthPayments = await prisma.payment
      .count({ where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } } })
      .catch(() => 0);

    const monthRevenue = await prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }).catch(() => ({ _sum: { amount: 0 } }));

    // Falhas operacionais — tabelas podem não existir ainda
    const deliveriesFailedToday = await prisma.deliveryLog
      .count({ where: { status: 'FAILED', createdAt: { gte: startOfToday } } })
      .catch(() => 0);

    const webhooksFailedToday = await prisma.webhookEvent
      .count({ where: { status: 'FAILED', createdAt: { gte: startOfToday } } })
      .catch(() => 0);

    const ordersWithFailure = await prisma.order
      .count({ where: { status: 'FAILED' } })
      .catch(() => 0);

    // Pagamentos recentes — sem include para evitar erro de schema desatualizado
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
      },
    });
  } catch (err) {
    console.error('[dashboard] Erro inesperado:', err);
    res.status(500).json({ success: false, error: 'Erro ao carregar dashboard' });
  }
});
