'use client';

import { useEffect, useState, useCallback } from 'react';
import { getPayments } from '@/lib/api';
import { useRouter } from 'next/navigation';
import StatusBadge from '@/components/admin/StatusBadge';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { PaymentDTO, PaginatedResponse } from '@saas-pix/shared';

const STATUS_OPTIONS = [
  { value: '', label: 'Todos os status' },
  { value: 'APPROVED', label: '✅ Aprovado' },
  { value: 'PENDING', label: '⏳ Pendente' },
  { value: 'REJECTED', label: '❌ Rejeitado' },
  { value: 'CANCELLED', label: '🚫 Cancelado' },
  { value: 'EXPIRED', label: '⌛ Expirado' },
];

// Retorna o nome do produto a exibir na coluna "Produto"
function getProductLabel(p: PaymentDTO): string {
  if (p.product?.name) return p.product.name;
  // Sem produto vinculado = depósito de saldo
  return '💰 Saldo';
}

export default function PaymentsPage() {
  const router = useRouter();
  const [result, setResult] = useState<PaginatedResponse<PaymentDTO> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const fetchPayments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getPayments({ page, status: status || undefined, search: search || undefined });
      setResult(res.data ?? null);
    } catch {
      //
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

  useEffect(() => {
    const t = setTimeout(fetchPayments, 300);
    return () => clearTimeout(t);
  }, [fetchPayments]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Pagamentos</h1>
        <p className="text-gray-500 text-sm mt-1">
          {result ? `${result.total} pagamentos encontrados` : 'Carregando...'}
        </p>
      </div>

      {/* Filtros */}
      <div className="card">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            className="input flex-1"
            placeholder="Buscar por nome, ID do pagamento ou Telegram ID..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          <select
            className="input sm:w-48"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Tabela */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Usuário</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Produto</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Valor</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Data</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Ação</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto" />
                  </td>
                </tr>
              ) : result?.data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400">
                    Nenhum pagamento encontrado
                  </td>
                </tr>
              ) : (
                result?.data.map((p) => (
                  <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {p.telegramUser?.firstName || p.telegramUser?.username || '—'}
                      </div>
                      <div className="text-gray-400 text-xs">ID: {p.telegramUser?.telegramId}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{getProductLabel(p)}</td>
                    <td className="px-4 py-3 font-semibold text-gray-900">
                      {formatCurrency(p.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {formatDate(p.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => router.push(`/admin/payments/${p.id}`)}
                        className="text-blue-600 hover:text-blue-700 font-medium text-xs"
                      >
                        Ver detalhes →
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        {result && result.totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">
              Página {result.page} de {result.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-secondary text-sm py-1 px-3 disabled:opacity-40"
              >
                ← Anterior
              </button>
              <button
                onClick={() => setPage((p) => Math.min(result.totalPages, p + 1))}
                disabled={page === result.totalPages}
                className="btn-secondary text-sm py-1 px-3 disabled:opacity-40"
              >
                Próxima →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
