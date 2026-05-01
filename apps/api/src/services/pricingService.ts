// pricingService.ts
// Toda a lógica de precificação isolada:
//   - Desconto por cupom (PERCENT | FIXED) com validações completas
//   - Desconto por volume (tiers globais + por produto; aplica o maior)
//   - Registro e validação de referral (primeiro pedido pago, sem auto-indicação)
//   - applyPricing: função principal, retorna PricingResult sem efeitos colaterais
//   - commitCouponUse: debita uso do cupão dentro de uma transação Prisma
//   - commitReferral: cria registro de referral (recompensa paga em processApprovedPayment)

import { PrismaClient, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';

const prisma = new PrismaClient();

// ─── Interfaces internas ────────────────────────────────────────────────────────────

export interface ApplyPricingInput {
  productId: string;
  telegramUserId: string;  // internal DB id
  telegramId: string;      // Telegram numeric id (string)
  basePrice: number;       // preço unitário do produto
  quantity: number;        // sempre >= 1
  couponCode?: string | null;
  referralCode?: string | null; // telegramId do referrer
}

export interface PricingResult {
  originalAmount: number;    // basePrice * quantity
  discountAmount: number;    // total descontado
  finalAmount: number;       // originalAmount - discountAmount (mínimo R$ 0.01)
  volumeDiscountPercent: number;
  couponId: string | null;
  couponCode: string | null;
  referrerId: string | null; // internal DB id do referrer (se válido)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function toNumber(v: Decimal | number | string): number {
  return new Decimal(v).toNumber();
}

// ─── Volume discount ───────────────────────────────────────────────────────────────

async function resolveVolumeDiscount(
  productId: string,
  quantity: number
): Promise<number> {
  if (quantity <= 1) return 0;

  // Busca tiers do produto e globais, ordena por minQty desc
  const tiers = await prisma.volumeTier.findMany({
    where: {
      OR: [
        { productId },
        { productId: null },
      ],
      minQty: { lte: quantity },
    },
    orderBy: { discountPercent: 'desc' },
  });

  if (!tiers.length) return 0;

  // Aplica o maior desconto entre todos os tiers elegíveis
  const best = tiers.reduce((max, t) =>
    new Decimal(t.discountPercent).gt(new Decimal(max.discountPercent)) ? t : max
  );

  return toNumber(best.discountPercent);
}

// ─── Coupon validation ───────────────────────────────────────────────────────────

export class CouponError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'CouponError';
  }
}

async function resolveCoupon(
  code: string,
  productId: string,
  telegramUserId: string,
  orderValue: number // valor após desconto de volume
): Promise<{ id: string; code: string; discountAmount: number } | null> {
  const coupon = await prisma.coupon.findUnique({
    where: { code: code.toUpperCase().trim() },
  });

  if (!coupon || !coupon.isActive) {
    throw new CouponError('Cupom inválido ou inativo.', 'COUPON_INVALID');
  }

  if (coupon.validUntil && coupon.validUntil < new Date()) {
    throw new CouponError('Cupom expirado.', 'COUPON_EXPIRED');
  }

  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    throw new CouponError('Cupom esgotado.', 'COUPON_EXHAUSTED');
  }

  if (coupon.minOrderValue !== null && orderValue < toNumber(coupon.minOrderValue)) {
    throw new CouponError(
      `Valor mínimo para este cupom: R$ ${toNumber(coupon.minOrderValue).toFixed(2)}`,
      'COUPON_MIN_VALUE'
    );
  }

  // Verifica restrição por produto
  if (coupon.productIds) {
    try {
      const allowed: string[] = JSON.parse(coupon.productIds);
      if (allowed.length > 0 && !allowed.includes(productId)) {
        throw new CouponError('Cupom não válido para este produto.', 'COUPON_PRODUCT_MISMATCH');
      }
    } catch (e) {
      if (e instanceof CouponError) throw e;
      // JSON malformado — ignora restrição de produto
    }
  }

  // Verifica se usuário já usou
  const alreadyUsed = await prisma.couponUse.findUnique({
    where: { couponId_telegramUserId: { couponId: coupon.id, telegramUserId } },
  });
  if (alreadyUsed) {
    throw new CouponError('Você já usou este cupom.', 'COUPON_ALREADY_USED');
  }

  // Calcula desconto
  const d = new Decimal(coupon.discountValue);
  let discountAmount: number;
  if (coupon.discountType === 'PERCENT') {
    discountAmount = new Decimal(orderValue).mul(d).div(100).toDecimalPlaces(2).toNumber();
  } else {
    // FIXED — não pode ser maior que o valor do pedido
    discountAmount = Math.min(d.toNumber(), orderValue);
  }

  return { id: coupon.id, code: coupon.code, discountAmount };
}

