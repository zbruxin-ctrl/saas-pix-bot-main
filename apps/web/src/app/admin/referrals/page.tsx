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

interface ReferralConfig {
  referral_enabled: string;
  referral_reward_amount: string;
  referral_min_purchase: string;
  referral_max_per_user: string;
  referral_reward_message: string;
}

// ─── Card de configurações do programa de indicação ──────────────────────────
function ReferralSettingsCard() {
  const [cfg, setCfg] = useState<ReferralConfig>({
    referral_enabled:        'true',
    referral_reward_amount:  '5.00',
    referral_min_purchase:   '0.00',
    referral_max_per_user:   '0',
    referral_reward_message: 'Você ganhou R$ {amount} por indicar {name}! 🎉',
  });
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [original, setOriginal] = useState<ReferralConfig | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  function showToast(msg: string, type: 'success' | 'error') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  useEffect(() => {
    fetch('/api/admin/settings', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data) {
          const loaded: ReferralConfig = {
            referral_enabled:        d.data.referral_enabled        ?? 'true',
            referral_reward_amount:  d.data.referral_reward_amount  ?? '5.00',
            referral_min_purchase:   d.data.referral_min_purchase   ?? '0.00',
            referral_max_per_user:   d.data.referral_max_per_user   ?? '0',
            referral_reward_message: d.data.referral_reward_message ?? 'Você ganhou R$ {amount} por indicar {name}! 🎉',
          };
          setCfg(loaded);
          setOriginal(loaded);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof ReferralConfig>(key: K, value: ReferralConfig[K]) {
    setCfg((c) => ({ ...c, [key]: value }));
  }

  const isDirty = original ? JSON.stringify(cfg) !== JSON.stringify(original) : false;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: cfg }),
        credentials: 'include',
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? 'Erro ao salvar');
      setOriginal(cfg);
      showToast('Configurações salvas com sucesso', 'success');
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Erro ao salvar', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return (
    <div className="card flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600" />
    </div>
  );

  return (
    <div className="card space-y-5">
      <div>
        <h2 className="text-lg font-bold text-gray-900">⚙️ Configurações do Programa</h2>
        <p className="text-sm text-gray-500 mt-0.5">Personalize as regras de recompensa por indicação</p>
      </div>

      {toast && (
        <div className={`rounded-xl border px-4 py-3 text-sm flex items-center gap-3 ${
          toast.type === 'success'
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}>
          <span className="text-lg">{toast.type === 'success' ? '✅' : '❌'}</span>
          {toast.msg}
        </div>
      )}

      <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <div>
          <p className="font-medium text-gray-900">Programa de indicação</p>
          <p className="text-sm text-gray-500">Habilita ou desabilita todo o sistema de indicações</p>
        </div>
        <button
          type="button"
          onClick={() => set('referral_enabled', cfg.referral_enabled === 'true' ? 'false' : 'true')}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${
            cfg.referral_enabled === 'true' ? 'bg-green-500' : 'bg-gray-200'
          }`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            cfg.referral_enabled === 'true' ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-900">💰 Recompensa por indicação (R$)</label>
          <input type="number" min="0" step="0.50" className="input w-full"
            value={cfg.referral_reward_amount}
            onChange={(e) => set('referral_reward_amount', e.target.value)} />
          <p className="text-xs text-gray-400">Valor creditado ao indicador quando o indicado compra</p>
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-900">🛒 Compra mínima do indicado (R$)</label>
          <input type="number" min="0" step="1" className="input w-full"
            value={cfg.referral_min_purchase}
            onChange={(e) => set('referral_min_purchase', e.target.value)} />
          <p className="text-xs text-gray-400"><code className="bg-gray-100 px-1 rounded">0</code> = qualquer valor aceito</p>
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-900">🏆 Máx. recompensas por indicador</label>
          <input type="number" min="0" step="1" className="input w-full"
            value={cfg.referral_max_per_user}
            onChange={(e) => set('referral_max_per_user', e.target.value)} />
          <p className="text-xs text-gray-400"><code className="bg-gray-100 px-1 rounded">0</code> = ilimitado</p>
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-900">💬 Mensagem enviada ao indicador</label>
          <input type="text" className="input w-full"
            value={cfg.referral_reward_message}
            onChange={(e) => set('referral_reward_message', e.target.value)} />
          <p className="text-xs text-gray-400">
            Use <code className="bg-gray-100 px-1 rounded">{'{amount}'}</code> para o valor e{' '}
            <code className="bg-gray-100 px-1 rounded">{'{name}'}</code> para o nome do indicado
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-100">
        {isDirty && (
          <button onClick={() => original && setCfg(original)} disabled={saving} className="btn-secondary text-sm">
            Descartar
          </button>
        )}
        <button onClick={save} disabled={!isDirty || saving} className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed">
          {saving ? (
            <span className="flex items-center gap-2">
              <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white inline-block" />
              Salvando...
            </span>
          ) : '💾 Salvar configurações'}
        </button>
      </div>
    </div>
  );
}

// ─── Página principal de indicações ─────────────────────────────────────────
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
            <p className="text-3xl font-bold text-blue-700 mt-1">R$ {summary.totalRewardsPaid.toFixed(2)}</p>
          </div>
        </div>
      )}

      <ReferralSettingsCard />

      <div className="card">
        <input className="input w-full"
          placeholder="Buscar por nome ou Telegram ID do indicador ou indicado..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>

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
                <tr><td colSpan={5} className="text-center py-12">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto" />
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400">
                  <div className="text-3xl mb-2">🤝</div>
                  <p className="font-medium text-gray-500">Nenhuma indicação encontrada</p>
                </td></tr>
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
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200">✅ Comprou</span>
                      ) : (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">⏳ Pendente</span>
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
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Página {page} de {totalPages}</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="btn-secondary text-sm py-1 px-3 disabled:opacity-40">← Anterior</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                className="btn-secondary text-sm py-1 px-3 disabled:opacity-40">Próxima →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
