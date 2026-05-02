// pricingService.ts
// Volume tiers (desconto por quantidade) + Pricing unificado
// FIX: re-exporta/implementa tudo que paymentService.ts espera:
//   applyPricing, commitCouponUse, commitReferral, payReferralReward, CouponError
// FIX-TYPES: callbacks de payReferralReward com tipos explícitos (L837/854/872)
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

// ─── Tipos auxiliares ──────────────────────────────────────────────────────────────────────────

export type PrismaTxClient = Prisma.TransactionClient;

// Callback tipado para payReferralReward — resolve L837/854/872 do paymentService
export type ReferralRewardCallback = (
  userId: string,
  amount: number,
  description: string,
  txClient: PrismaTxClient
) => Promise<void>;

// ─── Erros domínio ────────────────────────────────────────────────────────────────────────

export class CouponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouponError';
  }
}

// ─── Interfaces ─────────────────────────────────────────────────────────────────────────

export interface TierResult {
  tierId: string | null;
  discountPercent: number;
  originalAmount: number;
  finalAmount: number;
}

export interface ApplyPricingParams {
  productId: string;
  telegramUserId: string;
  telegramId: string;
  basePrice: number;
  quantity: number;
  couponCode: string | null;
  referralCode: string | null;
}

export interface ApplyPricingResult {
  finalAmount: number;
  originalAmount: number;
  discountAmount: number;
  // Cupom
  couponId: string | null;
  couponCode: string | null;
  couponDiscountAmount: number;
  // Tier
  tierId: string | null;
  tierDiscountAmount: number;
  // Referral
  referrerId: string | null;
}

// ─── Volume Tiers ─────────────────────────────────────────────────────────────────────

/**
 * Retorna o melhor VolumeTier aplicável para o produto + quantidade.
 * Prioridade: tier específico do produto > tier global (productId null)
 */
export async function getEffectiveTier(
  productId: string,
  qty: number
): Promise<TierResult | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { price: true },
  });
  if (!product) return null;

  const originalAmount = Number(product.price) * qty;

  const tiers = await prisma.volumeTier.findMany({
    where: {
      OR: [
        { productId, minQty: { lte: qty } },
        { productId: null, minQty: { lte: qty } },
      ],
    },
    orderBy: { minQty: 'desc' },
  });

  if (tiers.length === 0) {
    return { tierId: null, discountPercent: 0, originalAmount, finalAmount: originalAmount };
  }

  const specific = tiers.filter((t) => t.productId === productId);
  const global = tiers.filter((t) => t.productId === null);
  const best = specific[0] ?? global[0];

  const discountPercent = Number(best.discountPercent);
  const finalAmount = parseFloat(
    (originalAmount * (1 - discountPercent / 100)).toFixed(2)
  );

  return { tierId: best.id, discountPercent, originalAmount, finalAmount };
}

export async function applyVolumeTier(
  productId: string,
  qty: number
): Promise<{ amount: number; discountPercent: number; originalAmount: number }> {
  const result = await getEffectiveTier(productId, qty);
  if (!result) {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { price: true } });
    const originalAmount = Number(product?.price ?? 0) * qty;
    return { amount: originalAmount, discountPercent: 0, originalAmount };
  }
  return { amount: result.finalAmount, discountPercent: result.discountPercent, originalAmount: result.originalAmount };
}

// ─── applyPricing ────────────────────────────────────────────────────────────────────

/**
 * Pipeline de pricing completo:
 * 1. Aplica volume tier (desconto por quantidade)
 * 2. Valida e aplica cupom (loga CouponError se inválido)
 * 3. Resolve referral (busca referrer pelo código)
 * Não commita nada no banco — apenas calcula e valida.
 * commitCouponUse / commitReferral devem ser chamados dentro da $transaction de pagamento.
 */
