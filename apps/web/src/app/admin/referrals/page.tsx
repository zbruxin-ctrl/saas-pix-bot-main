'use client';

import { useEffect, useState, useCallback } from 'react';
import { getReferrals } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface ReferralRow {
  id: string;
  referrer: { telegramId: string; firstName?: string; username?: string };
  referred: { telegramId: string; firstName?: string; username?: string };
  createdAt: string;
  converted: boolean;
  rewardPaid: number;
}

interface ReferralSummary {
  totalReferrals: number;
  totalConverted: number;
  totalRewardsPaid: number;
}

export default function ReferralsPage() {
  const [rows, setRows] = useState<ReferralRow[]>([]);
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchReferrals = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getReferrals({ page, search: search || undefined });
      setRows(res.data);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      setSummary(res.summary);
    } catch {
      //
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const t = setTimeout(fetchReferrals, 300);
    return () => clearTimeout(t);
  }, [fetchReferrals]);

  function userName(u: { firstName?: string; username?: string; telegramId: string }) {
    return u.firstName || u.username || `ID ${u.telegramId}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">🎁 Indicações</h1>
        <p className="text-gray-500 text-sm mt-1">
          {loading ? 'Carregando...' : `${total} indicação${total !== 1 ? 'ões' : ''} registrada${total !== 1 ? 's' : ''}`}
        </p>
      </div>

      {/* Cards de resumo */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total de indicações</p>
            <p className="text-3xl font-bold text-gray-900 mt-1">{summary.totalReferrals}</p>
          </div>
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Indicados que compraram</p>
            <p className="text-3xl font-bold text-green-700 mt-1">{summary.totalConverted}</p>
            {summary.totalReferrals > 0 && (
              <p className="text-xs text-gray-400 mt-1">
                {Math.round((summary.totalConverted / summary.totalReferrals) * 100)}% de conversão
              </p>
            )}
          </div>
          <div className="card">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total de recompensas pagas</p>
            <p className="text-3xl font-bold text-blue-700 mt-1">
              R$ {summary.totalRewardsPaid.toFixed(2)}
            </p>
          </div>
        </div>
      )}

      {/* Filtro */}
      <div className="card">
        <input
          className="input w-full"
          placeholder="Buscar por nome ou Telegram ID do indicador ou indicado..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {/* Tabela */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Quem indicou</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Quem foi indicado</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Data</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Converteu?</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Recompensa</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="text-center py-12">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-12 text-gray-400">
                    <div className="text-3xl mb-2">🤝</div>
                    <p className="font-medium text-gray-500">Nenhuma indicação encontrada</p>
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{userName(r.referrer)}</div>
                      <div className="text-gray-400 text-xs">ID: {r.referrer.telegramId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{userName(r.referred)}</div>
                      <div className="text-gray-400 text-xs">ID: {r.referred.telegramId}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(r.createdAt)}</td>
                    <td className="px-4 py-3">
                      {r.converted ? (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                          ✅ Comprou
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
                          ⏳ Pendente
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900">
                      {r.rewardPaid > 0 ? (
                        <span className="text-green-700">+ R$ {r.rewardPaid.toFixed(2)}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Página {page} de {totalPages}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn-secondary text-sm py-1 px-3 disabled:opacity-40"
              >
                ← Anterior
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
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
