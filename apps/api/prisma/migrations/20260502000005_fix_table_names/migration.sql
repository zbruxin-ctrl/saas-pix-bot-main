-- Fix: tabelas criadas com nome PascalCase ("Coupon") precisam ser lowercase ("coupons")
-- O Prisma por padrão mapeia model Coupon → tabela "coupons" (snake_case lowercase)
-- A migration anterior criou com aspas duplas preservando o PascalCase no Postgres

-- Renomear Coupon → coupons
ALTER TABLE IF EXISTS "Coupon" RENAME TO "coupons";

-- Renomear CouponUse → coupon_uses
ALTER TABLE IF EXISTS "CouponUse" RENAME TO "coupon_uses";

-- Renomear VolumeTier → volume_tiers
ALTER TABLE IF EXISTS "VolumeTier" RENAME TO "volume_tiers";

-- Renomear Referral → referrals
ALTER TABLE IF EXISTS "Referral" RENAME TO "referrals";

-- Atualizar indexes que referenciam os nomes antigos
ALTER INDEX IF EXISTS "Coupon_code_key" RENAME TO "coupons_code_key";
ALTER INDEX IF EXISTS "CouponUse_couponId_telegramUserId_key" RENAME TO "coupon_uses_coupon_id_telegram_user_id_key";
ALTER INDEX IF EXISTS "CouponUse_paymentId_key" RENAME TO "coupon_uses_payment_id_key";
ALTER INDEX IF EXISTS "Referral_referredId_key" RENAME TO "referrals_referred_id_key";
ALTER INDEX IF EXISTS "Referral_paymentId_key" RENAME TO "referrals_payment_id_key";
