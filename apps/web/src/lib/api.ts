// Cliente de API para o painel admin (Next.js)
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const api = axios.create({
  baseURL: API_URL,
  withCredentials: true, // envia cookies httpOnly automaticamente
});

// Interceptor: redireciona para login se não autorizado
api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ─── Funções de autenticação ──────────────────────────────────────────────

export async function login(email: string, password: string) {
  const { data } = await api.post('/api/auth/login', { email, password });
  return data.data;
}

export async function logout() {
  await api.post('/api/auth/logout');
}

export async function getMe() {
  const { data } = await api.get('/api/auth/me');
  return data.data;
}

// ─── Dashboard ────────────────────────────────────────────────────────────

export async function getDashboard() {
  const { data } = await api.get('/api/admin/dashboard');
  return data.data;
}

// ─── Pagamentos ───────────────────────────────────────────────────────────

export async function getPayments(params?: {
  page?: number;
  perPage?: number;
  status?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}) {
  const { data } = await api.get('/api/admin/payments', { params });
  return data.data;
}

export async function getPayment(id: string) {
  const { data } = await api.get(`/api/admin/payments/${id}`);
  return data.data;
}

// ─── Produtos ─────────────────────────────────────────────────────────────

export async function getProducts() {
  const { data } = await api.get('/api/admin/products');
  return data.data;
}

export async function createProduct(product: Record<string, unknown>) {
  const { data } = await api.post('/api/admin/products', product);
  return data.data;
}

export async function updateProduct(id: string, product: Record<string, unknown>) {
  const { data } = await api.put(`/api/admin/products/${id}`, product);
  return data.data;
}

export async function deleteProduct(id: string) {
  const { data } = await api.delete(`/api/admin/products/${id}`);
  return data;
}

// ─── Usuários ─────────────────────────────────────────────────────────────

export async function getUsers(params?: { page?: number; search?: string }) {
  const { data } = await api.get('/api/admin/users', { params });
  return data.data;
}

export async function getUser(id: string) {
  const { data } = await api.get(`/api/admin/users/${id}`);
  return data.data;
}
