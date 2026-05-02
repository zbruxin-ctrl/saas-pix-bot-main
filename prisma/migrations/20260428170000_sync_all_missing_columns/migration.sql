-- Migration: sync colunas faltantes (tabelas e indices de stock_items ja existem no banco)

-- payments: cancelledAt
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='cancelledAt') THEN
    ALTER TABLE "payments" ADD COLUMN "cancelledAt" TIMESTAMP(3);
  END IF;
END $$;

-- payments: expiredAt
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='expiredAt') THEN
    ALTER TABLE "payments" ADD COLUMN "expiredAt" TIMESTAMP(3);
  END IF;
END $$;

-- payments: productId opcional
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='payments' AND column_name='productId' AND is_nullable='NO'
  ) THEN
    ALTER TABLE "payments" ALTER COLUMN "productId" DROP NOT NULL;
  END IF;
END $$;

-- orders: failedAt
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='failedAt') THEN
    ALTER TABLE "orders" ADD COLUMN "failedAt" TIMESTAMP(3);
  END IF;
END $$;

-- webhook_events: updatedAt
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='webhook_events' AND column_name='updatedAt') THEN
    ALTER TABLE "webhook_events" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

-- delivery_logs: status TEXT
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='delivery_logs' AND column_name='status' AND data_type='USER-DEFINED'
  ) THEN
    ALTER TABLE "delivery_logs" ALTER COLUMN "status" TYPE TEXT USING "status"::TEXT;
  END IF;
END $$;

-- stock_reservations
CREATE TABLE IF NOT EXISTS "stock_reservations" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "telegramUserId" TEXT NOT NULL,
  "paymentId" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='stock_reservations_paymentId_key') THEN
    CREATE UNIQUE INDEX "stock_reservations_paymentId_key" ON "stock_reservations"("paymentId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='stock_reservations_productId_status_idx') THEN
    CREATE INDEX "stock_reservations_productId_status_idx" ON "stock_reservations"("productId", "status");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='stock_reservations_expiresAt_status_idx') THEN
    CREATE INDEX "stock_reservations_expiresAt_status_idx" ON "stock_reservations"("expiresAt", "status");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='stock_reservations_telegramUserId_idx') THEN
    CREATE INDEX "stock_reservations_telegramUserId_idx" ON "stock_reservations"("telegramUserId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_reservations_productId_fkey') THEN
    ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_reservations_telegramUserId_fkey') THEN
    ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='stock_reservations_paymentId_fkey') THEN
    ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- wallet_transactions
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
  "id" TEXT NOT NULL,
  "telegramUserId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "description" TEXT NOT NULL,
  "paymentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='wallet_transactions_telegramUserId_idx') THEN
    CREATE INDEX "wallet_transactions_telegramUserId_idx" ON "wallet_transactions"("telegramUserId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='wallet_transactions_createdAt_idx') THEN
    CREATE INDEX "wallet_transactions_createdAt_idx" ON "wallet_transactions"("createdAt");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='wallet_transactions_telegramUserId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_telegramUserId_fkey" FOREIGN KEY ("telegramUserId") REFERENCES "telegram_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- delivery_medias
CREATE TABLE IF NOT EXISTS "delivery_medias" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "caption" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "delivery_medias_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='delivery_medias_orderId_idx') THEN
    CREATE INDEX "delivery_medias_orderId_idx" ON "delivery_medias"("orderId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='delivery_medias_orderId_fkey') THEN
    ALTER TABLE "delivery_medias" ADD CONSTRAINT "delivery_medias_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Indices em orders
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='orders_status_idx') THEN
    CREATE INDEX "orders_status_idx" ON "orders"("status");
  END IF;
END $$;

-- Indices em delivery_logs
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='delivery_logs_status_createdAt_idx') THEN
    CREATE INDEX "delivery_logs_status_createdAt_idx" ON "delivery_logs"("status", "createdAt");
  END IF;
END $$;

-- Indices em webhook_events
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='webhook_events_status_idx') THEN
    CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='webhook_events_paymentId_idx') THEN
    CREATE INDEX "webhook_events_paymentId_idx" ON "webhook_events"("paymentId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='webhook_events_createdAt_idx') THEN
    CREATE INDEX "webhook_events_createdAt_idx" ON "webhook_events"("createdAt");
  END IF;
END $$;
