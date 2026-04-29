// Cliente HTTP para comunicação do bot com a API interna
// PERF #1: timeout reduzido para 8s (era 15s) — feedback mais rápido ao usuário
// PERF #2: cache global de produtos TTL 5min (era 60s) — reduz hits na API
// PERF #4: retry automático 1x em timeout/network error
// PERF #5: cache de saldo por usuário TTL 15s — evita 2 roundtrips na tela de seleção de produto
// PERF #6: invalidação do cache de saldo após depósito
// FEATURE: getOrders(telegramId) — histórico de pedidos para /meus_pedidos
import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../config/env';
import type {
  CreatePaymentResponse,
  CreateDepositResponse,
  WalletBalanceResponse,
  ProductDTO,
  ApiResponse,
  PaymentMethod,
} from '@saas-pix/shared';

// PERF #2: cache global de produtos (TTL 5min — produtos raramente mudam)
interface ProductCache {
  products: ProductDTO[];
  expiresAt: number;
}
let productCache: ProductCache | null = null;
const PRODUCT_CACHE_TTL = 5 * 60_000; // 5 minutos

export function invalidateProductCache(): void {
  productCache = null;
}

// PERF #5: cache de saldo por usuário (TTL 15s — evita dupla chamada na tela de seleção)
interface BalanceCache {
  data: WalletBalanceResponse;
  expiresAt: number;
}
const balanceCache = new Map<string, BalanceCache>();
const BALANCE_CACHE_TTL = 15_000; // 15 segundos

export function invalidateBalanceCache(telegramId: string): void {
  balanceCache.delete(telegramId);
}

export interface OrderSummary {
  id: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
  productName: string;
  amount: number | null;
}

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.API_URL,
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret': env.TELEGRAM_BOT_SECRET,
      },
      timeout: 8000,
    });

    this.client.interceptors.response.use(
      (r) => r,
      (error) => {
        const msg = error.response?.data?.error || error.message;
        throw new Error(msg);
      }
    );
  }

  // PERF #4: retry automático 1x em caso de timeout ou network error
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const isRetryable =
        msg.toLowerCase().includes('timeout') ||
        msg.toLowerCase().includes('econnreset') ||
        msg.toLowerCase().includes('network error') ||
        (err instanceof AxiosError && !err.response);
      if (isRetryable) {
        await new Promise((r) => setTimeout(r, 300));
        return await fn();
      }
      throw err;
    }
  }

  // PERF #2: cache global com TTL 5min
  async getProducts(): Promise<ProductDTO[]> {
    const now = Date.now();
    if (productCache && productCache.expiresAt > now) {
      return productCache.products;
    }
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<ProductDTO[]>>('/api/payments/products')
    );
    productCache = { products: data.data!, expiresAt: now + PRODUCT_CACHE_TTL };
    return data.data!;
  }

  // PERF #5: cache de saldo por usuário com TTL 15s
  async getBalance(telegramId: string): Promise<WalletBalanceResponse> {
    const now = Date.now();
    const cached = balanceCache.get(telegramId);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<WalletBalanceResponse>>(
        `/api/payments/balance?telegramId=${encodeURIComponent(telegramId)}`
      )
    );
    balanceCache.set(telegramId, { data: data.data!, expiresAt: now + BALANCE_CACHE_TTL });
    return data.data!;
  }

  // Retorna os últimos 20 pedidos do usuário — usado por /meus_pedidos e show_orders
  async getOrders(telegramId: string): Promise<OrderSummary[]> {
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<OrderSummary[]>>(
        `/api/payments/orders?telegramId=${encodeURIComponent(telegramId)}`
      )
    );
    return data.data ?? [];
  }

  async createPayment(params: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
    paymentMethod?: PaymentMethod;
  }): Promise<CreatePaymentResponse> {
    // Invalida cache de saldo após compra (saldo mudou)
    invalidateBalanceCache(params.telegramId);
    const { data } = await this.withRetry(() =>
      this.client.post<ApiResponse<CreatePaymentResponse>>('/api/payments/create', params)
    );
    return data.data!;
  }

  async createDeposit(
    telegramId: string,
    amount: number,
    firstName?: string,
    username?: string
  ): Promise<CreateDepositResponse> {
    // PERF #6: invalida cache de saldo após depósito (saldo será creditado)
    invalidateBalanceCache(telegramId);
    const { data } = await this.withRetry(() =>
      this.client.post<ApiResponse<CreateDepositResponse>>('/api/payments/deposit', {
        telegramId,
        amount,
        firstName,
        username,
      })
    );
    return data.data!;
  }

  async getPaymentStatus(paymentId: string): Promise<{ status: string; paymentId: string }> {
    const { data } = await this.withRetry(() =>
      this.client.get<ApiResponse<{ status: string; paymentId: string }>>(
        `/api/payments/${paymentId}/status`
      )
    );
    return data.data!;
  }

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; message: string }> {
    const { data } = await this.withRetry(() =>
      this.client.post<ApiResponse<{ cancelled: boolean; message: string }>>(
        `/api/payments/${paymentId}/cancel`
      )
    );
    return data.data!;
  }
}

export const apiClient = new ApiClient();
