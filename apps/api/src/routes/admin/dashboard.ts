// Rota do dashboard admin - estatísticas gerais
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { AuthenticatedRequest } from '../../middleware/auth';

export const adminDashboardRouter = Router();

// GET /api/admin/dashboard
adminDashboardRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Executa todas as queries em paralelo para performance
  const [
    totalApproved,
    totalPending,
    totalRejected,
    revenueResult,
    todayPayments,
    todayRevenue,
    monthPayments,
    monthRevenue,
    recentPayments,
  ] = await Promise.all([
    // Total aprovados
    prisma.payment.count({ where: { status: 'APPROVED' } }),
    // Total pendentes
    prisma.payment.count({ where: { status: 'PENDING' } }),
    // Total rejeitados/cancelados
    prisma.payment.count({ where: { status: { in: ['REJECTED', 'CANCELLED'] } } }),
    // Receita total
    prisma.payment.aggregate({
      where: { status: 'APPROVED' },
      _sum: { amount: true },
    }),
    // Pagamentos hoje
    prisma.payment.count({
      where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
    }),
    // Receita hoje
    prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfToday } },
      _sum: { amount: true },
    }),
    // Pagamentos este mês
    prisma.payment.count({
      where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
    }),
    // Receita este mês
    prisma.payment.aggregate({
      where: { status: 'APPROVED', approvedAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
    // Últimos 10 pagamentos aprovados
    prisma.payment.findMany({
      where: { status: 'APPROVED' },
      include: {
        product: { select: { name: true } },
        telegramUser: { select: { username: true, firstName: true } },
      },
      orderBy: { approvedAt: 'desc' },
      take: 10,
    }),
  ]);

  res.json({
    success: true,
    data: {
      stats: {
        totalRevenue: Number(revenueResult._sum.amount || 0),
        totalApproved,
        totalPending,
        totalRejected,
        revenueToday: Number(todayRevenue._sum.amount || 0),
        paymentsToday: todayPayments,
        revenueThisMonth: Number(monthRevenue._sum.amount || 0),
        paymentsThisMonth: monthPayments,
      },
      recentPayments: recentPayments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        status: p.status,
        approvedAt: p.approvedAt,
        productName: p.product.name,
        userName: p.telegramUser.firstName || p.telegramUser.username || 'Sem nome',
      })),
    },
  });
});
