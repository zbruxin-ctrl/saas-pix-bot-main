// Cliente HTTP para comunicação do bot com a API interna
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import type {
  CreatePaymentResponse,
  CreateDepositResponse,
  WalletBalanceResponse,
  ProductDTO,
  ApiResponse,
  PaymentMethod,
} from '@saas-pix/shared';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.API_URL,
      headers: {
        'Content-Type': 'application/json',
        'x-bot-secret': env.TELEGRAM_BOT_SECRET,
      },
      timeout: 15000,
    });

    this.client.interceptors.response.use(
      (r) => r,
      (error) => {
        const msg = error.response?.data?.error || error.message;
        throw new Error(msg);
      }
    );
  }

  async getProducts(): Promise<ProductDTO[]> {
    const { data } = await this.client.get<ApiResponse<ProductDTO[]>>('/api/payments/products');
    return data.data!;
  }

  async createPayment(params: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
    paymentMethod?: PaymentMethod;
  }): Promise<CreatePaymentResponse> {
    const { data } = await this.client.post<ApiResponse<CreatePaymentResponse>>(
      '/api/payments/create',
      params
    );
    return data.data!;
  }

  async createDeposit(
    telegramId: string,
    amount: number,
    firstName?: string,
    username?: string
  ): Promise<CreateDepositResponse> {
    const { data } = await this.client.post<ApiResponse<CreateDepositResponse>>(
      '/api/payments/deposit',
      { telegramId, amount, firstName, username }
    );
    return data.data!;
  }

  async getBalance(telegramId: string): Promise<WalletBalanceResponse> {
    const { data } = await this.client.get<ApiResponse<WalletBalanceResponse>>(
      `/api/payments/balance?telegramId=${encodeURIComponent(telegramId)}`
    );
    return data.data!;
  }

  async getPaymentStatus(paymentId: string): Promise<{ status: string; paymentId: string }> {
    const { data } = await this.client.get<ApiResponse<{ status: string; paymentId: string }>>(
      `/api/payments/${paymentId}/status`
    );
    return data.data!;
  }

  async cancelPayment(paymentId: string): Promise<{ cancelled: boolean; message: string }> {
    const { data } = await this.client.post<ApiResponse<{ cancelled: boolean; message: string }>>(
      `/api/payments/${paymentId}/cancel`
    );
    return data.data!;
  }
}

export const apiClient = new ApiClient();
