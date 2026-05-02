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

// ─── Tipo local para mídias de produto (usado em products-client.tsx) ─────────────
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

// ─── Helpers ────────────────────────────────────────────────────────────────────

function data<T>(res: AxiosResponse<ApiResponse<T>>): T {
  return res.data.data as T;
}

// ─── Auth ───────────────────────────────────────────────────────────────────────

export async function login(email: string, password: string) {
  const res = await axios.post('/api/auth/login', { email, password }, { withCredentials: true });
  return res.data;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export interface LowStockProduct {
  id: string;
  name: string;
  stock: number | null;
}

export async function getDashboard(): Promise<{
  stats: DashboardStats;
  recentPayments: RecentPaymentItem[];
  lowStockProducts: LowStockProduct[];
}> {
  const res = await api.get<ApiResponse<{ stats: DashboardStats; recentPayments: RecentPaymentItem[]; lowStockProducts: LowStockProduct[] }>>(
    '/admin/dashboard'
  );
  return data(res);
}

export async function getDashboardChart(days = 30): Promise<{ date: string; revenue: number }[]> {
  const res = await api.get<ApiResponse<{ date: string; revenue: number }[]>>(
    `/admin/dashboard/chart?days=${days}`
  );
  return data(res);
}

// ─── Products ─────────────────────────────────────────────────────────────────

export async function getProducts(): Promise<ProductDTO[]> {
  const res = await api.get<ApiResponse<{ data: ProductDTO[]; total: number }>>('/admin/products');
  const payload = res.data.data;
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray((payload as any).data)) return (payload as any).data;
  return [];
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

// ─── Reorder Products ────────────────────────────────────────────────────────────────

export async function reorderProducts(
  items: Array<{ id: string; sortOrder: number }>
): Promise<void> {
  await api.patch('/admin/products/reorder', { items });
}

// ─── Product Medias ────────────────────────────────────────────────────────────────────

export async function getProductMedias(productId: string): Promise<ProductMedia[]> {
  try {
    const res = await api.get<ApiResponse<ProductMedia[]>>(
      `/admin/products/${productId}/medias-config`
    );
    return res.data.data ?? [];
  } catch {
    return [];
  }
}

export async function updateProductMedias(
  productId: string,
  medias: ProductMedia[]
): Promise<void> {
  try {
    await api.put(`/admin/products/${productId}/medias-config`, { medias });
  } catch {}
}

export async function uploadMediaFile(
  file: File,
  mediaType: ProductMedia['mediaType']
): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mediaType', mediaType);

  const res = await api.post<ApiResponse<{ url: string }>>('/admin/products/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  const url = res.data.data?.url;
  if (!url) throw new Error('Upload falhou: URL não retornada pelo servidor.');
  return url;
}

// ─── Stock Items ──────────────────────────────────────────────────────────────────────

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

// ─── Payments ───────────────────────────────────────────────────────────────────

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
    method: string;
  }>
): Promise<ApiResponse<PaginatedResponse<PaymentDTO>>> {
  const res = await api.get('/admin/payments', { params });
  return res.data;
}

export async function getPayment(id: string): Promise<PaymentDTO> {
  const res = await api.get<ApiResponse<PaymentDTO>>(`/admin/payments/${id}`);
  return data(res);
}

export async function reprocessPayment(
  id: string
): Promise<{ success: boolean; message?: string; error?: string; mpStatus?: string; alreadyApproved?: boolean }> {
  const res = await api.post(`/admin/payments/${id}/reprocess`);
  return res.data;
}

// ─── CSV exports ────────────────────────────────────────────────────────────────────

export function getPaymentsExportUrl(params?: {
  status?: string;
  productId?: string;
  startDate?: string;
  endDate?: string;
}): string {
  const base = '/api/proxy/admin/payments/export/csv';
  if (!params) return base;
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.productId) q.set('productId', params.productId);
  if (params.startDate) q.set('startDate', params.startDate);
  if (params.endDate) q.set('endDate', params.endDate);
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

export function getUsersExportUrl(): string {
  return '/api/proxy/admin/users/export/csv';
}

// ─── Users ─────────────────────────────────────────────────────────────────────────

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

export async function toggleBlockUser(id: string): Promise<{ isBlocked: boolean; message: string }> {
  const res = await api.patch(`/admin/users/${id}/block-toggle`);
  return res.data.data;
}

// ─── Wallet ───────────────────────────────────────────────────────────────────────

export async function getWalletBalance(userId: string) {
  const res = await api.get(`/admin/wallet/${userId}/balance`);
  return res.data.data;
}

export async function adjustWalletBalance(
  userId: string,
  amount: number,
  justification: string
) {
  const res = await api.post(`/admin/wallet/${userId}/adjust`, { amount, justification });
  return res.data.data;
}

// ─── Delivery Medias ────────────────────────────────────────────────────────────────────

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

// ─── Me ───────────────────────────────────────────────────────────────────────────

export async function getMe() {
  const res = await api.get('/admin/me');
  return res.data;
}

// ─── Referrals ────────────────────────────────────────────────────────────────

export async function getReferrals(params?: {
  page?: number;
  perPage?: number;
  search?: string;
}): Promise<any> {
  const res = await api.get('/admin/referrals', { params });
  return res.data.data;
}

// ─── Coupons ───────────────────────────────────────────────────────────────────────

export async function getCoupons(params?: { search?: string }): Promise<any[]> {
  const res = await api.get('/admin/coupons', { params });
  return res.data.data ?? [];
}

export async function createCoupon(payload: object): Promise<any> {
  const res = await api.post('/admin/coupons', payload);
  return res.data.data;
}

export async function updateCoupon(id: string, payload: object): Promise<any> {
  const res = await api.patch(`/admin/coupons/${id}`, payload);
  return res.data.data;
}

export async function deleteCoupon(id: string): Promise<void> {
  await api.delete(`/admin/coupons/${id}`);
}