// ─── Referral validation ──────────────────────────────────────────────────────────

async function resolveReferral(
  referralCode: string,
  telegramId: string,       // ID Telegram do comprador
  telegramUserId: string    // DB id do comprador
): Promise<string | null> {
  // referralCode é o telegramId do referrer
  if (referralCode === telegramId) return null; // sem auto-indicação

  const referrer = await prisma.telegramUser.findUnique({
    where: { telegramId: referralCode },
  });
  if (!referrer) return null;

  // Verifica se o comprador já tem um referral registrado
  const existing = await prisma.referral.findUnique({
    where: { referredId: telegramUserId },
  });
  if (existing) return null; // já foi indicado antes

  return referrer.id;
}

// ─── Public API ─────────────────────────────────────────────────────────────────────

/**
 * Calcula o preço final sem efeitos colaterais no banco.
 * Lança CouponError se o cupom for inválido.
 */
export async function applyPricing(input: ApplyPricingInput): Promise<PricingResult> {
  const { productId, telegramUserId, telegramId, basePrice, quantity, couponCode, referralCode } = input;

  const qty = Math.max(1, Math.floor(quantity));
  const originalAmount = new Decimal(basePrice).mul(qty).toDecimalPlaces(2).toNumber();

  let discountAmount = new Decimal(0);

  // 1. Desconto de volume
  const volumeDiscountPercent = await resolveVolumeDiscount(productId, qty);
  if (volumeDiscountPercent > 0) {
    const volDiscount = new Decimal(originalAmount)
      .mul(volumeDiscountPercent)
      .div(100)
      .toDecimalPlaces(2);
    discountAmount = discountAmount.plus(volDiscount);
  }

  // 2. Cupom (aplicado sobre valor após desconto de volume)
  let couponId: string | null = null;
  let couponCodeResolved: string | null = null;
  const valueAfterVolume = new Decimal(originalAmount).minus(discountAmount).toNumber();

  if (couponCode?.trim()) {
    const couponResult = await resolveCoupon(
      couponCode,
      productId,
      telegramUserId,
      valueAfterVolume
    );
    if (couponResult) {
      discountAmount = discountAmount.plus(new Decimal(couponResult.discountAmount));
      couponId = couponResult.id;
      couponCodeResolved = couponResult.code;
    }
  }

  // 3. Referral (sem desconto no preço — recompensa vai para o referrer após aprovação)
  let referrerId: string | null = null;
  if (referralCode?.trim()) {
    referrerId = await resolveReferral(referralCode, telegramId, telegramUserId);
  }

  // Garante mínimo de R$ 0.01
  const finalAmount = Math.max(
    0.01,
    new Decimal(originalAmount).minus(discountAmount).toDecimalPlaces(2).toNumber()
  );

  return {
    originalAmount,
    discountAmount: discountAmount.toDecimalPlaces(2).toNumber(),
    finalAmount,
    volumeDiscountPercent,
    couponId,
    couponCode: couponCodeResolved,
    referrerId,
  };
}

/**
 * Persiste o uso do cupão dentro de uma transação Prisma existente.
 * Deve ser chamado após criar o Payment (dentro da mesma $transaction).
 */
export async function commitCouponUse(
  tx: Prisma.TransactionClient,
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

/**
 * Cria o registro de referral (sem pagar recompensa ainda).
 * A recompensa é creditada em processApprovedPayment via walletService.deposit.
 */
export async function commitReferral(
  tx: Prisma.TransactionClient,
  referrerId: string,
  referredId: string,
  paymentId: string,
  rewardAmount: number
): Promise<void> {
  await tx.referral.create({
    data: {
      referrerId,
      referredId,
      paymentId,
      rewardPaid: false,
      rewardAmount: new Decimal(rewardAmount),
    },
  });
}

/**
 * Paga a recompensa de referral (chamado em processApprovedPayment).
 * Idempotente: verifica rewardPaid antes de creditar.
 */
export async function payReferralReward(
  tx: Prisma.TransactionClient,
  paymentId: string,
  walletDeposit: (userId: string, amount: number, description: string, tx: Prisma.TransactionClient) => Promise<void>
): Promise<void> {
  const referral = await tx.referral.findUnique({
    where: { paymentId },
  });

  if (!referral || referral.rewardPaid) return;

  const amount = new Decimal(referral.rewardAmount).toNumber();
  if (amount <= 0) return;

  await walletDeposit(
    referral.referrerId,
    amount,
    `Recompensa de indicação (pedido ${paymentId})`,
    tx
  );

  await tx.referral.update({
    where: { id: referral.id },
    data: { rewardPaid: true },
  });
}
