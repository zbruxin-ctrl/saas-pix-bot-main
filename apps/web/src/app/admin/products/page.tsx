'use client';

import { useEffect, useState } from 'react';
import { getProducts, createProduct, updateProduct, deleteProduct } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  deliveryType: string;
  deliveryContent: string;
  isActive: boolean;
  stock: number | null;
  _count?: { payments: number; orders: number };
}

const EMPTY_FORM = {
  name: '',
  description: '',
  price: '',
  deliveryType: 'TEXT',
  deliveryContent: '',
  isActive: true,
  stock: '',
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadProducts = () => {
    setLoading(true);
    getProducts()
      .then(setProducts)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadProducts(); }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditId(null);
    setError('');
    setShowModal(true);
  }

  function openEdit(p: Product) {
    setForm({
      name: p.name,
      description: p.description,
      price: String(p.price),
      deliveryType: p.deliveryType,
      deliveryContent: p.deliveryContent || '',
      isActive: p.isActive,
      stock: p.stock != null ? String(p.stock) : '',
    });
    setEditId(p.id);
    setError('');
    setShowModal(true);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        price: parseFloat(form.price),
        stock: form.stock ? parseInt(form.stock) : null,
      };
      if (editId) {
        await updateProduct(editId, payload);
      } else {
        await createProduct(payload);
      }
      setShowModal(false);
      loadProducts();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Erro ao salvar produto');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Desativar este produto? Ele não aparecerá mais no bot.')) return;
    await deleteProduct(id);
    loadProducts();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Produtos</h1>
          <p className="text-gray-500 text-sm mt-1">{products.length} produtos cadastrados</p>
        </div>
        <button onClick={openCreate} className="btn-primary">+ Novo Produto</button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {products.map((p) => (
            <div key={p.id} className={`card relative ${!p.isActive ? 'opacity-60' : ''}`}>
              {!p.isActive && (
                <span className="absolute top-3 right-3 text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">
                  Inativo
                </span>
              )}
              <h3 className="font-semibold text-gray-900 mb-1 pr-16">{p.name}</h3>
              <p className="text-sm text-gray-500 mb-3 line-clamp-2">{p.description}</p>
              <div className="text-2xl font-bold text-blue-600 mb-3">{formatCurrency(p.price)}</div>
              <div className="flex items-center gap-2 text-xs text-gray-500 mb-4">
                <span className="bg-gray-100 px-2 py-1 rounded">{p.deliveryType}</span>
                {p.stock != null && (
                  <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">
                    {p.stock} em estoque
                  </span>
                )}
              </div>
              {p._count && (
                <div className="text-xs text-gray-400 mb-4">
                  {p._count.payments} pagamentos · {p._count.orders} pedidos
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => openEdit(p)}
                  className="btn-secondary text-sm flex-1"
                >
                  Editar
                </button>
                <button
                  onClick={() => handleDelete(p.id)}
                  className="btn-danger text-sm px-3"
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal criar/editar */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-6">
              {editId ? 'Editar Produto' : 'Novo Produto'}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome *</label>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Plano Pro" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Descrição *</label>
                <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Descrição exibida no bot" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Preço (R$) *</label>
                  <input className="input" type="number" step="0.01" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="29.90" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Estoque</label>
                  <input className="input" type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} placeholder="Vazio = ilimitado" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Entrega *</label>
                <select className="input" value={form.deliveryType} onChange={(e) => setForm({ ...form, deliveryType: e.target.value })}>
                  <option value="TEXT">TEXT — Mensagem de texto</option>
                  <option value="LINK">LINK — Link de acesso</option>
                  <option value="TOKEN">TOKEN — Chave/Token</option>
                  <option value="ACCOUNT">ACCOUNT — Dados de conta (JSON)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Conteúdo de Entrega *</label>
                <textarea className="input font-mono text-xs" rows={4} value={form.deliveryContent} onChange={(e) => setForm({ ...form, deliveryContent: e.target.value })} placeholder={form.deliveryType === 'ACCOUNT' ? '{"message": "Acesso liberado!", "accessUrl": "https://..."}' : 'Texto, link ou token que será enviado ao usuário'} />
                <p className="text-xs text-gray-400 mt-1">
                  {form.deliveryType === 'ACCOUNT' ? 'Insira um JSON válido.' : 'Este conteúdo será enviado automaticamente após o pagamento.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="isActive" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="rounded" />
                <label htmlFor="isActive" className="text-sm font-medium text-gray-700">Produto ativo</label>
              </div>
            </div>

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">{error}</div>
            )}

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="btn-secondary flex-1">Cancelar</button>
              <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">
                {saving ? 'Salvando...' : editId ? 'Salvar' : 'Criar Produto'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
