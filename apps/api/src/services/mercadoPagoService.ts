// Serviço de integração com Mercado Pago
// Documentação: https://www.mercadopago.com.br/developers/pt/reference
// FIX #6: payerEmail removido do DTO externo — construído internamente por buildPayerEmail
//         (domínio .user era rejeitado pelo MP; @pagador.com.br é aceito)

import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../config/env';
import { logger } from '../lib/logger';

interface PixPaymentData {
  transactionAmount: number;
  description: string;
  payerName: string;
  externalReference: string;
  notificationUrl: string;
  // payerEmail removido: construído internamente por buildPayerEmail()
}

interface MercadoPagoPixResponse {
  id: number;
  status: string;
  status_detail: string;
  point_of_interaction: {
    transaction_data: {
      qr_code: string;
      qr_code_base64: string;
      ticket_url: string;
    };
  };
  date_of_expiration: string;
  transaction_amount: number;
  external_reference: string;
}

interface MercadoPagoPaymentDetail {
  id: number;
  status: string;
  status_detail: string;
  transaction_amount: number;
  external_reference: string;
  date_approved: string | null;
  payer: {
    email: string;
    identification: { type: string; number: string };
  };
}

// Verifica se a URL é pública HTTPS (não é localhost)
function isPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return (
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      !host.startsWith('192.168.') &&
      !host.startsWith('10.') &&
      parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

// O MP exige e-mail com domínio válido — .user é rejeitado
// Usa externalReference (paymentId UUID) como identificador único do pagador
function buildPayerEmail(externalReference: string): string {
  return `telegram.${externalReference}@pagador.com.br`;
}

// Extrai a mensagem real do erro do Mercado Pago
function extractMpError(error: unknown): string {
  const axiosError = error as AxiosError<{
    message?: string;
    cause?: Array<{ description?: string; code?: string }>;
    error?: string;
  }>;
  if (axiosError.response?.data) {
    const data = axiosError.response.data;
    if (data.cause && data.cause.length > 0) {
      return data.cause.map((c) => `${c.code}: ${c.description}`).join(', ');
    }
    if (data.message) return data.message;
    if (data.error) return data.error;
    return JSON.stringify(data);
  }
  return (error as Error).message || 'Erro desconhecido';
}

class MercadoPagoService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.mercadopago.com',
      headers: {
        Authorization: `Bearer ${env.MERCADO_PAGO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Interceptor: loga SEMPRE o corpo completo do erro do MP
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        logger.error('Erro Mercado Pago — detalhes:', {
          status: error.response?.status,
          url: error.config?.url,
          responseBody: JSON.stringify(error.response?.data, null, 2),
        });
        throw error;
      }
    );
  }

  async createPixPayment(data: PixPaymentData): Promise<MercadoPagoPixResponse> {
    const idempotencyKey = `pix_${data.externalReference}_${Date.now()}`;

    const requestBody: Record<string, unknown> = {
      transaction_amount: data.transactionAmount,
      description: data.description.substring(0, 255),
      payment_method_id: 'pix',
      payer: {
        // FIX #6: e-mail construído internamente com domínio aceito pelo MP
        email: buildPayerEmail(data.externalReference),
        first_name: (data.payerName.split(' ')[0] || 'Usuario').substring(0, 50),
        last_name: (data.payerName.split(' ').slice(1).join(' ') || 'Telegram').substring(0, 50),
      },
      external_reference: data.externalReference,
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    // Só envia notification_url se for HTTPS público — MP rejeita localhost
    if (isPublicUrl(data.notificationUrl)) {
      requestBody.notification_url = data.notificationUrl;
    } else {
      logger.warn(
        `notification_url ignorada (localhost não é aceito pelo MP): ${data.notificationUrl}`
      );
    }

    try {
      const response = await this.client.post<MercadoPagoPixResponse>(
        '/v1/payments',
        requestBody,
        { headers: { 'X-Idempotency-Key': idempotencyKey } }
      );
      logger.info(`PIX criado: MP_ID=${response.data.id} | ref=${data.externalReference}`);
      return response.data;
    } catch (error: unknown) {
      const mpError = extractMpError(error);
      logger.error(`Falha ao criar PIX: ${mpError}`);
      throw new Error(`Mercado Pago: ${mpError}`);
    }
  }

  async getPaymentById(mercadoPagoId: string): Promise<MercadoPagoPaymentDetail> {
    try {
      const response = await this.client.get<MercadoPagoPaymentDetail>(
        `/v1/payments/${mercadoPagoId}`
      );
      return response.data;
    } catch (error) {
      const mpError = extractMpError(error);
      logger.error(`Falha ao buscar pagamento ${mercadoPagoId}: ${mpError}`);
      throw new Error('Não foi possível verificar o pagamento.');
    }
  }

  async verifyPayment(
    mercadoPagoId: string,
    expectedAmount: number
  ): Promise<{ isApproved: boolean; paymentDetail: MercadoPagoPaymentDetail }> {
    const paymentDetail = await this.getPaymentById(mercadoPagoId);
    const isApproved =
      paymentDetail.status === 'approved' &&
      paymentDetail.status_detail === 'accredited' &&
      Math.abs(paymentDetail.transaction_amount - expectedAmount) < 0.01;
    return { isApproved, paymentDetail };
  }

  async refundPayment(mercadoPagoId: string): Promise<void> {
    try {
      await this.client.post(`/v1/payments/${mercadoPagoId}/refunds`);
      logger.info(`Reembolso emitido: ${mercadoPagoId}`);
    } catch (error) {
      const mpError = extractMpError(error);
      logger.error(`Falha ao reembolsar: ${mpError}`);
      throw new Error('Não foi possível emitir o reembolso.');
    }
  }
}

export const mercadoPagoService = new MercadoPagoService();