export async function applyPricing(params: ApplyPricingParams): Promise<ApplyPricingResult> {
  const { productId, telegramUserId, basePrice, quantity, couponCode, referralCode } = params;

  const originalAmount = basePrice * quantity;
  let afterTier = originalAmount;
  let tierId: string | null = null;
  let tierDiscountAmount = 0;

  // 1. Volume tier
  const tierResult = await getEffectiveTier(productId, quantity);
  if (tierResult && tierResult.tierId) {
    tierId = tierResult.tierId;
    afterTier = tierResult.finalAmount;
    tierDiscountAmount = parseFloat((originalAmount - afterTier).toFixed(2));
  }

  // 2. Cupom
  let couponId: string | null = null;
  let couponCode_out: string | null = null;
  let couponDiscountAmount = 0;
  let afterCoupon = afterTier;

  if (couponCode) {
    const coupon = await prisma.coupon.findUnique({ where: { code: couponCode.toUpperCase().trim() } });

    if (!coupon) throw new CouponError('Cupom não encontrado.');
    if (!coupon.isActive) throw new CouponError('Cupom inativo.');
    if (coupon.validUntil && coupon.validUntil < new Date()) throw new CouponError('Cupom expirado.');
    if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses) throw new CouponError('Cupom esgotado.');
    if (coupon.minOrderValue != null && afterTier < Number(coupon.minOrderValue)) {
      throw new CouponError(`Pedido mínimo de R$ ${Number(coupon.minOrderValue).toFixed(2)} para este cupom.`);
    }

    // Verifica uso único por usuário (@@unique couponId+telegramUserId)
    const alreadyUsed = await prisma.couponUse.findUnique({
      where: { couponId_telegramUserId: { couponId: coupon.id, telegramUserId } },
    });
    if (alreadyUsed) throw new CouponError('Você já utilizou este cupom.');

    // Verifica se o produto é permitido pelo cupom
    if (coupon.productIds) {
      const allowed: string[] = JSON.parse(String(coupon.productIds));
      if (allowed.length > 0 && !allowed.includes(productId)) {
        throw new CouponError('Este cupom não é válido para este produto.');
      }
    }

    if (coupon.discountType === 'PERCENT') {
      couponDiscountAmount = parseFloat((afterTier * Number(coupon.discountValue) / 100).toFixed(2));
    } else {
      couponDiscountAmount = Math.min(Number(coupon.discountValue), afterTier);
    }

    afterCoupon = parseFloat((afterTier - couponDiscountAmount).toFixed(2));
    couponId = coupon.id;
    couponCode_out = coupon.code;
  }

  // 3. Referral — apenas resolve o referrerId, não registra ainda
  let referrerId: string | null = null;
  if (referralCode) {
    const refUser = await prisma.telegramUser.findUnique({
      where: { telegramId: referralCode },
      select: { id: true },
    });
    // Garante que não é auto-indicação
    if (refUser && refUser.id !== telegramUserId) {
      referrerId = refUser.id;
    }
  }

  const finalAmount = Math.max(0.01, afterCoupon); // mínimo R$ 0,01
  const discountAmount = parseFloat((originalAmount - finalAmount).toFixed(2));

  return {
    finalAmount,
    originalAmount,
    discountAmount,
    couponId,
    couponCode: couponCode_out,
    couponDiscountAmount,
    tierId,
    tierDiscountAmount,
    referrerId,
  };
}

// ─── commitCouponUse ────────────────────────────────────────────────────────────────────

/**
 * Deve ser chamado DENTRO de uma $transaction de pagamento.
 * Cria CouponUse + incrementa usedCount atomicamente.
 */
export async function commitCouponUse(
  tx: PrismaTxClient,
  couponId: string,
  telegramUserId: string,
  paymentId: string
): Promise<void> {
  await tx.couponUse.create({
    data: { couponId, telegramUserId, paymentId },
  });
  await tx.coupon.update({
    where: { id: couponId },
    data: { usedCount: { increment: 1 } },
  });
}

// ─── commitReferral ────────────────────────────────────────────────────────────────────

/**
 * Deve ser chamado DENTRO de uma $transaction de pagamento.
 * Registra a relação de referral (sem pagar recompensa ainda).
 * Idempotente: se já existir (referrerId+referredId), ignora.
 */
export async function commitReferral(
  tx: PrismaTxClient,
  referrerId: string,
  referredId: string,
  paymentId: string,
  rewardAmount: number
): Promise<void> {
  // Idempotente — upsert pela chave única referrerId+referredId
  await tx.referral.upsert({
    where: { referrerId_referredId: { referrerId, referredId } },
    update: {},
    create: {
      referrerId,
      referredId,
      paymentId,
      rewardAmount,
      rewarded: false,
    },
  });
}

// ─── payReferralReward ──────────────────────────────────────────────────────────────────

/**
 * Deve ser chamado DENTRO de uma $transaction de pagamento aprovado.
 * Busca o Referral pelo paymentId, marca como rewarded e invoca o callback
 * para creditar o saldo do referrer (lógica de cartão mantida no paymentService).
 * Se não houver referral pendente, não faz nada.
 */
export async function payReferralReward(
  tx: PrismaTxClient,
  paymentId: string,
  onReward: ReferralRewardCallback
): Promise<void> {
  const referral = await tx.referral.findFirst({
    where: { paymentId, rewarded: false },
    select: { id: true, referrerId: true, rewardAmount: true },
  });

  if (!referral) return;

  await tx.referral.update({
    where: { id: referral.id },
    data: { rewarded: true, rewardedAt: new Date() },
  });

  await onReward(
    referral.referrerId,
    Number(referral.rewardAmount),
    `Recompensa de indicação`,
    tx
  );
}
