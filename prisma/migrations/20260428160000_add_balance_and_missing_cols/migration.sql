-- Adiciona balance em telegram_users (se nao existir)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='telegram_users' AND column_name='balance'
  ) THEN
    ALTER TABLE "telegram_users" ADD COLUMN "balance" DECIMAL(10,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Adiciona sortOrder em products (se nao existir)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='products' AND column_name='sortOrder'
  ) THEN
    ALTER TABLE "products" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Cria enum WebhookEventStatus (se nao existir)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookEventStatus') THEN
    CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');
  END IF;
END $$;

-- Converte coluna status de text para enum (se ainda for text)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='webhook_events' AND column_name='status' AND data_type='text'
  ) THEN
    ALTER TABLE "webhook_events" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "webhook_events"
      ALTER COLUMN "status" TYPE "WebhookEventStatus"
      USING "status"::"WebhookEventStatus";
    ALTER TABLE "webhook_events" ALTER COLUMN "status" SET DEFAULT 'RECEIVED';
  END IF;
END $$;
