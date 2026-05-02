// Serviço de integração com Mercado Pago
// Documentação: https://www.mercadopago.com.br/developers/pt/reference
// FIX B7: idempotencyKey usa apenas externalReference SEM Date.now()
//   → retries do mesmo pagamento retornam resposta cacheada do MP
//   → evita criar dois PIX distintos para o mesmo pedido
// FIX B8: buildPayerEmail remove hífens do UUID
//   → MP rejeita hífens no local-part do email (erro 4050)
//   → "telegram.{uuid-com-hifens}@..." → "payer{uuidsemhifens}@bot.com.br"

import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../config/env';
import { logger } from '../lib/logger';

interface PixPaymentData {
  transactionAmount: number;
  description: string;
  payerName: string;
  externalReference: string;
  notificationUrl: string;
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

// FIX B8: MP (erro 4050) rejeita hifens no local-part do email.
// UUID tem formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx — removemos os hifens
// antes de montar o email, garantindo apenas caracteres alfanuméricos + ponto.
function buildPayerEmail(externalReference: string): string {
  const sanitized = externalReference.replace(/-/g, '').toLowerCase();
  return `payer.${sanitized}@bot.com.br`;
}

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
    const idempotencyKey = `pix_${data.externalReference}`;

    const requestBody: Record<string, unknown> = {
      transaction_amount: data.transactionAmount,
      description: data.description.substring(0, 255),
      payment_method_id: 'pix',
      payer: {
        email: buildPayerEmail(data.externalReference),
        first_name: (data.payerName.split(' ')[0] || 'Usuario').substring(0, 50),
        last_name: (data.payerName.split(' ').slice(1).join(' ') || 'Telegram').substring(0, 50),
      },
      external_reference: data.externalReference,
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

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

  async cancelPayment(mercadoPagoId: string): Promise<void> {
    try {
      await this.client.put(`/v1/payments/${mercadoPagoId}`, { status: 'cancelled' });
      logger.info(`Pagamento cancelado no MP: ${mercadoPagoId}`);
    } catch (error) {
      const mpError = extractMpError(error);
      logger.warn(`Falha ao cancelar pagamento ${mercadoPagoId} no MP: ${mpError}`);
      throw new Error(`Não foi possível cancelar o pagamento no Mercado Pago: ${mpError}`);
    }
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
