// api.ts — cliente HTTP tipado para o painel admin
import axios, { AxiosResponse } from 'axios';
import type {
  ApiResponse,
  PaginatedResponse,
  PaymentDTO,
  ProductDTO,
  TelegramUserDTO,
  DashboardStats,
  RecentPaymentItem,
  StockItemDTO,
  DeliveryMediaDTO,
} from '@saas-pix/shared';

// ─── Tipo local para mídias de produto (usado em products-client.tsx) ─────────
export interface ProductMedia {
  url: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'FILE';
  caption?: string;
}

const api = axios.create({
  baseURL: '/api/proxy',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      document.cookie = 'auth_presence=; Max-Age=0; path=/';
      if (typeof window !== 'undefined' && !window.location.pathname.includes('login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function data<T>(res: AxiosResponse<ApiResponse<T>>): T {
  return res.data.data as T;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function login(email: string, password: string) {
  const res = await axios.post('/api/auth/login', { email, password }, { withCredentials: true });
  return res.data;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export async function getDashboard(): Promise<{
  stats: DashboardStats;
  recentPayments: RecentPaymentItem[];
}> {
  const res = await api.get<ApiResponse<{ stats: DashboardStats; recentPayments: RecentPaymentItem[] }>>(
    '/admin/dashboard'
  );
  return data(res);
}

// ─── Products ─────────────────────────────────────────────────────────────────

export async function getProducts(): Promise<ProductDTO[]> {
  const res = await api.get<ApiResponse<ProductDTO[]>>('/admin/products');
  return data(res);
}

export async function getProduct(id: string): Promise<ProductDTO> {
  const res = await api.get<ApiResponse<ProductDTO>>(`/admin/products/${id}`);
  return data(res);
}

export async function createProduct(productData: Partial<ProductDTO>): Promise<ProductDTO> {
  const res = await api.post<ApiResponse<ProductDTO>>('/admin/products', productData);
  return data(res);
}

export async function updateProduct(id: string, productData: Partial<ProductDTO>): Promise<ProductDTO> {
  const res = await api.put<ApiResponse<ProductDTO>>(`/admin/products/${id}`, productData);
  return data(res);
}

export async function deleteProduct(id: string): Promise<void> {
  await api.delete(`/admin/products/${id}`);
}

// ─── Product Medias (usado em products-client.tsx) ────────────────────────────

/**
 * Retorna as mídias extras de um produto (rota: GET /admin/products/:id/medias-config).
 * Nota: as mídias de ENTREGA ficam em orders/:orderId/medias.
 * Aqui usamos a rota de config do produto para exibir/editar no painel.
 */
export async function getProductMedias(productId: string): Promise<ProductMedia[]> {
  try {
    const res = await api.get<ApiResponse<ProductMedia[]>>(
      `/admin/products/${productId}/medias-config`
    );
    return res.data.data ?? [];
  } catch {
    // Endpoint ainda não implementado na API → retorna array vazio sem quebrar a UI
    return [];
  }
}

/**
 * Salva (substitui) as mídias extras de um produto junto com o payload do produto.
 * Faz PUT no produto e POST nas mídias em sequência.
 */
export async function updateProductMedias(
  productId: string,
  medias: ProductMedia[],
  productPayload: Partial<ProductDTO>
): Promise<void> {
  // Atualiza os dados do produto
  await api.put(`/admin/products/${productId}`, productPayload);

  // Sincroniza mídias (ignora silenciosamente se a rota ainda não existir)
  try {
    await api.put(`/admin/products/${productId}/medias-config`, { medias });
  } catch {
    // Endpoint ainda não implementado → não bloqueia o fluxo de salvamento
  }
}

/**
 * Faz upload de um arquivo de mídia para o storage e retorna a URL pública.
 * Endpoint esperado: POST /api/proxy/admin/upload com multipart/form-data.
 */
export async function uploadMediaFile(
  file: File,
  mediaType: ProductMedia['mediaType']
): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mediaType', mediaType);

  const res = await api.post<ApiResponse<{ url: string }>>('/admin/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  const url = res.data.data?.url;
  if (!url) throw new Error('Upload falhou: URL não retornada pelo servidor.');
  return url;
}

// ─── Stock Items ──────────────────────────────────────────────────────────────

export async function getStockItems(productId: string): Promise<StockItemDTO[]> {
  const res = await api.get<ApiResponse<StockItemDTO[]>>(`/admin/products/${productId}/stock-items`);
  return data(res);
}

export async function createStockItem(productId: string, content: string): Promise<StockItemDTO> {
  const res = await api.post<ApiResponse<StockItemDTO>>(
    `/admin/products/${productId}/stock-items`,
    { content }
  );
  return data(res);
}

export async function deleteStockItem(itemId: string): Promise<void> {
  await api.delete(`/admin/products/stock-items/${itemId}`);
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export async function getPayments(
  params?: Partial<{
    page: number;
    perPage: number;
    status: string;
    orderStatus: string;
    productId: string;
    startDate: string;
    endDate: string;
    search: string;
  }>
): Promise<ApiResponse<PaginatedResponse<PaymentDTO>>> {
  const res = await api.get('/admin/payments', { params });
  return res.data;
}

export async function getPayment(id: string): Promise<PaymentDTO> {
  const res = await api.get<ApiResponse<PaymentDTO>>(`/admin/payments/${id}`);
  return data(res);
}

// ─── Delivery Medias (por pedido) ─────────────────────────────────────────────

export async function getOrderMedias(orderId: string): Promise<DeliveryMediaDTO[]> {
  const res = await api.get<ApiResponse<DeliveryMediaDTO[]>>(
    `/admin/products/orders/${orderId}/medias`
  );
  return data(res);
}

export async function createOrderMedia(
  orderId: string,
  mediaData: Omit<DeliveryMediaDTO, 'id' | 'orderId' | 'createdAt'>
): Promise<DeliveryMediaDTO> {
  const res = await api.post<ApiResponse<DeliveryMediaDTO>>(
    `/admin/products/orders/${orderId}/medias`,
    mediaData
  );
  return data(res);
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function getUsers(
  params?: Partial<{ page: number; perPage: number; search: string }>
): Promise<ApiResponse<PaginatedResponse<TelegramUserDTO & { totalSpent: number }>>> {
  const res = await api.get('/admin/users', { params });
  return res.data;
}

export async function getUser(id: string) {
  const res = await api.get(`/admin/users/${id}`);
  return res.data;
}

// ─── Me ───────────────────────────────────────────────────────────────────────

export async function getMe() {
  const res = await api.get('/admin/me');
  return res.data;
}
