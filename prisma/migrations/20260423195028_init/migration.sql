-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'OPERATOR');

-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('TEXT', 'LINK', 'TOKEN', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PROCESSING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryLogStatus" AS ENUM ('SUCCESS', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'OPERATOR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_users" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "languageCode" TEXT,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "deliveryType" "DeliveryType" NOT NULL,
    "deliveryContent" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stock" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mercadoPagoId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "pixQrCode" TEXT,
    "pixQrCodeText" TEXT,
    "pixExpiresAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PROCESSING',
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_logs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "DeliveryLogStatus" NOT NULL,
    "message" TEXT,
    "error" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mercado_pago',
    "eventType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "paymentId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_users_telegramId_key" ON "telegram_users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_mercadoPagoId_key" ON "payments"("mercadoPagoId");

-- CreateIndex
CREATE INDEX "payments_telegramUserId_idx" ON "payments"("telegramUserId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_mercadoPagoId_idx" ON "payments"("mercadoPagoId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_paymentId_key" ON "orders"("paymentId");

-- CreateIndex
CREATE INDEX "orders_telegramUserId_idx" ON "orders"("telegramUserId");

-- CreateIndex
CREATE INDEX "delivery_logs_orderId_idx" ON "delivery_logs"("orderId");

-- CreateIndex
CREATE INDEX "webhook_events_externalId_idx" ON "webhook_events"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_externalId_eventType_key" ON "webhook_events"("provider", "externalId", "eventType");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_logs" ADD CONSTRAINT "delivery_logs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
