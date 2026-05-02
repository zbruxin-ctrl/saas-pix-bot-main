-- Cria enum WalletTransactionType se nao existir
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WalletTransactionType') THEN
    CREATE TYPE "WalletTransactionType" AS ENUM ('DEPOSIT', 'PURCHASE', 'REFUND', 'BONUS', 'WITHDRAWAL');
  END IF;
END $$;

-- Converte coluna type de TEXT para o enum
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='wallet_transactions' AND column_name='type' AND data_type='text'
  ) THEN
    ALTER TABLE "wallet_transactions"
      ALTER COLUMN "type" TYPE "WalletTransactionType"
      USING "type"::"WalletTransactionType";
  END IF;
END $$;
