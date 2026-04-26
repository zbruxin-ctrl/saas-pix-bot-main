'use client';

import { useEffect, useState } from 'react';
import { getDashboard } from '@/lib/api';
import type { DashboardStats, RecentPaymentItem } from '@saas-pix/shared';
import StatsCard from '@/components/admin/StatsCard';
import RecentPaymentsTable from '@/components/admin/RecentPaymentsTable';

interface DashboardData {
  stats: DashboardStats;
  recentPayments: RecentPaymentItem[];
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getDashboard()
      .then(setData)
      .catch(() => setError('Erro ao carregar dashboard'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
        {error}
      </div>
    );
  }

  const { stats, recentPayments } = data!;

  return (
    <div className="space-y-6">
      {/* Título */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Visão geral do sistema</p>
      </div>

      {/* Cards de estatísticas */}
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

      {/* Segunda linha de cards */}
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

      {/* Tabela de pagamentos recentes */}
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
