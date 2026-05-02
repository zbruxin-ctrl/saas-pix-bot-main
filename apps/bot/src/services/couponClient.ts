// couponClient.ts — client do bot para cupons
// FIX #3: usa env validado em vez de process.env direto
import axios from 'axios';
import { env } from '../config/env';

// Mensagens de erro de negócio que podem ser exibidas ao usuário diretamente
const BUSINESS_ERROR_PATTERNS = [
  'expirado',
  'expirada',
  'inválido',
  'inválida',
  'não encontrado',
  'já utilizado',
  'já foi utilizado',
  'limite',
  'mínimo',
  'produto',
  'usuário',
  'uso máximo',
  'cupom',
  'desconto',
  'código',
  'usado',
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
      `${env.API_URL}/api/coupons/validate`,
      { code, telegramId, orderAmount, productId },
      { headers: { 'x-bot-secret': env.TELEGRAM_BOT_SECRET } }
    );
    return { valid: true, data: data.data ?? data };
  } catch (err: any) {
    const apiMessage: string =
      err.response?.data?.error ??
      err.response?.data?.message ??
      err.response?.data?.msg ??
      '';
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
    `${env.API_URL}/api/coupons/apply`,
    { couponId, telegramUserId, paymentId },
    { headers: { 'x-bot-secret': env.TELEGRAM_BOT_SECRET } }
  );
}

export async function revertCoupon(paymentId: string): Promise<void> {
  await axios.post(
    `${env.API_URL}/api/coupons/revert`,
    { paymentId },
    { headers: { 'x-bot-secret': env.TELEGRAM_BOT_SECRET } }
  );
}
