-- Migration: add_missing_columns

-- 1) sortOrder em products
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='products' AND column_name='sortOrder'
  ) THEN
    ALTER TABLE "products" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- 2) Cria enum WebhookEventStatus (se nao existir)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookEventStatus') THEN
    CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');
  END IF;
END $$;

-- 3) Converte coluna status de text para enum
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='webhook_events' AND column_name='status' AND data_type='text'
  ) THEN
    ALTER TABLE "webhook_events" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "webhook_events"
      ALTER COLUMN "status" TYPE "WebhookEventStatus"
      USING "status"::"WebhookEventStatus";
    ALTER TABLE "webhook_events"
      ALTER COLUMN "status" SET DEFAULT 'RECEIVED';
  END IF;
END $$;
