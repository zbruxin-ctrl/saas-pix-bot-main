// couponClient.ts — client do bot para cupons
import axios from 'axios';

const API_URL = process.env.API_URL!;
const BOT_SECRET = process.env.BOT_SECRET!;

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
    const message = err.response?.data?.error ?? 'Cupom inválido.';
    return { valid: false, error: message };
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
