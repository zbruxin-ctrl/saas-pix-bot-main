// Dashboard admin — queries sequenciais para não esgotar o connection pool
// (planos gratuitos têm connection_limit=1; Promise.all com 15 queries paralelas causa timeout)
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthenticatedRequest } from '../../middleware/auth';

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // --- queries sequenciais para respeitar connection_limit=1 ---
  const totalApproved       = await prisma.payment.count({ where: { status: 'APPROVED' } });
  const totalPending        = await prisma.payment.count({ where: { status: 'PENDING' } });
  const totalRejected       = await prisma.payment.count({ where: { status: { in: ['REJECTED'] } } });
  const totalExpired        = await prisma.payment.count({ where: { status: 'EXPIRED' } });
  const totalCancelled      = await prisma.payment.count({ where: { status: 'CANCELLED' } });
  const totalRefunded       = await prisma.payment.count({ where: { status: 'REFUNDED' } });

  const revenueResult       = await prisma.payment.aggregate({
    where: { status: 'APPROVED' },
    _sum: { amount: true },
  });

  const todayPayments       = await prisma.payment.count({
    where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
  });
  const todayRevenue        = await prisma.payment.aggregate({
    where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
    _sum: { amount: true },
  });

  const monthPayments       = await prisma.payment.count({
    where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
  });
  const monthRevenue        = await prisma.payment.aggregate({
    where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
    _sum: { amount: true },
  });

  const deliveriesFailedToday = await prisma.deliveryLog.count({
    where: { status: 'FAILED', createdAt: { gte: startOfToday } },
  });
  const webhooksFailedToday   = await prisma.webhookEvent.count({
    where: { status: 'FAILED', createdAt: { gte: startOfToday } },
  });
  const ordersWithFailure     = await prisma.order.count({ where: { status: 'FAILED' } });

  const recentPayments        = await prisma.payment.findMany({
    where: { status: 'APPROVED' },
    include: {
      product:      { select: { name: true } },
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
        totalApproved,
        totalPending,
        totalRejected,
        totalExpired,
        totalCancelled,
        totalRefunded,
        revenueToday:         Number(todayRevenue._sum.amount || 0),
        paymentsToday:        todayPayments,
        revenueThisMonth:     Number(monthRevenue._sum.amount || 0),
        paymentsThisMonth:    monthPayments,
        deliveriesFailedToday,
        webhooksFailedToday,
        ordersWithFailure,
      },
      recentPayments: recentPayments.map((p) => ({
        id:          p.id,
        amount:      Number(p.amount),
        status:      p.status,
        approvedAt:  p.approvedAt,
        productName: p.product.name,
        userName:    p.telegramUser.firstName || p.telegramUser.username || 'Sem nome',
      })),
    },
  });
});
