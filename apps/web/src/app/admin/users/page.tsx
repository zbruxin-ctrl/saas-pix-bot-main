'use client';

import { useEffect, useState, useCallback } from 'react';
import { getUsers, toggleBlockUser, getUsersExportUrl } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from '@/components/admin/Toast';
import ConfirmModal from '@/components/admin/ConfirmModal';
import UserDetailModal from '@/components/admin/UserDetailModal';

interface User {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  isBlocked: boolean;
  totalSpent: number;
  createdAt: string;
  _count?: { payments: number; orders: number };
}

interface UsersResult {
  data: User[];
  total: number;
  totalPages: number;
}

// Retorna label de exibição do usuário.
// Se tem firstName, usa ele. Caso contrário mostra o telegramId
// com badge "WhatsApp" (verde) para indicar que veio do WhatsApp.
function getUserLabel(u: User): {
  name: string;
  sub: string | null;
  badge: 'whatsapp' | null;
} {
  if (u.firstName) {
    return { name: u.firstName, sub: u.username ? `@${u.username}` : null, badge: null };
  }
  // Sem firstName = veio do WhatsApp (IDs de Telegram sempre têm nome)
  return { name: u.telegramId, sub: null, badge: 'whatsapp' };
}

export default function UsersPage() {
  const [result, setResult] = useState<UsersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [blockConfirm, setBlockConfirm] = useState<User | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getUsers({ page, search: search || undefined });
      const paginated = res.data;
      if (paginated) {
        setResult({
          data: paginated.data as unknown as User[],
          total: paginated.total,
          totalPages: paginated.totalPages,
        });
      }
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const t = setTimeout(fetchUsers, 300);
    return () => clearTimeout(t);
  }, [fetchUsers]);

  async function handleBlockToggle() {
    if (!blockConfirm) return;
    setBlocking(true);
    try {
      const res = await toggleBlockUser(blockConfirm.id);
      toast(res.message, 'success');
      fetchUsers();
    } catch {
      toast('Erro ao alterar bloqueio do usuário.', 'error');
    } finally {
      setBlocking(false);
      setBlockConfirm(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Usuários</h1>
          <p className="text-gray-500 text-sm mt-1">
            {result ? `${result.total} usuários cadastrados` : 'Carregando...'}
          </p>
        </div>
        <a
          href={getUsersExportUrl()}
          download="usuarios.csv"
          className="btn-secondary text-sm flex items-center gap-1"
        >
          ⬇ Exportar CSV
        </a>
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
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Ações</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="text-center py-12">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto" />
                </td>
              </tr>
            ) : result?.data.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-gray-400">Nenhum usuário encontrado</td>
              </tr>
            ) : (
              result?.data.map((u) => {
                const label = getUserLabel(u);
                return (
                  <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`font-medium ${
                          label.badge === 'whatsapp' ? 'text-gray-500 font-mono text-xs' : 'text-gray-900'
                        }`}>
                          {label.name}
                        </span>
                        {label.badge === 'whatsapp' && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium whitespace-nowrap">
                            WhatsApp
                          </span>
                        )}
                      </div>
                      {label.sub && (
                        <div className="text-gray-400 text-xs">{label.sub}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{u.telegramId}</td>
                    <td className="px-4 py-3 font-semibold text-green-700">{formatCurrency(u.totalSpent)}</td>
                    <td className="px-4 py-3 text-gray-700">{u._count?.orders ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className={[
                        'text-xs px-2 py-1 rounded-full font-medium',
                        u.isBlocked
                          ? 'bg-red-100 text-red-700'
                          : 'bg-green-100 text-green-700',
                      ].join(' ')}>
                        {u.isBlocked ? '🚫 Bloqueado' : '✅ Ativo'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => setSelectedUser(u)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Ver
                        </button>
                        <button
                          onClick={() => setBlockConfirm(u)}
                          className={[
                            'text-xs font-medium',
                            u.isBlocked
                              ? 'text-green-600 hover:text-green-800'
                              : 'text-red-500 hover:text-red-700',
                          ].join(' ')}
                        >
                          {u.isBlocked ? 'Desbloquear' : 'Bloquear'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {result && result.totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Página {page} de {result.totalPages}</span>
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

      {selectedUser && (
        <UserDetailModal
          userId={selectedUser.id}
          userName={selectedUser.firstName ?? selectedUser.telegramId}
          onClose={() => setSelectedUser(null)}
        />
      )}

      <ConfirmModal
        open={!!blockConfirm}
        title={blockConfirm?.isBlocked ? 'Desbloquear usuário?' : 'Bloquear usuário?'}
        message={
          blockConfirm?.isBlocked
            ? `${blockConfirm?.firstName ?? 'Este usuário'} poderá voltar a usar o bot normalmente.`
            : `${blockConfirm?.firstName ?? 'Este usuário'} não conseguirá fazer compras no bot enquanto bloqueado.`
        }
        confirmLabel={blockConfirm?.isBlocked ? 'Desbloquear' : 'Bloquear'}
        cancelLabel="Cancelar"
        danger={!blockConfirm?.isBlocked}
        onConfirm={handleBlockToggle}
        onCancel={() => setBlockConfirm(null)}
      />
      {blocking && (
        <div className="fixed inset-0 flex items-center justify-center z-[60] bg-black/20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
        </div>
      )}
    </div>
  );
}
