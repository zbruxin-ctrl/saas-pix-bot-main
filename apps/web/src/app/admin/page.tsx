'use client';

import { useEffect, useState } from 'react';
import { getDashboard, getDashboardChart, type LowStockProduct } from '@/lib/api';
import type { DashboardStats, RecentPaymentItem } from '@saas-pix/shared';
import StatsCard from '@/components/admin/StatsCard';
import RecentPaymentsTable from '@/components/admin/RecentPaymentsTable';
import RevenueChart from '@/components/admin/RevenueChart';

interface DashboardData {
  stats: DashboardStats;
  recentPayments: RecentPaymentItem[];
  lowStockProducts: LowStockProduct[];
}

const EMPTY_STATS: DashboardStats = {
  totalRevenue: 0,
  revenueToday: 0,
  revenueThisMonth: 0,
  totalApproved: 0,
  totalPending: 0,
  totalRejected: 0,
  totalExpired: 0,
  totalCancelled: 0,
  totalRefunded: 0,
  paymentsToday: 0,
  paymentsThisMonth: 0,
  deliveriesFailedToday: 0,
  webhooksFailedToday: 0,
  ordersWithFailure: 0,
};

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [chartData, setChartData] = useState<{ date: string; revenue: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.allSettled([
      getDashboard(),
      getDashboardChart(30),
    ]).then(([dashResult, chartResult]) => {
      if (dashResult.status === 'fulfilled') {
        const dash = dashResult.value;
        setData({
          stats: { ...EMPTY_STATS, ...(dash?.stats ?? {}) },
          recentPayments: dash?.recentPayments ?? [],
          lowStockProducts: dash?.lowStockProducts ?? [],
        });
      } else {
        console.error('[dashboard] erro ao carregar stats:', dashResult.reason);
        setError('Erro ao carregar dashboard. Tente novamente.');
      }

      if (chartResult.status === 'fulfilled') {
        setChartData(Array.isArray(chartResult.value) ? chartResult.value : []);
      }
    }).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
        {error || 'Erro ao carregar dashboard.'}
        <button
          onClick={() => window.location.reload()}
          className="block mx-auto mt-3 text-sm underline hover:no-underline"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const { stats, recentPayments, lowStockProducts } = data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Visão geral do sistema</p>
      </div>

      {lowStockProducts.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-yellow-600 text-lg">⚠️</span>
            <span className="font-semibold text-yellow-800">Estoque baixo</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {lowStockProducts.map((p) => (
              <a
                key={p.id}
                href="/admin/products"
                className="inline-flex items-center gap-1 text-sm bg-yellow-100 hover:bg-yellow-200 text-yellow-800 px-3 py-1 rounded-full transition-colors"
              >
                <span>{p.name}</span>
                <span className="font-bold">({p.stock ?? 0} restantes)</span>
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Receita Total"
          value={`R$ ${stats.totalRevenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
          subtitle="Todos os tempos"
          icon="💰"
          color="green"
        />
        <StatsCard
          title="Receita Hoje"
          value={`R$ ${stats.revenueToday.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
          subtitle={`${stats.paymentsToday} pagamentos`}
          icon="📅"
          color="blue"
        />
        <StatsCard
          title="Receita no Mês"
          value={`R$ ${stats.revenueThisMonth.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
          subtitle={`${stats.paymentsThisMonth} pagamentos`}
          icon="📆"
          color="purple"
        />
        <StatsCard
          title="Pendentes"
          value={String(stats.totalPending)}
          subtitle="Aguardando pagamento"
          icon="⏳"
          color="yellow"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatsCard
          title="Aprovados"
          value={String(stats.totalApproved)}
          subtitle="Total de pagamentos confirmados"
          icon="✅"
          color="green"
        />
        <StatsCard
          title="Rejeitados/Cancelados"
          value={String(stats.totalRejected)}
          subtitle="Pagamentos não concluídos"
          icon="❌"
          color="red"
        />
        <StatsCard
          title="Taxa de Conversão"
          value={
            stats.totalApproved + stats.totalRejected > 0
              ? `${((stats.totalApproved / (stats.totalApproved + stats.totalRejected + stats.totalPending)) * 100).toFixed(1)}%`
              : '—'
          }
          subtitle="Aprovados / Total"
          icon="📊"
          color="blue"
        />
      </div>

      <RevenueChart data={chartData} />

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Pagamentos Recentes</h2>
          <a href="/admin/payments" className="text-sm text-blue-600 hover:text-blue-700 font-medium">
            Ver todos →
          </a>
        </div>
        <RecentPaymentsTable payments={recentPayments} />
      </div>
    </div>
  );
}
