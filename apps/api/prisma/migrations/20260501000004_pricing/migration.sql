-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateTable: Coupon
CREATE TABLE "Coupon" (
    "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "code"          TEXT NOT NULL,
    "description"   TEXT,
    "discountType"  "CouponDiscountType" NOT NULL DEFAULT 'PERCENT',
    "discountValue" DECIMAL(10,2) NOT NULL,
    "minOrderValue" DECIMAL(10,2),
    "maxUses"       INTEGER,
    "usedCount"     INTEGER NOT NULL DEFAULT 0,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "validUntil"    TIMESTAMP(3),
    "productIds"    TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateTable: CouponUse
CREATE TABLE "CouponUse" (
    "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "couponId"       TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "paymentId"      TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponUse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CouponUse_couponId_telegramUserId_key" ON "CouponUse"("couponId", "telegramUserId");
CREATE UNIQUE INDEX "CouponUse_paymentId_key" ON "CouponUse"("paymentId");
ALTER TABLE "CouponUse" ADD CONSTRAINT "CouponUse_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE;
ALTER TABLE "CouponUse" ADD CONSTRAINT "CouponUse_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "TelegramUser"("id") ON DELETE CASCADE;
ALTER TABLE "CouponUse" ADD CONSTRAINT "CouponUse_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE;

-- CreateTable: VolumeTier
CREATE TABLE "VolumeTier" (
    "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "productId"       TEXT,
    "minQty"          INTEGER NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "label"           TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VolumeTier_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "VolumeTier" ADD CONSTRAINT "VolumeTier_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL;

-- CreateTable: Referral
CREATE TABLE "Referral" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "referrerId"   TEXT NOT NULL,
    "referredId"   TEXT NOT NULL,
    "paymentId"    TEXT NOT NULL,
    "rewardAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "rewardPaid"   BOOLEAN NOT NULL DEFAULT false,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");
CREATE UNIQUE INDEX "Referral_paymentId_key" ON "Referral"("paymentId");
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "TelegramUser"("id") ON DELETE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "TelegramUser"("id") ON DELETE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE;
