'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { getUsers, toggleBlockUser, getUsersExportUrl, updateUserFirstName } from '@/lib/api';
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

function getUserLabel(u: User): {
  name: string;
  sub: string | null;
  badge: 'whatsapp' | null;
} {
  if (u.firstName) {
    return { name: u.firstName, sub: u.username ? `@${u.username}` : null, badge: null };
  }
  return { name: u.telegramId, sub: null, badge: 'whatsapp' };
}

// ─── Componente de edição inline de nome ─────────────────────────────────────
function EditNameCell({
  user,
  onSaved,
}: {
  user: User;
  onSaved: (id: string, newName: string) => void;
}) {
  const label = getUserLabel(user);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(user.firstName ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) { toast('Nome não pode ser vazio.', 'error'); return; }
    if (trimmed === (user.firstName ?? '')) { setEditing(false); return; }
    setSaving(true);
    try {
      const res = await updateUserFirstName(user.id, trimmed);
      onSaved(user.id, res.firstName ?? trimmed);
      toast('Nome atualizado!', 'success');
      setEditing(false);
    } catch {
      toast('Erro ao salvar nome.', 'error');
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') { setValue(user.firstName ?? ''); setEditing(false); }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          className="border border-blue-400 rounded px-2 py-0.5 text-sm w-36 focus:outline-none focus:ring-1 focus:ring-blue-500"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={saving}
          placeholder="Nome ou número"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-xs text-white bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded disabled:opacity-50"
        >
          {saving ? '...' : '✓'}
        </button>
        <button
          onClick={() => { setValue(user.firstName ?? ''); setEditing(false); }}
          className="text-xs text-gray-500 hover:text-gray-700 px-1 py-1"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 group">
      <div>
        <div className="flex items-center gap-1.5">
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
      </div>
      <button
        onClick={() => { setValue(user.firstName ?? ''); setEditing(true); }}
        title="Editar nome"
        className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-600 p-0.5 rounded"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
    </div>
  );
}

// ─── Página principal ────────────────────────────────────────────────────────
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

  // Atualiza o nome localmente sem refetch
  function handleNameSaved(id: string, newName: string) {
    setResult((prev) =>
      prev
        ? { ...prev, data: prev.data.map((u) => u.id === id ? { ...u, firstName: newName } : u) }
        : prev
    );
  }

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
              result?.data.map((u) => (
                <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <EditNameCell user={u} onSaved={handleNameSaved} />
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
              ))
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
