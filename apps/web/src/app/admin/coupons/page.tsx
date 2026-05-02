'use client';

import { useEffect, useState, useCallback } from 'react';
import { getCoupons, createCoupon, updateCoupon } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface CouponRow {
  id: string;
  code: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
  minOrderValue: number | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

const EMPTY_FORM: Omit<CouponRow, 'id' | 'usedCount' | 'createdAt'> = {
  code: '',
  type: 'PERCENT',
  value: 10,
  minOrderValue: null,
  maxUses: null,
  expiresAt: null,
  isActive: true,
};

export default function CouponsPage() {
  const [rows, setRows] = useState<CouponRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<typeof EMPTY_FORM>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const fetchCoupons = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getCoupons({ search: search || undefined });
      setRows(res);
    } catch {
      //
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(fetchCoupons, 300);
    return () => clearTimeout(t);
  }, [fetchCoupons]);

  function openCreate() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError('');
    setShowForm(true);
  }

  function openEdit(row: CouponRow) {
    setEditingId(row.id);
    setForm({
      code: row.code,
      type: row.type,
      value: row.value,
      minOrderValue: row.minOrderValue,
      maxUses: row.maxUses,
      expiresAt: row.expiresAt ? row.expiresAt.slice(0, 10) : null,
      isActive: row.isActive,
    });
    setFormError('');
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.code.trim()) { setFormError('Código do cupão é obrigatório.'); return; }
    if (form.value <= 0) { setFormError('Valor deve ser maior que zero.'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (editingId) {
        await updateCoupon(editingId, form);
      } else {
        await createCoupon(form);
      }
      setShowForm(false);
      fetchCoupons();
    } catch (err: any) {
      setFormError(err?.response?.data?.error || 'Erro ao salvar cupão.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(row: CouponRow) {
    try {
      await updateCoupon(row.id, { isActive: !row.isActive });
      fetchCoupons();
    } catch {
      //
    }
  }

  const filtered = rows.filter((r) =>
    !search || r.code.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🏷️ Cupons</h1>
          <p className="text-gray-500 text-sm mt-1">{filtered.length} cupão{filtered.length !== 1 ? 'ões' : ''}</p>
        </div>
        <button onClick={openCreate} className="btn-primary text-sm">
          + Novo Cupão
        </button>
      </div>

      {/* Filtro */}
      <div className="card">
        <input
          className="input w-full"
          placeholder="Buscar por código..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Tabela */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Código</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Desconto</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Usos</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Mín. pedido</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Expira em</th>
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
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-gray-400">
                    <div className="text-3xl mb-2">🏷️</div>
                    <p className="font-medium text-gray-500">Nenhum cupão encontrado</p>
                    <button onClick={openCreate} className="mt-3 text-blue-600 text-sm underline">Criar o primeiro cupão</button>
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const expired = r.expiresAt ? new Date(r.expiresAt) < new Date() : false;
                  const esgotado = r.maxUses != null && r.usedCount >= r.maxUses;
                  const statusLabel = !r.isActive ? 'Inativo' : expired ? 'Expirado' : esgotado ? 'Esgotado' : 'Ativo';
                  const statusClass = !r.isActive || expired || esgotado
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-green-50 text-green-700 border-green-200';

                  return (
                    <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold text-gray-900 bg-gray-100 px-2 py-0.5 rounded">
                          {r.code}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-semibold text-gray-900">
                        {r.type === 'PERCENT'
                          ? `${r.value}% off`
                          : `R$ ${r.value.toFixed(2)} off`}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {r.usedCount}{r.maxUses != null ? ` / ${r.maxUses}` : ''}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {r.minOrderValue != null ? `R$ ${r.minOrderValue.toFixed(2)}` : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {r.expiresAt ? formatDate(r.expiresAt) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border ${statusClass}`}>
                          {statusLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => openEdit(r)}
                            className="text-blue-600 hover:text-blue-700 text-xs font-medium"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => handleToggle(r)}
                            className={`text-xs font-medium ${r.isActive ? 'text-red-500 hover:text-red-700' : 'text-green-600 hover:text-green-700'}`}
                          >
                            {r.isActive ? 'Desativar' : 'Ativar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de criação/edição */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900">
                {editingId ? 'Editar Cupão' : 'Novo Cupão'}
              </h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Código *</label>
                <input
                  className="input w-full uppercase"
                  placeholder="EX10, PROMO2026..."
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo</label>
                  <select
                    className="input w-full"
                    value={form.type}
                    onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as 'PERCENT' | 'FIXED' }))}
                  >
                    <option value="PERCENT">Porcentagem (%)</option>
                    <option value="FIXED">Valor fixo (R$)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {form.type === 'PERCENT' ? 'Desconto (%)' : 'Desconto (R$)'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step={form.type === 'PERCENT' ? '1' : '0.01'}
                    className="input w-full"
                    value={form.value}
                    onChange={(e) => setForm((f) => ({ ...f, value: Number(e.target.value) }))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Máx. de usos</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="Ilimitado"
                    className="input w-full"
                    value={form.maxUses ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value ? Number(e.target.value) : null }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Pedido mínimo (R$)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Sem mínimo"
                    className="input w-full"
                    value={form.minOrderValue ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, minOrderValue: e.target.value ? Number(e.target.value) : null }))}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Expira em</label>
                <input
                  type="date"
                  className="input w-full"
                  value={form.expiresAt ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value || null }))}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600"
                />
                <label htmlFor="isActive" className="text-sm text-gray-700">Cupão ativo</label>
              </div>
            </div>

            {formError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {formError}
              </p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowForm(false)}
                className="btn-secondary flex-1"
                disabled={saving}
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                className="btn-primary flex-1"
                disabled={saving}
              >
                {saving ? 'Salvando...' : editingId ? 'Salvar alterações' : 'Criar cupão'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
