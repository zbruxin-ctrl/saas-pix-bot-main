'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductMedias,
  updateProductMedias,
  uploadMediaFile,
  type ProductMedia,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { toast } from '@/components/admin/Toast';
import ConfirmModal from '@/components/admin/ConfirmModal';

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

interface DeliveryItem {
  id: string;
  value: string;
}

const DELIVERY_TYPES = [
  { value: 'TEXT', label: 'TEXT — Mensagem de texto' },
  { value: 'LINK', label: 'LINK — Link de acesso' },
  { value: 'FILE_MEDIA', label: 'FILE_MEDIA — Foto / Vídeo / Arquivo' },
  { value: 'ACCOUNT', label: 'ACCOUNT — Dados de conta (JSON)' },
];

const MEDIA_TYPES: { value: ProductMedia['mediaType']; label: string }[] = [
  { value: 'IMAGE', label: '🖼 Imagem' },
  { value: 'VIDEO', label: '🎬 Vídeo' },
  { value: 'FILE', label: '📎 Arquivo' },
];

const ACCEPT_BY_TYPE: Record<ProductMedia['mediaType'], string> = {
  IMAGE: 'image/jpeg,image/png,image/gif,image/webp',
  VIDEO: 'video/mp4,video/webm,video/ogg',
  FILE: '*/*',
};

const EMPTY_FORM = {
  name: '',
  description: '',
  price: '',
  deliveryType: 'TEXT',
  deliveryContent: '',
  isActive: true,
  stock: '',
};

function itemsToContent(items: DeliveryItem[]): string {
  const vals = items.map((i) => i.value.trim()).filter(Boolean);
  return JSON.stringify(vals);
}

function contentToItems(content: string): DeliveryItem[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map((v, i) => ({ id: String(i), value: String(v) }));
    }
  } catch {}
  return [{ id: '0', value: content }];
}

function newItem(): DeliveryItem {
  return { id: String(Date.now() + Math.random()), value: '' };
}

function newMedia(): ProductMedia {
  return { url: '', mediaType: 'IMAGE', caption: '' };
}

function validate(form: typeof EMPTY_FORM, items: DeliveryItem[]): string | null {
  if (!form.name.trim()) return 'O nome do produto é obrigatório.';
  if (!form.description.trim()) return 'A descrição é obrigatória.';

  const price = parseFloat(form.price);
  if (isNaN(price) || price <= 0) return 'Informe um preço válido maior que zero.';

  const usesItems = ['ACCOUNT', 'LINK', 'TEXT'].includes(form.deliveryType);

  if (usesItems) {
    const filled = items.filter((i) => i.value.trim());
    if (filled.length === 0) return 'Adicione pelo menos um item de entrega.';

    if (form.deliveryType === 'ACCOUNT') {
      for (const item of filled) {
        try {
          JSON.parse(item.value);
        } catch {
          return `O item "${item.value.slice(0, 30)}..." não é um JSON válido.`;
        }
      }
    }
  } else if (form.deliveryType === 'FILE_MEDIA') {
    if (!form.deliveryContent.trim()) return 'Informe a URL ou file_id da mídia.';
  }

  return null;
}

interface MediaRowProps {
  media: ProductMedia;
  idx: number;
  onUpdate: (idx: number, patch: Partial<ProductMedia>) => void;
  onRemove: (idx: number) => void;
}

