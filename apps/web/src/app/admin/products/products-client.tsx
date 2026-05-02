'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductDTO, DeliveryType, StockItemDTO } from '@saas-pix/shared';
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductMedias,
  updateProductMedias,
  uploadMediaFile,
  getStockItems,
  createStockItem,
  reorderProducts,
  type ProductMedia,
} from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { toast } from '@/components/admin/Toast';
import ConfirmModal from '@/components/admin/ConfirmModal';

// disponiveisCount vem da API via _count.stockItems (AVAILABLE)
interface Product extends ProductDTO {
  deliveryContent?: string | null;
  stockItems?: StockItemDTO[];
  _count?: { payments: number; orders: number };
  disponiveisCount?: number;
}

interface DeliveryItem {
  id: string;
  value: string;
}

type ProductPayload = Partial<ProductDTO> & { deliveryContent?: string };

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
  deliveryType: 'TEXT' as DeliveryType,
  deliveryContent: '',
  confirmationMessage: '',
  isActive: true,
  stock: '',
};

const FIFO_TYPES = ['ACCOUNT', 'LINK', 'TEXT'];

function itemsToContent(items: DeliveryItem[]): string {
  const vals = items.map((i) => i.value.trim()).filter(Boolean);
  return JSON.stringify(vals);
}

function stockItemsToDeliveryItems(stockItems: StockItemDTO[]): DeliveryItem[] {
  if (!stockItems || stockItems.length === 0) return [newItem()];
  return stockItems.map((s) => ({ id: s.id, value: s.content }));
}

function newItem(): DeliveryItem {
  return { id: String(Date.now() + Math.random()), value: '' };
}

function newMedia(): ProductMedia {
  return { url: '', mediaType: 'IMAGE', caption: '' };
}

