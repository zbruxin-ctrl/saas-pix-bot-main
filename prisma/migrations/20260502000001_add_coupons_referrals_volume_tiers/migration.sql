-- CreateEnum (idempotente via DO block)
DO $$ BEGIN
  CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Colunas de pricing em payments
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "couponId"       TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "discountAmount" DECIMAL(10,2);
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "originalAmount" DECIMAL(10,2);

-- Tabela coupons
CREATE TABLE IF NOT EXISTS "coupons" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "code"          TEXT NOT NULL,
    "discountType"  "DiscountType" NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "minOrderValue" DECIMAL(10,2),
    "maxUses"       INTEGER,
    "usedCount"     INTEGER NOT NULL DEFAULT 0,
    "validUntil"    TIMESTAMP(3),
    "productIds"    TEXT,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_key" ON "coupons"("code");
CREATE INDEX IF NOT EXISTS "coupons_code_idx" ON "coupons"("code");
CREATE INDEX IF NOT EXISTS "coupons_isActive_idx" ON "coupons"("isActive");

-- Tabela coupon_uses
CREATE TABLE IF NOT EXISTS "coupon_uses" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "couponId"       TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "paymentId"      TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "coupon_uses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "coupon_uses_paymentId_key" ON "coupon_uses"("paymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "coupon_uses_couponId_telegramUserId_key" ON "coupon_uses"("couponId", "telegramUserId");
CREATE INDEX IF NOT EXISTS "coupon_uses_telegramUserId_idx" ON "coupon_uses"("telegramUserId");

-- Tabela volume_tiers
CREATE TABLE IF NOT EXISTS "volume_tiers" (
    "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "productId"       TEXT,
    "minQty"          INTEGER NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "volume_tiers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "volume_tiers_productId_minQty_idx" ON "volume_tiers"("productId", "minQty");

-- Tabela referrals
CREATE TABLE IF NOT EXISTS "referrals" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "referrerId"   TEXT NOT NULL,
    "referredId"   TEXT NOT NULL,
    "paymentId"    TEXT,
    "rewardPaid"   BOOLEAN NOT NULL DEFAULT false,
    "rewardAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "referrals_referredId_key" ON "referrals"("referredId");
CREATE UNIQUE INDEX IF NOT EXISTS "referrals_paymentId_key" ON "referrals"("paymentId");
CREATE INDEX IF NOT EXISTS "referrals_referrerId_idx" ON "referrals"("referrerId");

-- Foreign keys (sem IF NOT EXISTS — sintaxe invalida no PostgreSQL)
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_telegramUserId_fkey"
    FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "volume_tiers" ADD CONSTRAINT "volume_tiers_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerId_fkey"
    FOREIGN KEY ("referrerId") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredId_fkey"
    FOREIGN KEY ("referredId") REFERENCES "telegram_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
