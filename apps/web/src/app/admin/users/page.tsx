'use client';

import { useEffect, useState, useCallback } from 'react';
import { getUsers } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';

interface User {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  isBlocked: boolean;
  totalSpent: number;
  createdAt: string;
  _count: { payments: number; orders: number };
}

export default function UsersPage() {
  const [result, setResult] = useState<{ data: User[]; total: number; totalPages: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getUsers({ page, search: search || undefined });
      setResult(data);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const t = setTimeout(fetchUsers, 300);
    return () => clearTimeout(t);
  }, [fetchUsers]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Usuários</h1>
        <p className="text-gray-500 text-sm mt-1">
          {result ? `${result.total} usuários cadastrados` : 'Carregando...'}
        </p>
      </div>

      <div className="card">
        <input
          className="input"
          placeholder="Buscar por nome, username ou Telegram ID..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Usuário</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Telegram ID</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Total Gasto</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Pedidos</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Desde</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="text-center py-12">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto" />
                </td>
              </tr>
            ) : result?.data.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-12 text-gray-400">Nenhum usuário encontrado</td>
              </tr>
            ) : (
              result?.data.map((u) => (
                <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{u.firstName || '—'}</div>
                    {u.username && <div className="text-gray-400 text-xs">@{u.username}</div>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{u.telegramId}</td>
                  <td className="px-4 py-3 font-semibold text-green-700">{formatCurrency(u.totalSpent)}</td>
                  <td className="px-4 py-3 text-gray-700">{u._count.orders}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(u.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {result && result.totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Página {page} de {result.totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary text-sm py-1 px-3 disabled:opacity-40">← Anterior</button>
              <button onClick={() => setPage((p) => Math.min(result.totalPages, p + 1))} disabled={page === result.totalPages} className="btn-secondary text-sm py-1 px-3 disabled:opacity-40">Próxima →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