function validate(form: typeof EMPTY_FORM, items: DeliveryItem[], isEdit: boolean): string | null {
  if (!form.name.trim()) return 'O nome do produto é obrigatório.';
  if (!form.description.trim()) return 'A descrição é obrigatória.';
  const price = parseFloat(form.price);
  if (isNaN(price) || price <= 0) return 'Informe um preço válido maior que zero.';

  const usesItems = FIFO_TYPES.includes(form.deliveryType);
  if (usesItems) {
    const filled = items.filter((i) => i.value.trim());
    // Em edição sem nenhum item novo preenchido: permite salvar sem alterar o estoque
    if (!isEdit && filled.length === 0) return 'Adicione pelo menos um item de entrega.';
    if (form.deliveryType === 'ACCOUNT') {
      for (const item of filled) {
        try { JSON.parse(item.value); } catch {
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
        <button type="button" onClick={() => onRemove(idx)} className="text-red-400 hover:text-red-600 text-sm">Remover</button>
      </div>
      <select
        className="input text-sm"
        value={media.mediaType}
        onChange={(e) => onUpdate(idx, { mediaType: e.target.value as ProductMedia['mediaType'], url: '' })}
      >
        {MEDIA_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
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
          {uploading ? <span className="animate-spin">⏳</span> : <>📁 <span className="hidden sm:inline">Upload</span></>}
        </button>
        {media.url && (
          <button type="button" title="Limpar" onClick={() => onUpdate(idx, { url: '' })} className="shrink-0 text-gray-400 hover:text-red-500 text-lg leading-none px-1">×</button>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept={ACCEPT_BY_TYPE[media.mediaType]} className="hidden" onChange={handleFileChange} />
      {isImage && <img src={media.url} alt="preview" className="w-full max-h-32 object-contain rounded-lg bg-gray-50" />}
      <input
        className="input text-sm"
        placeholder="Legenda (opcional)"
        value={media.caption ?? ''}
        onChange={(e) => onUpdate(idx, { caption: e.target.value })}
      />
    </div>
  );
}

// ─── Drag-and-drop (nativo, sem biblioteca externa) ───────────────────────────

interface SortableCardProps {
  product: Product;
  index: number;
  isDragging: boolean;
  isOver: boolean;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onDragEnd: () => void;
  onEdit: (p: Product) => void;
  onDelete: (id: string) => void;
}

function SortableCard({
  product: p,
  index,
  isDragging,
  isOver,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onEdit,
  onDelete,
}: SortableCardProps) {
  const isFifo = FIFO_TYPES.includes(p.deliveryType);
  // Para FIFO: usa disponiveisCount (vem da API via _count.stockItems AVAILABLE)
  // Para numérico: usa p.stock
  // Nunca mostra os dois ao mesmo tempo
  const fifoCount = isFifo ? (p.disponiveisCount ?? 0) : null;
  const numericStock = !isFifo && p.stock != null ? p.stock : null;

  return (
    <div
      draggable
      onDragStart={() => onDragStart(index)}
      onDragEnter={() => onDragEnter(index)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      className={[
        'card relative transition-all duration-150 cursor-default',
        !p.isActive ? 'opacity-60' : '',
        isDragging ? 'opacity-40 scale-95 shadow-lg ring-2 ring-blue-400' : '',
        isOver && !isDragging ? 'ring-2 ring-blue-300 bg-blue-50/40' : '',
      ].filter(Boolean).join(' ')}
    >
      <div
        className="absolute top-3 right-3 cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 select-none z-10"
        title="Arrastar para reordenar"
        draggable={false}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <rect x="3" y="3" width="2" height="2" rx="1" />
          <rect x="7" y="3" width="2" height="2" rx="1" />
          <rect x="11" y="3" width="2" height="2" rx="1" />
          <rect x="3" y="7" width="2" height="2" rx="1" />
          <rect x="7" y="7" width="2" height="2" rx="1" />
          <rect x="11" y="7" width="2" height="2" rx="1" />
          <rect x="3" y="11" width="2" height="2" rx="1" />
          <rect x="7" y="11" width="2" height="2" rx="1" />
          <rect x="11" y="11" width="2" height="2" rx="1" />
        </svg>
      </div>

      <div className="flex items-start justify-between mb-1 pr-8">
        <h3 className="font-semibold text-gray-900 leading-snug">{p.name}</h3>
        <span className={[
          'shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ml-2',
          p.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500',
        ].join(' ')}>
          {p.isActive ? 'Ativo' : 'Inativo'}
        </span>
      </div>
      <p className="text-sm text-gray-500 mb-3 line-clamp-2">{p.description}</p>
      <div className="text-2xl font-bold text-blue-600 mb-3">{formatCurrency(p.price)}</div>
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-4 flex-wrap">
        <span className="bg-gray-100 px-2 py-1 rounded">{p.deliveryType}</span>
        {fifoCount !== null && (
          <span className={[
            'px-2 py-1 rounded',
            fifoCount > 0 ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-600',
          ].join(' ')}>
            {fifoCount} disponíve{fifoCount !== 1 ? 'is' : 'l'}
          </span>
        )}
        {numericStock !== null && (
          <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">
            {numericStock} em estoque
          </span>
        )}
      </div>
      {p._count && (
        <div className="text-xs text-gray-400 mb-4">
          {p._count.payments} pagamentos · {p._count.orders} pedidos
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={() => onEdit(p)} className="btn-secondary text-sm flex-1">Editar</button>
        <button onClick={() => onDelete(p.id)} className="btn-danger text-sm px-3" title="Desativar produto">🗑</button>
      </div>
    </div>
  );
}

// ─── Modal de importação em lote ──────────────────────────────────────────────

interface BulkImportModalProps {
  deliveryType: string;
  onImport: (lines: string[]) => void;
  onClose: () => void;
}

function BulkImportModal({ deliveryType, onImport, onClose }: BulkImportModalProps) {
  const [text, setText] = useState('');

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const count = lines.length;

  const isAccount = deliveryType === 'ACCOUNT';
  const placeholder = isAccount
    ? '{"email":"conta1@mail.com","senha":"123456"}\n{"email":"conta2@mail.com","senha":"abcdef"}'
    : 'conta1@email.com:senha123\nconta2@email.com:senha456\nhttps://link-de-acesso-1.com';

  const jsonErrors: number[] = [];
  if (isAccount) {
    lines.forEach((line, i) => {
      try { JSON.parse(line); } catch { jsonErrors.push(i + 1); }
    });
  }

  function handleImport() {
    if (count === 0) return;
    if (isAccount && jsonErrors.length > 0) return;
    onImport(lines);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-gray-900">📋 Importar itens em lote</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Cole um item por linha. Linhas vazias são ignoradas automaticamente.
            {isAccount && <> Cada linha deve ser um <strong>JSON válido</strong>.</>}
          </p>
        </div>

        <div className="px-6 py-4 space-y-3">
          <textarea
            className="input font-mono text-xs w-full"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            autoFocus
            spellCheck={false}
          />

          <div className="flex items-center justify-between">
            <span className={`text-xs font-medium ${
              count > 0 ? 'text-green-700' : 'text-gray-400'
            }`}>
              {count > 0 ? `✓ ${count} item${count !== 1 ? 's' : ''} detectado${count !== 1 ? 's' : ''}` : 'Nenhum item ainda'}
            </span>
            {isAccount && jsonErrors.length > 0 && (
              <span className="text-xs text-red-600 font-medium">
                ⚠️ Erro nas linhas: {jsonErrors.slice(0, 5).join(', ')}{jsonErrors.length > 5 ? '...' : ''}
              </span>
            )}
          </div>
        </div>

        <div className="px-6 pb-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary flex-1"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={count === 0 || (isAccount && jsonErrors.length > 0)}
            onClick={handleImport}
            className="btn-primary flex-1 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Importar {count > 0 ? `(${count} ${count !== 1 ? 'itens' : 'item'})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function ProductsClient() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState<DeliveryItem[]>([newItem()]);
  const [medias, setMedias] = useState<ProductMedia[]>([]);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showBulkModal, setShowBulkModal] = useState(false);
  // loadingItems: true enquanto busca stockItems ao abrir edição
  const [loadingItems, setLoadingItems] = useState(false);

  // ── Drag-and-drop state ──────────────────────────────────────────────────────
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);

  const usesItemList = FIFO_TYPES.includes(form.deliveryType);

  const [allProducts, setAllProducts] = useState<Product[]>([]);

  const loadProducts = useCallback(() => {
    setLoading(true);
    getProducts()
      .then((data) => {
        const list = data as Product[];
        setAllProducts(list);
        setProducts(list);
      })
      .catch(() => toast('Erro ao carregar produtos', 'error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase());
      const matchFilter = filter === 'all' ? true : filter === 'active' ? p.isActive : !p.isActive;
      return matchSearch && matchFilter;
    });
  }, [products, search, filter]);

  const isFiltering = search.trim() !== '' || filter !== 'all';

  // ── Handlers drag-and-drop ───────────────────────────────────────────────────
  function handleDragStart(index: number) {
    if (isFiltering) return;
    setDragIndex(index);
  }

  function handleDragEnter(index: number) {
    if (dragIndex === null || dragIndex === index) return;
    setOverIndex(index);
  }

  async function handleDragEnd() {
    if (dragIndex === null || overIndex === null || dragIndex === overIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }

    const reordered = [...products];
    const [moved] = reordered.splice(dragIndex, 1);
    reordered.splice(overIndex, 0, moved);
    setProducts(reordered);
    setAllProducts(reordered);
    setDragIndex(null);
    setOverIndex(null);

    setReordering(true);
    try {
      const payload = reordered.map((p, i) => ({ id: p.id, sortOrder: i }));
      await reorderProducts(payload);
      toast('Ordem atualizada com sucesso!', 'success');
    } catch {
      toast('Erro ao salvar ordem. Recarregando...', 'error');
      loadProducts();
    } finally {
      setReordering(false);
    }
  }

  // ── Formulário ───────────────────────────────────────────────────────────────

  function openCreate() {
    setForm(EMPTY_FORM);
    setItems([newItem()]);
    setMedias([]);
    setEditId(null);
    setFieldError('');
    setShowModal(true);
  }

  async function openEdit(p: Product) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    setForm({
      name: p.name,
      description: p.description,
      price: String(p.price),
      deliveryType: p.deliveryType,
      // Não expõe __FIFO__ no campo — o conteúdo real vem dos stockItems
      deliveryContent: p.deliveryContent === '__FIFO__' ? '' : (p.deliveryContent ?? ''),
      confirmationMessage: (meta.confirmationMessage as string) ?? '',
      isActive: p.isActive,
      stock: p.stock != null ? String(p.stock) : '',
    });
    setEditId(p.id);
    setFieldError('');
    setShowModal(true);

    if (FIFO_TYPES.includes(p.deliveryType)) {
      // Sempre busca os stockItems frescos da API ao abrir edição
      setLoadingItems(true);
      setItems([newItem()]); // placeholder enquanto carrega
      getStockItems(p.id)
        .then((si) => setItems(stockItemsToDeliveryItems(si)))
        .catch(() => {
          setItems([newItem()]);
          toast('Erro ao carregar itens de estoque', 'error');
        })
        .finally(() => setLoadingItems(false));
    } else {
      setItems([newItem()]);
    }

    getProductMedias(p.id)
      .then(setMedias)
      .catch(() => setMedias([]));
  }

  function addItem() { setItems((prev) => [...prev, newItem()]); }
  function removeItem(id: string) { setItems((prev) => prev.filter((i) => i.id !== id)); }
  function updateItemValue(id: string, value: string) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, value } : i)));
  }

  // ── Importação em lote ───────────────────────────────────────────────────────
  function handleBulkImport(lines: string[]) {
    const existingFilled = items.filter((i) => i.value.trim());
    const newItems: DeliveryItem[] = lines.map((line) => ({
      id: String(Date.now() + Math.random()),
      value: line,
    }));
    const merged = [...existingFilled, ...newItems];
    setItems(merged.length > 0 ? merged : [newItem()]);
    toast(`✓ ${lines.length} item${lines.length !== 1 ? 's' : ''} importado${lines.length !== 1 ? 's' : ''} com sucesso!`, 'success');
  }

  function addMedia() { setMedias((prev) => [...prev, newMedia()]); }
  function removeMedia(idx: number) { setMedias((prev) => prev.filter((_, i) => i !== idx)); }
  function updateMedia(idx: number, patch: Partial<ProductMedia>) {
    setMedias((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }

  async function handleSave() {
    const isEdit = !!editId;
    const err = validate(form, items, isEdit);
    if (err) { setFieldError(err); return; }

    setSaving(true);
    setFieldError('');

    try {
      const isFifo = FIFO_TYPES.includes(form.deliveryType);
      const filledItems = items.filter((i) => i.value.trim());
      const deliveryContent = isFifo ? itemsToContent(items) : form.deliveryContent;

      // stock:
      // - FIFO + criação: passa filledItems.length para refletir o que foi enviado
      // - FIFO + edição sem novos itens: não sobrescreve (backend mantém pelo syncFifoItems)
      // - Numérico: usa o campo do form
      // - FILE_MEDIA/outros: null = ilimitado
      let stockValue: number | null;
      if (isFifo) {
        stockValue = filledItems.length > 0 ? filledItems.length : null;
      } else {
        stockValue = form.stock ? parseInt(form.stock, 10) : null;
      }

      const existingMeta = (allProducts.find((p) => p.id === editId)?.metadata ?? {}) as Record<string, unknown>;
      const newMetadata = {
        ...existingMeta,
        confirmationMessage: form.confirmationMessage.trim() || undefined,
      };

      const payload: ProductPayload = {
        name: form.name,
        description: form.description,
        price: parseFloat(form.price),
        deliveryType: form.deliveryType,
        isActive: form.isActive,
        stock: stockValue,
        deliveryContent,
        metadata: newMetadata,
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
        await updateProductMedias(savedId, validMedias).catch(() =>
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Produtos</h1>
          <p className="text-gray-500 text-sm mt-1">
            {filtered.length} de {products.length} produto{products.length !== 1 ? 's' : ''}
            {reordering && <span className="ml-2 text-blue-500 animate-pulse">· Salvando ordem...</span>}
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary">+ Novo Produto</button>
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

      {isFiltering && !loading && products.length > 0 && (
        <p className="text-xs text-gray-400 text-center">
          ⚠️ Reordenação desativada durante busca/filtro. Limpe os filtros para arrastar.
        </p>
      )}

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
            {search ? 'Tente outros termos de busca' : 'Crie seu primeiro produto clicando em "+ Novo Produto"'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p, index) => (
            <SortableCard
              key={p.id}
              product={p}
              index={index}
              isDragging={dragIndex === index}
              isOver={overIndex === index}
              onDragStart={handleDragStart}
              onDragEnter={handleDragEnter}
              onDragEnd={handleDragEnd}
              onEdit={openEdit}
              onDelete={(id) => setConfirmDelete(id)}
            />
          ))}
        </div>
      )}

      {/* Modal de criação/edição */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 pt-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                {editId ? 'Editar Produto' : 'Novo Produto'}
              </h2>
            </div>

            <div className="px-6 pb-6 space-y-4">

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
                  <input className="input" type="number" step="0.01" min="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="29.90" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Estoque</label>
                  {usesItemList ? (
                    <div className="input bg-gray-50 text-gray-400 cursor-not-allowed select-none">
                      Auto ({items.filter((i) => i.value.trim()).length} disponíveis)
                    </div>
                  ) : (
                    <input className="input" type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} placeholder="Vazio = ilimitado" />
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Entrega *</label>
                <select
                  className="input"
                  value={form.deliveryType}
                  onChange={(e) => {
                    setForm({ ...form, deliveryType: e.target.value as DeliveryType, deliveryContent: '' });
                    setItems([newItem()]);
                  }}
                >
                  {DELIVERY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              {/* Itens FIFO (TEXT / LINK / ACCOUNT) */}
              {usesItemList && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-gray-700">
                      Itens de entrega
                      <span className="ml-2 text-xs text-gray-400 font-normal">
                        ({items.filter((i) => i.value.trim()).length} preenchido{items.filter((i) => i.value.trim()).length !== 1 ? 's' : ''})
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowBulkModal(true)}
                      className="flex items-center gap-1 text-xs font-medium text-purple-600 hover:text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 px-2.5 py-1 rounded-lg transition-colors"
                      title="Importar vários itens de uma vez via texto"
                    >
                      📋 Importar em lote
                    </button>
                  </div>

                  {loadingItems ? (
                    <div className="flex items-center gap-2 text-sm text-gray-400 py-3">
                      <span className="animate-spin">⏳</span> Carregando itens de estoque...
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {items.map((item) => (
                        <div key={item.id} className="flex gap-2 items-center">
                          <input
                            className="input flex-1 text-sm font-mono"
                            value={item.value}
                            onChange={(e) => updateItemValue(item.id, e.target.value)}
                            placeholder={
                              form.deliveryType === 'ACCOUNT'
                                ? '{"email":"x@x.com","senha":"123"}'
                                : form.deliveryType === 'LINK'
                                ? 'https://...'
                                : 'Conteúdo do item'
                            }
                          />
                          <button
                            type="button"
                            onClick={() => removeItem(item.id)}
                            className="shrink-0 text-gray-300 hover:text-red-500 text-lg leading-none px-1 transition-colors"
                            title="Remover item"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={addItem}
                    className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    + Adicionar item
                  </button>
                </div>
              )}

              {/* Conteúdo para FILE_MEDIA */}
              {form.deliveryType === 'FILE_MEDIA' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">URL / File ID da mídia *</label>
                  <input
                    className="input"
                    value={form.deliveryContent}
                    onChange={(e) => setForm({ ...form, deliveryContent: e.target.value })}
                    placeholder="https://... ou file_id do Telegram"
                  />
                </div>
              )}

              {/* Mídias extras */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">Mídias extras (opcional)</label>
                  <button type="button" onClick={addMedia} className="text-sm text-blue-600 hover:text-blue-700 font-medium">+ Adicionar mídia</button>
                </div>
                {medias.map((media, idx) => (
                  <MediaRow key={idx} media={media} idx={idx} onUpdate={updateMedia} onRemove={removeMedia} />
                ))}
              </div>

              {/* Mensagem de confirmação */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mensagem de confirmação (opcional)</label>
                <textarea
                  className="input"
                  rows={2}
                  value={form.confirmationMessage}
                  onChange={(e) => setForm({ ...form, confirmationMessage: e.target.value })}
                  placeholder="Mensagem enviada ao usuário após a compra (deixe vazio para usar o padrão)"
                />
              </div>

              {/* Status ativo */}
              <div className="flex items-center gap-3">
                <input
                  id="isActive"
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="w-4 h-4 accent-blue-600"
                />
                <label htmlFor="isActive" className="text-sm font-medium text-gray-700">Produto ativo (visível no bot)</label>
              </div>

              {fieldError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
                  {fieldError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary flex-1" disabled={saving}>Cancelar</button>
                <button type="button" onClick={handleSave} className="btn-primary flex-1" disabled={saving || loadingItems}>
                  {saving ? 'Salvando...' : editId ? 'Salvar alterações' : 'Criar produto'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de importação em lote */}
      {showBulkModal && (
        <BulkImportModal
          deliveryType={form.deliveryType}
          onImport={handleBulkImport}
          onClose={() => setShowBulkModal(false)}
        />
      )}

      <ConfirmModal
        open={!!confirmDelete}
        title="Desativar produto"
        message="Tem certeza que deseja desativar este produto? Ele não será mais exibido no bot."
        confirmLabel="Desativar"
        danger
        onConfirm={() => { void handleConfirmDelete(); }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
