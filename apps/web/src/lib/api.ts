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
  const res = await axios.post('/api/auth/login', { email, password }, { withCredentials: true });
  return res.data?.data ?? res.data;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export async function getDashboard() {
  const res = await api.get('/admin/dashboard');
  // A API envolve em { success: true, data: {...} }
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

export async function getPayments(params?: Record<string, string | number>) {
  const res = await api.get('/admin/payments', { params });
  return res.data?.data ?? res.data;
}

export async function getPayment(id: string) {
  const res = await api.get(`/admin/payments/${id}`);
  return res.data?.data ?? res.data;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function getUsers(params?: Record<string, string | number>) {
  const res = await api.get('/admin/users', { params });
  return res.data?.data ?? res.data;
}

// ─── Me (perfil do admin logado) ─────────────────────────────────────────────

export async function getMe() {
  const res = await api.get('/admin/me');
  return res.data?.data ?? res.data;
}
