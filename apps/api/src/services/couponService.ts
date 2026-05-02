// couponService.ts — validação, aplicação e reversão de cupons
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface CouponValidationResult {
  valid: boolean;
  error?: string;
  couponId?: string;
  discountType?: 'PERCENT' | 'FIXED';
  discountValue?: number;
  finalAmount?: number;
  discountAmount?: number;
}

/**
 * Valida um cupom sem consumi-lo.
 * Retorna o valor final após desconto se válido.
 */
export async function validateCoupon(
  code: string,
  telegramId: string,
  orderAmount: number,
  productId?: string
): Promise<CouponValidationResult> {
  const coupon = await prisma.coupon.findUnique({
    where: { code: code.toUpperCase().trim() },
  });

  if (!coupon || !coupon.isActive) {
    return { valid: false, error: 'Cupom inválido ou inativo.' };
  }

  if (coupon.validUntil && coupon.validUntil < new Date()) {
    return { valid: false, error: 'Este cupom está expirado.' };
  }

  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, error: 'Este cupom já atingiu o limite de usos.' };
  }

  if (coupon.minOrderValue !== null && orderAmount < Number(coupon.minOrderValue)) {
    return {
      valid: false,
      error: `Pedido mínimo para este cupom: R$ ${Number(coupon.minOrderValue).toFixed(2)}.`,
    };
  }

  // Verifica se o cupom é válido para o produto
  if (coupon.productIds && productId) {
    const allowed = JSON.parse(coupon.productIds) as string[];
    if (!allowed.includes(productId)) {
      return { valid: false, error: 'Cupom não válido para este produto.' };
    }
  }

  // Verifica uso único por usuário
  const user = await prisma.telegramUser.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  if (user) {
    const alreadyUsed = await prisma.couponUse.findUnique({
      where: { couponId_telegramUserId: { couponId: coupon.id, telegramUserId: user.id } },
    });
    if (alreadyUsed) {
      return { valid: false, error: 'Você já usou este cupom.' };
    }
  }

  // Calcula desconto
  let discountAmount: number;
  if (coupon.discountType === 'PERCENT') {
    discountAmount = parseFloat((orderAmount * (Number(coupon.discountValue) / 100)).toFixed(2));
  } else {
    discountAmount = Math.min(Number(coupon.discountValue), orderAmount);
  }
  const finalAmount = parseFloat((orderAmount - discountAmount).toFixed(2));

  return {
    valid: true,
    couponId: coupon.id,
    discountType: coupon.discountType as 'PERCENT' | 'FIXED',
    discountValue: Number(coupon.discountValue),
    discountAmount,
    finalAmount,
  };
}

/**
 * Consome o cupom: cria CouponUse e incrementa usedCount atomicamente.
 * Deve ser chamado após confirmão de pagamento (ou no momento da criação do PIX).
 */
export async function applyCoupon(
  couponId: string,
  telegramUserId: string,
  paymentId: string
): Promise<void> {
  await prisma.$transaction([
    prisma.couponUse.create({
      data: { couponId, telegramUserId, paymentId },
    }),
    prisma.coupon.update({
      where: { id: couponId },
      data: { usedCount: { increment: 1 } },
    }),
  ]);
  logger.info(`[coupon] Aplicado couponId=${couponId} paymentId=${paymentId}`);
}

/**
 * Reverte o uso de um cupom: deleta CouponUse e decrementa usedCount.
 * Chamado quando o pagamento expira ou é cancelado.
 */
export async function revertCoupon(
  paymentId: string
): Promise<void> {
  const use = await prisma.couponUse.findUnique({
    where: { paymentId },
    select: { id: true, couponId: true },
  });

  if (!use) return; // pagamento não tinha cupom

  await prisma.$transaction([
    prisma.couponUse.delete({ where: { id: use.id } }),
    prisma.coupon.update({
      where: { id: use.couponId },
      data: { usedCount: { decrement: 1 } },
    }),
  ]);
  logger.info(`[coupon] Revertido couponId=${use.couponId} paymentId=${paymentId}`);
}
