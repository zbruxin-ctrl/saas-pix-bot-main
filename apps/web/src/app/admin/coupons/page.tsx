'use client';

import { useEffect, useState, useCallback } from 'react';
import { getCoupons, createCoupon, updateCoupon } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface CouponRow {
  id: string;
  code: string;
  discountType: 'PERCENT' | 'FIXED';
  discountValue: number;
  minOrderValue: number | null;
  maxUses: number | null;
  usedCount: number;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
}

const EMPTY_FORM = {
  code: '',
  discountType: 'PERCENT' as 'PERCENT' | 'FIXED',
  discountValue: 10,
  minOrderValue: null as number | null,
  maxUses: null as number | null,
  validUntil: null as string | null,
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
      discountType: row.discountType,
      discountValue: row.discountValue,
      minOrderValue: row.minOrderValue,
      maxUses: row.maxUses,
      validUntil: row.validUntil ? row.validUntil.slice(0, 10) : null,
      isActive: row.isActive,
    });
    setFormError('');
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.code.trim()) { setFormError('Código do cupom é obrigatório.'); return; }
    if (!form.discountValue || form.discountValue <= 0) { setFormError('Valor de desconto deve ser maior que zero.'); return; }
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        code: form.code,
        discountType: form.discountType,
        discountValue: form.discountValue,
        minOrderValue: form.minOrderValue,
        maxUses: form.maxUses,
        validUntil: form.validUntil || null,
        isActive: form.isActive,
      };
      if (editingId) {
        await updateCoupon(editingId, payload);
      } else {
        await createCoupon(payload);
      }
      setShowForm(false);
      fetchCoupons();
    } catch (err: any) {
      setFormError(err?.response?.data?.error || 'Erro ao salvar cupom.');
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
          <p className="text-gray-500 text-sm mt-1">{filtered.length} cupom{filtered.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={openCreate} className="btn-primary text-sm">
          + Novo Cupom
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
                    <p className="font-medium text-gray-500">Nenhum cupom encontrado</p>
                    <button onClick={openCreate} className="mt-3 text-blue-600 text-sm underline">Criar o primeiro cupom</button>
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const expired = r.validUntil ? new Date(r.validUntil) < new Date() : false;
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
                        {r.discountType === 'PERCENT'
                          ? `${r.discountValue}% off`
                          : `R$ ${r.discountValue.toFixed(2)} off`}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {r.usedCount}{r.maxUses != null ? ` / ${r.maxUses}` : ''}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {r.minOrderValue != null ? `R$ ${r.minOrderValue.toFixed(2)}` : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {r.validUntil ? formatDate(r.validUntil) : <span className="text-gray-400">—</span>}
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
                {editingId ? 'Editar Cupom' : 'Novo Cupom'}
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
                    value={form.discountType}
                    onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value as 'PERCENT' | 'FIXED' }))}
                  >
                    <option value="PERCENT">Porcentagem (%)</option>
                    <option value="FIXED">Valor fixo (R$)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Desconto ({form.discountType === 'PERCENT' ? '%' : 'R$'}) *
                  </label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    className="input w-full"
                    value={form.discountValue}
                    onChange={(e) => setForm((f) => ({ ...f, discountValue: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Máx. de usos</label>
                  <input
                    type="number"
                    min="1"
                    className="input w-full"
                    placeholder="Ilimitado"
                    value={form.maxUses ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value ? parseInt(e.target.value) : null }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Pedido mínimo (R$)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="input w-full"
                    placeholder="Sem mínimo"
                    value={form.minOrderValue ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, minOrderValue: e.target.value ? parseFloat(e.target.value) : null }))}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Expira em</label>
                <input
                  type="date"
                  className="input w-full"
                  value={form.validUntil ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value || null }))}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                  className="w-4 h-4 rounded border-gray-300"
                />
                <label htmlFor="isActive" className="text-sm font-medium text-gray-700">Cupom ativo</label>
              </div>
            </div>

            {formError && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
                {formError}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowForm(false)}
                className="flex-1 btn-secondary"
                disabled={saving}
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 btn-primary"
              >
                {saving ? 'Salvando...' : editingId ? 'Salvar alterações' : 'Criar cupom'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
