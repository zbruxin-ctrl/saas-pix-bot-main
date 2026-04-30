// Cliente HTTP para comunicacao do bot com a API interna
// PERF #1: timeout reduzido para 8s (era 15s)
// PERF #2: cache global de produtos TTL 30s (era 5min — reduzido para refletir edições do admin)
// PERF #4: retry automatico 1x em timeout/network error
// PERF #5: cache de saldo por usuario TTL 15s
// PERF #6: invalidacao do cache de saldo apos deposito
// FEATURE: getOrders(telegramId) - historico de pedidos para /meus_pedidos
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

// PERF #2: cache global de produtos
// TTL reduzido de 5min → 30s para que edições feitas no painel admin
// apareçam no bot em no máximo 30s sem precisar reiniciar o serviço.
// A invalidação instantânea (< 1s) é feita via endpoint /internal/cache/invalidate-products
// quando a API notifica o bot após mutações de produto.
interface ProductCache {
  products: ProductDTO[];
  expiresAt: number;
}
let productCache: ProductCache | null = null;
const PRODUCT_CACHE_TTL = 30_000; // 30s — fallback de segurança

export function invalidateProductCache(): void {
  productCache = null;
}

// PERF #5: cache de saldo por usuario (TTL 15s)
interface BalanceCache {
  data: WalletBalanceResponse;
  expiresAt: number;
}
const balanceCache = new Map<string, BalanceCache>();
const BALANCE_CACHE_TTL = 15_000;

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
  /** Metodo de pagamento - adicionado para FIX #2 (exibe valor + metodo em /meus_pedidos) */
  paymentMethod: PaymentMethod | null;
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