function MediaRow({ media, idx, onUpdate, onRemove }: MediaRowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);

    try {
      const uploadedUrl = await uploadMediaFile(file, media.mediaType);
      onUpdate(idx, { url: uploadedUrl });
      toast('Upload concluído com sucesso!', 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao fazer upload';
      toast(msg, 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const isImage = media.mediaType === 'IMAGE' && /^https?:\/\//.test(media.url);

  return (
    <div className="border border-gray-200 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500">Mídia {idx + 1}</span>
        <button
          type="button"
          onClick={() => onRemove(idx)}
          className="text-red-400 hover:text-red-600 text-sm"
        >
          Remover
        </button>
      </div>

      <select
        className="input text-sm"
        value={media.mediaType}
        onChange={(e) =>
          onUpdate(idx, {
            mediaType: e.target.value as ProductMedia['mediaType'],
            url: '',
          })
        }
      >
        {MEDIA_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      <div className="flex gap-2 items-center">
        <input
          className="flex-1 input text-sm"
          placeholder="URL pública da mídia"
          value={media.url}
          onChange={(e) => onUpdate(idx, { url: e.target.value })}
        />

        <button
          type="button"
          title="Enviar arquivo do computador"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {uploading ? (
            <span className="animate-spin">⏳</span>
          ) : (
            <>
              📁 <span className="hidden sm:inline">Upload</span>
            </>
          )}
        </button>

        {media.url && (
          <button
            type="button"
            title="Limpar"
            onClick={() => onUpdate(idx, { url: '' })}
            className="shrink-0 text-gray-400 hover:text-red-500 text-lg leading-none px-1"
          >
            ×
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_BY_TYPE[media.mediaType]}
        className="hidden"
        onChange={handleFileChange}
      />

      {isImage && (
        <img
          src={media.url}
          alt="preview"
          className="w-full max-h-32 object-contain rounded-lg bg-gray-50"
        />
      )}

      <input
        className="input text-sm"
        placeholder="Legenda (opcional)"
        value={media.caption ?? ''}
        onChange={(e) => onUpdate(idx, { caption: e.target.value })}
      />
    </div>
  );
}

export default function ProductsClient() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'product' | 'medias'>('product');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState<DeliveryItem[]>([newItem()]);
  const [medias, setMedias] = useState<ProductMedia[]>([]);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const usesItemList = ['ACCOUNT', 'LINK', 'TEXT'].includes(form.deliveryType);

  const loadProducts = () => {
    setLoading(true);
    getProducts()
      .then(setProducts)
      .catch(() => toast('Erro ao carregar produtos', 'error'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase());

      const matchFilter =
        filter === 'all' ? true : filter === 'active' ? p.isActive : !p.isActive;

      return matchSearch && matchFilter;
    });
  }, [products, search, filter]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setItems([newItem()]);
    setMedias([]);
    setEditId(null);
    setFieldError('');
    setActiveTab('product');
    setShowModal(true);
  }

  function openEdit(p: Product) {
    const f = {
      name: p.name,
      description: p.description,
      price: String(p.price),
      deliveryType: p.deliveryType,
      deliveryContent: p.deliveryContent || '',
      isActive: p.isActive,
      stock: p.stock != null ? String(p.stock) : '',
    };

    setForm(f);
    setItems(
      ['ACCOUNT', 'LINK', 'TEXT'].includes(p.deliveryType)
        ? contentToItems(p.deliveryContent || '[]')
        : [newItem()]
    );
    setEditId(p.id);
    setFieldError('');
    setActiveTab('product');
    setShowModal(true);

    getProductMedias(p.id)
      .then(setMedias)
      .catch(() => setMedias([]));
  }

  function addItem() {
    setItems((prev) => [...prev, newItem()]);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function updateItemValue(id: string, value: string) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, value } : i)));
  }

  function addMedia() {
    setMedias((prev) => [...prev, newMedia()]);
  }

  function removeMedia(idx: number) {
    setMedias((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateMedia(idx: number, patch: Partial<ProductMedia>) {
    setMedias((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }

  async function handleSave() {
    const err = validate(form, items);
    if (err) {
      setFieldError(err);
      setActiveTab('product');
      return;
    }

    setSaving(true);
    setFieldError('');

    try {
      const deliveryContent = usesItemList ? itemsToContent(items) : form.deliveryContent;
      const fifoCount = usesItemList ? items.filter((i) => i.value.trim()).length : null;

      const payload = {
        ...form,
        deliveryContent,
        price: parseFloat(form.price),
        stock: usesItemList ? fifoCount : form.stock ? parseInt(form.stock) : null,
      };

      let savedId = editId;

      if (editId) {
        await updateProduct(editId, payload);
        toast('Produto atualizado com sucesso!', 'success');
      } else {
        const created = await createProduct(payload);
        savedId = created?.id ?? null;
        toast('Produto criado com sucesso!', 'success');
      }

      if (savedId) {
  const validMedias = medias.filter((m) => m.url.trim());

  await updateProductMedias(savedId, validMedias, {
    name: payload.name,
    description: payload.description,
    price: Number(payload.price),
    deliveryType: payload.deliveryType,
    deliveryContent: payload.deliveryContent,
    isActive: payload.isActive,
    stock: payload.stock,
    metadata: {},
  }).catch(() =>
    toast('Produto salvo, mas erro ao salvar mídias extras.', 'error')
  );
}

      setShowModal(false);
      loadProducts();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setFieldError(msg || 'Erro ao salvar produto. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;

    try {
      await deleteProduct(confirmDelete);
      toast('Produto desativado.', 'info');
      loadProducts();
    } catch {
      toast('Erro ao desativar produto.', 'error');
    } finally {
      setConfirmDelete(null);
    }
  }

  const filePlaceholder = 'URL pública ou file_id do Telegram (foto, vídeo ou doc)';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Produtos</h1>
          <p className="text-gray-500 text-sm mt-1">
            {filtered.length} de {products.length} produto{products.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">
          + Novo Produto
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <input
          className="input flex-1"
          placeholder="Buscar por nome ou descrição..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="flex gap-2">
          {(['all', 'active', 'inactive'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={[
                'px-3 py-2 rounded-lg text-sm font-medium transition-colors border',
                filter === f
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300',
              ].join(' ')}
            >
              {f === 'all' ? 'Todos' : f === 'active' ? 'Ativos' : 'Inativos'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card space-y-3 animate-pulse">
              <div className="h-5 bg-gray-200 rounded w-2/3" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="h-3 bg-gray-100 rounded w-4/5" />
              <div className="h-8 bg-gray-200 rounded w-1/3 mt-2" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📦</div>
          <p className="font-medium text-gray-500">Nenhum produto encontrado</p>
          <p className="text-sm mt-1">
            {search
              ? 'Tente outros termos de busca'
              : 'Crie seu primeiro produto clicando em "+ Novo Produto"'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => {
            let itemCount: number | null = null;

            try {
              const parsed = JSON.parse(p.deliveryContent || '');
              if (Array.isArray(parsed)) itemCount = parsed.length;
            } catch {}

            return (
              <div
                key={p.id}
                className={['card relative', !p.isActive ? 'opacity-60' : ''].join(' ')}
              >
                <div className="flex items-start justify-between mb-1">
                  <h3 className="font-semibold text-gray-900 pr-4 leading-snug">{p.name}</h3>
                  <span
                    className={[
                      'shrink-0 text-xs px-2 py-0.5 rounded-full font-medium',
                      p.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500',
                    ].join(' ')}
                  >
                    {p.isActive ? 'Ativo' : 'Inativo'}
                  </span>
                </div>

                <p className="text-sm text-gray-500 mb-3 line-clamp-2">{p.description}</p>

                <div className="text-2xl font-bold text-blue-600 mb-3">
                  {formatCurrency(p.price)}
                </div>

                <div className="flex items-center gap-2 text-xs text-gray-500 mb-4 flex-wrap">
                  <span className="bg-gray-100 px-2 py-1 rounded">{p.deliveryType}</span>

                  {itemCount !== null && (
                    <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded">
                      {itemCount} item{itemCount !== 1 ? 's' : ''} na fila
                    </span>
                  )}

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
                  <button onClick={() => openEdit(p)} className="btn-secondary text-sm flex-1">
                    Editar
                  </button>
                  <button
                    onClick={() => setConfirmDelete(p.id)}
                    className="btn-danger text-sm px-3"
                    title="Desativar produto"
                  >
                    🗑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 pt-6 pb-0">
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                {editId ? 'Editar Produto' : 'Novo Produto'}
              </h2>

              <div className="flex gap-1 border-b border-gray-200">
                {([
                  { key: 'product', label: '📦 Produto' },
                  {
                    key: 'medias',
                    label: `🎬 Mídias Extras${
                      medias.filter((m) => m.url.trim()).length > 0
                        ? ` (${medias.filter((m) => m.url.trim()).length})`
                        : ''
                    }`,
                  },
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={[
                      'px-4 py-2 text-sm font-medium rounded-t-lg transition-colors',
                      activeTab === tab.key
                        ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-600'
                        : 'text-gray-500 hover:text-gray-700',
                    ].join(' ')}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-6">
              {activeTab === 'product' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nome *</label>
                    <input
                      className="input"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="Ex: Plano Pro"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Descrição *
                    </label>
                    <textarea
                      className="input"
                      rows={2}
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="Descrição exibida no bot"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Preço (R$) *
                      </label>
                      <input
                        className="input"
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={form.price}
                        onChange={(e) => setForm({ ...form, price: e.target.value })}
                        placeholder="29.90"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Estoque
                      </label>

                      {usesItemList ? (
                        <div className="input bg-gray-50 text-gray-400 cursor-not-allowed select-none">
                          Auto ({items.filter((i) => i.value.trim()).length} itens)
                        </div>
                      ) : (
                        <input
                          className="input"
                          type="number"
                          min="0"
                          value={form.stock}
                          onChange={(e) => setForm({ ...form, stock: e.target.value })}
                          placeholder="Vazio = ilimitado"
                        />
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Tipo de Entrega *
                    </label>
                    <select
                      className="input"
                      value={form.deliveryType}
                      onChange={(e) => {
                        setForm({ ...form, deliveryType: e.target.value, deliveryContent: '' });
                        setItems([newItem()]);
                      }}
                    >
                      {DELIVERY_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {usesItemList && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm font-medium text-gray-700">
                          {form.deliveryType === 'ACCOUNT'
                            ? 'Contas / Dados JSON *'
                            : form.deliveryType === 'LINK'
                            ? 'Links de acesso *'
                            : 'Mensagens de entrega *'}
                        </label>

                        <button
                          type="button"
                          onClick={addItem}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                        >
                          + Adicionar item
                        </button>
                      </div>

                      <div className="space-y-2">
                        {items.map((item, idx) => (
                          <div key={item.id} className="flex gap-2 items-start">
                            <span className="text-xs text-gray-400 mt-2.5 w-5 text-right shrink-0">
                              {idx + 1}.
                            </span>

                            <textarea
                              className="input flex-1 font-mono text-xs"
                              rows={form.deliveryType === 'ACCOUNT' ? 2 : 1}
                              value={item.value}
                              onChange={(e) => updateItemValue(item.id, e.target.value)}
                              placeholder={
                                form.deliveryType === 'ACCOUNT'
                                  ? '{"login": "user", "senha": "123", "url": "https://..."}'
                                  : form.deliveryType === 'LINK'
                                  ? 'https://...'
                                  : 'Conteúdo enviado ao comprador'
                              }
                            />

                            {items.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeItem(item.id)}
                                className="text-red-400 hover:text-red-600 mt-2 shrink-0 text-lg leading-none"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                      </div>

                      {form.deliveryType === 'ACCOUNT' && (
                        <p className="text-xs text-gray-400 mt-1">
                          Cada item deve ser um JSON válido.
                        </p>
                      )}

                      <p className="text-xs text-gray-400 mt-1">
                        🔢 Fila FIFO — o bot entrega o item #1 para a 1ª compra, o #2 para a 2ª, e
                        assim por diante. O estoque é ajustado automaticamente.
                      </p>
                    </div>
                  )}

                  {form.deliveryType === 'FILE_MEDIA' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        URL / file_id da mídia *
                      </label>
                      <input
                        className="input"
                        value={form.deliveryContent}
                        onChange={(e) => setForm({ ...form, deliveryContent: e.target.value })}
                        placeholder={filePlaceholder}
                      />
                      <p className="text-xs text-gray-400 mt-1">
                        Cole uma URL pública (imagem/vídeo) ou um file_id do Telegram.
                      </p>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="isActive"
                      checked={form.isActive}
                      onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                      className="rounded"
                    />
                    <label htmlFor="isActive" className="text-sm font-medium text-gray-700">
                      Produto ativo
                    </label>
                  </div>
                </div>
              )}

              {activeTab === 'medias' && (
                <div className="space-y-4">
                  <p className="text-sm text-gray-500">
                    Mídias enviadas ao comprador logo após a entrega principal (fotos, vídeos,
                    arquivos extras).
                  </p>

                  {medias.length === 0 ? (
                    <div className="text-center py-8 text-gray-400">
                      <div className="text-3xl mb-2">🎬</div>
                      <p className="text-sm">Nenhuma mídia extra cadastrada</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {medias.map((media, idx) => (
                        <MediaRow
                          key={idx}
                          media={media}
                          idx={idx}
                          onUpdate={updateMedia}
                          onRemove={removeMedia}
                        />
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={addMedia}
                    className="w-full border-2 border-dashed border-gray-200 hover:border-blue-400 text-gray-400 hover:text-blue-500 rounded-xl py-3 text-sm font-medium transition-colors"
                  >
                    + Adicionar mídia
                  </button>
                </div>
              )}

              {fieldError && (
                <div className="mt-4 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-start gap-2">
                  <span>⚠️</span>
                  <span>{fieldError}</span>
                </div>
              )}

              <div className="flex gap-3 mt-6">
                <button onClick={() => setShowModal(false)} className="btn-secondary flex-1">
                  Cancelar
                </button>
                <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">
                  {saving ? 'Salvando...' : editId ? 'Salvar Alterações' : 'Criar Produto'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!confirmDelete}
        title="Desativar produto?"
        message="O produto não aparecerá mais no bot. Você pode reativá-lo a qualquer momento editando-o."
        confirmLabel="Desativar"
        cancelLabel="Cancelar"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
