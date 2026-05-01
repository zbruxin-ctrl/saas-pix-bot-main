// Cliente HTTP para comunicacao do bot com a API interna
// PERF #1: timeout reduzido para 8s
// PERF #2: cache global de produtos TTL 30s
// PERF #4: retry automatico 1x em timeout/network error
// PERF #5: cache de saldo por usuario TTL 15s
// PERF #6: invalidacao do cache de saldo apos deposito
// FEATURE: getOrders(telegramId)
// FIX-B17: createPayment distingue erro real de idempotência
// FEAT-MAINT: getBotConfig() busca maintenance_mode + maintenance_message
//   com cache em memória TTL 10s para não bater na API a cada update
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

interface ProductCache {
  products: ProductDTO[];
  expiresAt: number;
}
let productCache: ProductCache | null = null;
const PRODUCT_CACHE_TTL = 30_000;

export function invalidateProductCache(): void {
  productCache = null;
}

interface BalanceCache {
  data: WalletBalanceResponse;
  expiresAt: number;
}
const balanceCache = new Map<string, BalanceCache>();
const BALANCE_CACHE_TTL = 15_000;

export function invalidateBalanceCache(telegramId: string): void {
  balanceCache.delete(telegramId);
}

// FEAT-MAINT: cache do bot-config com TTL 10s
interface BotConfigCache {
  data: { maintenanceMode: boolean; maintenanceMessage: string };
  expiresAt: number;
}
let botConfigCache: BotConfigCache | null = null;
const BOT_CONFIG_CACHE_TTL = 10_000;

export function invalidateBotConfigCache(): void {
  botConfigCache = null;
}

export interface OrderSummary {
  id: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
  productName: string;
  amount: number | null;
  paymentMethod: PaymentMethod | null;
}

class ApiHttpError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ApiHttpError';
  }
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
        const status = error.response?.status ?? 0;
        throw new ApiHttpError(msg, status);
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

  async getBotConfig(): Promise<{ maintenanceMode: boolean; maintenanceMessage: string }> {
    const now = Date.now();
    if (botConfigCache && botConfigCache.expiresAt > now) {
      return botConfigCache.data;
    }
    try {
      const { data } = await this.withRetry(() =>
        this.client.get<ApiResponse<{ maintenanceMode: boolean; maintenanceMessage: string }>>('/api/payments/bot-config')
      );
      const result = data.data ?? { maintenanceMode: false, maintenanceMessage: '' };
      botConfigCache = { data: result, expiresAt: now + BOT_CONFIG_CACHE_TTL };
      return result;
    } catch {
      // Se falhar, assume sem manutenção para não bloquear o bot
      return { maintenanceMode: false, maintenanceMessage: '' };
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
    try {
      const { data } = await this.withRetry(() =>
        this.client.post<ApiResponse<CreatePaymentResponse>>('/api/payments/create', params)
      );
      return data.data!;
    } catch (err) {
      // FIX-B17: fallback idempotente para 400 saldo insuficiente em BALANCE
      if (
        err instanceof ApiHttpError &&
        err.statusCode === 400 &&
        err.message.toLowerCase().includes('saldo insuficiente') &&
        params.paymentMethod === 'BALANCE'
      ) {
        try {
          const orders = await this.getOrders(params.telegramId);
          const sixtySecondsAgo = Date.now() - 60_000;
          const recentByTime = orders.find(
            (o) =>
              (o.status === 'DELIVERED' || o.status === 'PROCESSING') &&
              new Date(o.createdAt).getTime() > sixtySecondsAgo
          );
          if (recentByTime) {
            return {
              paymentId: recentByTime.id,
              pixQrCode: '',
              pixQrCodeText: '',
              amount: Number(recentByTime.amount ?? 0),
              balanceUsed: Number(recentByTime.amount ?? 0),
              expiresAt: new Date().toISOString(),
              productName: recentByTime.productName,
              paidWithBalance: true,
            };
          }
        } catch {
          // fallback falhou, deixa propagar erro original
        }
      }
      throw err;
    }
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
