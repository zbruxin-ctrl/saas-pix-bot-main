// Cliente HTTP para comunicação do bot com a API interna
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import type { CreatePaymentResponse, ProductDTO, ApiResponse } from '@saas-pix/shared';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.API_URL,
      headers: {
        'Content-Type': 'application/json',
        // Token secreto para autenticar requisições do bot na API
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

  // Lista todos os produtos ativos
  async getProducts(): Promise<ProductDTO[]> {
    const { data } = await this.client.get<ApiResponse<ProductDTO[]>>('/api/payments/products');
    return data.data!;
  }

  // Cria um pagamento PIX
  async createPayment(params: {
    telegramId: string;
    productId: string;
    firstName?: string;
    username?: string;
  }): Promise<CreatePaymentResponse> {
    const { data } = await this.client.post<ApiResponse<CreatePaymentResponse>>(
      '/api/payments/create',
      params
    );
    return data.data!;
  }

  // Verifica status de um pagamento
  async getPaymentStatus(paymentId: string): Promise<{ status: string; paymentId: string }> {
    const { data } = await this.client.get<ApiResponse<{ status: string; paymentId: string }>>(
      `/api/payments/${paymentId}/status`
    );
    return data.data!;
  }
}

export const apiClient = new ApiClient();
