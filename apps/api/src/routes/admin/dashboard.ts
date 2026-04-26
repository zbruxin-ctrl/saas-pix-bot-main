// routes/admin/dashboard.ts
// FIX TS18047: p.product pode ser null (pagamentos de depósito de saldo não têm produto vinculado)
// FIX L3: recentPayments mostra os últimos 10 dos últimos 7 dias (não de todos os tempos)
// FIX M4: counts de status agrupados num único groupBy ao invés de 6 queries separadas
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthenticatedRequest } from '../../middleware/auth';

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOf7DaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // M4: um único groupBy substitui 6 queries de count separadas por status
  const statusCounts = await prisma.payment.groupBy({
    by: ['status'],
    _count: { status: true },
  });

  const countByStatus = (status: string) =>
    statusCounts.find((s) => s.status === status)?._count?.status ?? 0;

  // Receita total (somente APPROVED)
  const revenueResult = await prisma.payment.aggregate({
    where: { status: 'APPROVED' },
    _sum: { amount: true },
  });

  // Hoje
  const todayPayments = await prisma.payment.count({
    where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
  });
  const todayRevenue = await prisma.payment.aggregate({
    where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
    _sum: { amount: true },
  });

  // Este mês
  const monthPayments = await prisma.payment.count({
    where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
  });
  const monthRevenue = await prisma.payment.aggregate({
    where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
    _sum: { amount: true },
  });

  // Falhas operacionais
  const deliveriesFailedToday = await prisma.deliveryLog.count({
    where: { status: 'FAILED', createdAt: { gte: startOfToday } },
  });
  const webhooksFailedToday = await prisma.webhookEvent.count({
    where: { status: 'FAILED', createdAt: { gte: startOfToday } },
  });
  const ordersWithFailure = await prisma.order.count({ where: { status: 'FAILED' } });

  // FIX L3: últimos 10 pagamentos aprovados nos últimos 7 dias
  const recentPayments = await prisma.payment.findMany({
    where: { status: 'APPROVED', approvedAt: { gte: startOf7DaysAgo } },
    include: {
      product: { select: { name: true } },
      telegramUser: { select: { username: true, firstName: true } },
    },
    orderBy: { approvedAt: 'desc' },
    take: 10,
  });

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
      // FIX TS18047: p.product é null para depósitos de saldo (productId: null)
      // Usa optional chaining + fallback 'Depósito de Saldo'
      recentPayments: recentPayments.map((p) => ({
        id:          p.id,
        amount:      Number(p.amount),
        status:      p.status,
        approvedAt:  p.approvedAt,
        productName: p.product?.name ?? 'Depósito de Saldo',
        userName:    p.telegramUser.firstName || p.telegramUser.username || 'Sem nome',
      })),
    },
  });
});
