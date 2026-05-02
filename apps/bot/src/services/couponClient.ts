// couponClient.ts — client do bot para cupons
import axios from 'axios';

const API_URL = process.env.API_URL!;
const BOT_SECRET = process.env.BOT_SECRET!;

// Mensagens de erro de negócio que podem ser exibidas ao usuário diretamente
const BUSINESS_ERROR_PATTERNS = [
  'expirado',
  'expirada',
  'inválido',
  'inválida',
  'não encontrado',
  'já utilizado',
  'limite',
  'mínimo',
  'produto',
  'usuário',
];

function isSafeErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return BUSINESS_ERROR_PATTERNS.some((p) => lower.includes(p));
}

export interface CouponValidationData {
  couponId: string;
  discountType: 'PERCENT' | 'FIXED';
  discountValue: number;
  discountAmount: number;
  finalAmount: number;
}

export async function validateCoupon(
  code: string,
  telegramId: string,
  orderAmount: number,
  productId?: string
): Promise<{ valid: boolean; error?: string; data?: CouponValidationData }> {
  try {
    const { data } = await axios.post(
      `${API_URL}/api/coupons/validate`,
      { code, telegramId, orderAmount, productId },
      { headers: { 'x-bot-secret': BOT_SECRET } }
    );
    return { valid: true, data: data.data };
  } catch (err: any) {
    const apiMessage: string = err.response?.data?.error ?? '';
    // Só exibe a mensagem da API se for um erro de negócio reconhecível;
    // caso contrário (401, 403, 500, etc.) usa mensagem genérica amigável.
    const userMessage = apiMessage && isSafeErrorMessage(apiMessage)
      ? apiMessage
      : 'Cupom inválido ou expirado.';
    return { valid: false, error: userMessage };
  }
}

export async function applyCoupon(
  couponId: string,
  telegramUserId: string,
  paymentId: string
): Promise<void> {
  await axios.post(
    `${API_URL}/api/coupons/apply`,
    { couponId, telegramUserId, paymentId },
    { headers: { 'x-bot-secret': BOT_SECRET } }
  );
}

export async function revertCoupon(paymentId: string): Promise<void> {
  await axios.post(
    `${API_URL}/api/coupons/revert`,
    { paymentId },
    { headers: { 'x-bot-secret': BOT_SECRET } }
  );
}
