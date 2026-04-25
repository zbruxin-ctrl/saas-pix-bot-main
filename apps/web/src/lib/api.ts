// apps/web/src/lib/api.ts
import axios from 'axios';

const api = axios.create({
  baseURL: '/api/proxy',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      document.cookie = 'auth_presence=; Max-Age=0; path=/';
      if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

// ─── Auth ────────────────────────────────────────────────────────────────────

export async function login(email: string, password: string) {
  const res = await api.post('/auth/login', { email, password });
  return res.data;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export async function getDashboard() {
  const res = await api.get('/admin/dashboard');
  return res.data?.data ?? res.data;
}

// ─── Products ────────────────────────────────────────────────────────────────

export async function getProducts() {
  const res = await api.get('/admin/products');
  return res.data?.data ?? res.data;
}

export async function createProduct(data: Record<string, unknown>) {
  const res = await api.post('/admin/products', data);
  return res.data?.data ?? res.data;
}

export async function updateProduct(id: string, data: Record<string, unknown>) {
  const res = await api.put(`/admin/products/${id}`, data);
  return res.data?.data ?? res.data;
}

export async function deleteProduct(id: string) {
  const res = await api.delete(`/admin/products/${id}`);
  return res.data?.data ?? res.data;
}

// ─── Payments ────────────────────────────────────────────────────────────────

export async function getPayments(params?: Record<string, string | number | undefined>) {
  const res = await api.get('/admin/payments', { params });
  return res.data?.data ?? res.data;
}

export async function getPayment(id: string) {
  const res = await api.get(`/admin/payments/${id}`);
  return res.data?.data ?? res.data;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function getUsers(params?: Record<string, string | number | undefined>) {
  const res = await api.get('/admin/users', { params });
  return res.data?.data ?? res.data;
}

// ─── Me (perfil do admin logado) ─────────────────────────────────────────────

export async function getMe() {
  const res = await api.get('/admin/me');
  return res.data?.data ?? res.data;
}

// ─── Product Medias ──────────────────────────────────────────────────────────

export type ProductMedia = {
  url: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'FILE';
  caption?: string;
};

export async function getProductMedias(id: string): Promise<ProductMedia[]> {
  try {
    const res = await api.get(`/admin/products/${id}`);
    const product = res.data?.data ?? res.data;
    const meta = product?.metadata as Record<string, unknown> | null;
    return Array.isArray(meta?.medias) ? (meta.medias as ProductMedia[]) : [];
  } catch {
    return [];
  }
}

export async function updateProductMedias(
  id: string,
  medias: ProductMedia[],
  baseProduct: {
    name: string;
    description: string;
    price: number;
    deliveryType: string;
    deliveryContent: string;
    isActive: boolean;
    stock: number | null;
    metadata?: Record<string, unknown> | null;
  }
) {
  const currentMeta = (baseProduct.metadata as Record<string, unknown> | null) ?? {};

  const res = await api.put(`/admin/products/${id}`, {
    name: baseProduct.name,
    description: baseProduct.description,
    price: Number(baseProduct.price),
    deliveryType: baseProduct.deliveryType,
    deliveryContent: baseProduct.deliveryContent,
    isActive: baseProduct.isActive,
    stock: baseProduct.stock ?? null,
    metadata: { ...currentMeta, medias },
  });

  return res.data?.data ?? res.data;
}
// ─── Upload para storage (Cloudinary via rota do Next) ──────────────────────

export async function uploadMediaFile(
  file: File,
  mediaType: 'IMAGE' | 'VIDEO' | 'FILE'
): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  form.append('mediaType', mediaType);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: form,
  });

  const rawText = await res.text();

  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(rawText || 'Resposta inválida do servidor de upload');
  }

  if (!res.ok) {
    throw new Error(data?.error || 'Erro ao fazer upload do arquivo');
  }

  if (!data?.url) {
    throw new Error('Upload concluído sem URL retornada');
  }

  return data.url as string;
}

  return data.url as string;
}
