'use client';

import { useEffect, useState } from 'react';
import { getUser, getWalletBalance, adjustWalletBalance } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { toast } from '@/components/admin/Toast';

interface UserDetailModalProps {
  userId: string;
  userName: string;
  onClose: () => void;
}

interface UserDetail {
  id: string;
  telegramId: string;
  firstName: string | null;
  username: string | null;
  isBlocked: boolean;
  totalSpent: number;
  createdAt: string;
  payments: Array<{
    id: string;
    amount: number;
    status: string;
    createdAt: string;
    product?: { name: string } | null;
  }>;
  orders: Array<{
    id: string;
    status: string;
    createdAt: string;
    product?: { name: string } | null;
  }>;
}

interface WalletData {
  balance: number;
  transactions: Array<{
    id: string;
    type: string;
    amount: number;
    description: string;
    createdAt: string;
  }>;
}

export default function UserDetailModal({ userId, userName, onClose }: UserDetailModalProps) {
  const [user, setUser] = useState<UserDetail | null>(null);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pedidos' | 'saldo'>('pedidos');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustJustification, setAdjustJustification] = useState('');
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    Promise.all([
      getUser(userId).then((r) => r.data as UserDetail),
      getWalletBalance(userId).catch(() => null),
    ])
      .then(([u, w]) => {
        setUser(u);
        setWallet(w);
      })
      .finally(() => setLoading(false));
  }, [userId]);

  async function handleAdjust(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseFloat(adjustAmount);
    if (isNaN(amount) || amount === 0) {
      toast('Informe um valor válido (positivo para creditar, negativo para debitar).', 'error');
      return;
    }
    if (!adjustJustification.trim() || adjustJustification.trim().length < 5) {
      toast('Justificativa deve ter pelo menos 5 caracteres.', 'error');
      return;
    }
    setAdjusting(true);
    try {
      const result = await adjustWalletBalance(userId, amount, adjustJustification.trim());
      toast(`Saldo ajustado! Novo saldo: ${formatCurrency(result.newBalance)}`, 'success');
      const w = await getWalletBalance(userId).catch(() => null);
      setWallet(w);
      setAdjustAmount('');
      setAdjustJustification('');
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? 'Erro ao ajustar saldo.';
      toast(msg, 'error');
    } finally {
      setAdjusting(false);
    }
  }

  const statusLabel: Record<string, string> = {
    APPROVED: '✅ Aprovado',
    PENDING: '⏳ Pendente',
    CANCELLED: '❌ Cancelado',
    REJECTED: '❌ Rejeitado',
    EXPIRED: '⌛ Expirado',
    DELIVERED: '📦 Entregue',
    FAILED: '💥 Falhou',
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900">{userName}</h2>
              {user && (
                <div className="flex gap-3 mt-1 text-sm text-gray-500">
                  {user.username && <span>@{user.username}</span>}
                  <span className="font-mono">{user.telegramId}</span>
                  <span>Desde {formatDate(user.createdAt)}</span>
                </div>
              )}
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">
              ×
            </button>
          </div>

          {user && (
            <div className="mt-3 flex gap-4 text-sm">
              <div className="bg-green-50 px-3 py-1.5 rounded-lg">
                <span className="text-gray-500">Total gasto: </span>
                <strong className="text-green-700">{formatCurrency(user.totalSpent)}</strong>
              </div>
              <div className="bg-blue-50 px-3 py-1.5 rounded-lg">
                <span className="text-gray-500">Pedidos: </span>
                <strong className="text-blue-700">{user.orders.length}</strong>
              </div>
              {wallet && (
                <div className="bg-purple-50 px-3 py-1.5 rounded-lg">
                  <span className="text-gray-500">Saldo: </span>
                  <strong className="text-purple-700">{formatCurrency(wallet.balance)}</strong>
                </div>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : (
          <div className="px-6 py-4">
            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-4">
              <button
                onClick={() => setTab('pedidos')}
                className={[
                  'flex-1 text-sm font-medium py-1.5 rounded-md transition-colors',
                  tab === 'pedidos' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
                ].join(' ')}
              >
                📦 Pedidos ({user?.orders.length ?? 0})
              </button>
              <button
                onClick={() => setTab('saldo')}
                className={[
                  'flex-1 text-sm font-medium py-1.5 rounded-md transition-colors',
                  tab === 'saldo' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700',
                ].join(' ')}
              >
                💰 Saldo & Transações
              </button>
            </div>

            {tab === 'pedidos' && (
              <div className="space-y-2">
                {user?.orders.length === 0 ? (
                  <p className="text-center text-gray-400 py-8">Nenhum pedido ainda.</p>
                ) : (
                  user?.orders.map((o) => (
                    <div key={o.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg text-sm">
                      <div>
                        <div className="font-medium text-gray-900">{o.product?.name ?? 'Produto'}</div>
                        <div className="text-gray-400 text-xs">{formatDate(o.createdAt)}</div>
                      </div>
                      <span className="text-xs">{statusLabel[o.status] ?? o.status}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {tab === 'saldo' && (
              <div className="space-y-4">
                {/* Ajuste manual de saldo (requer SUPERADMIN no backend) */}
                <form onSubmit={handleAdjust} className="border border-gray-200 rounded-xl p-4 space-y-3">
                  <h3 className="font-semibold text-gray-800 text-sm">Ajuste manual de saldo</h3>
                  <p className="text-xs text-gray-400">Valor positivo = creditar · Valor negativo = debitar</p>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="0.01"
                      className="input flex-1 text-sm"
                      placeholder="Ex: 10 ou -5"
                      value={adjustAmount}
                      onChange={(e) => setAdjustAmount(e.target.value)}
                    />
                    <input
                      type="text"
                      className="input flex-1 text-sm"
                      placeholder="Justificativa (mín. 5 chars)"
                      value={adjustJustification}
                      onChange={(e) => setAdjustJustification(e.target.value)}
                    />
                    <button
                      type="submit"
                      disabled={adjusting}
                      className="btn-primary text-sm px-4 shrink-0"
                    >
                      {adjusting ? '...' : 'Aplicar'}
                    </button>
                  </div>
                </form>

                {/* Histórico de transações */}
                <div>
                  <h3 className="font-semibold text-gray-800 text-sm mb-2">Histórico de transações</h3>
                  {!wallet || wallet.transactions.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">Nenhuma transação ainda.</p>
                  ) : (
                    <div className="space-y-2">
                      {wallet.transactions.map((t) => (
                        <div key={t.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg text-sm">
                          <div>
                            <div className="text-gray-700">{t.description}</div>
                            <div className="text-gray-400 text-xs">{formatDate(t.createdAt)}</div>
                          </div>
                          <span className={[
                            'font-semibold',
                            t.type === 'DEPOSIT' ? 'text-green-600' : 'text-red-500',
                          ].join(' ')}>
                            {t.type === 'DEPOSIT' ? '+' : '-'}{formatCurrency(Math.abs(t.amount))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
