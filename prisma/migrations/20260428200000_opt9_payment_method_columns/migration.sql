-- OPT #9: Adiciona colunas reais em payments substituindo leitura de metadata
-- Compatível com Neon.tech (PostgreSQL) — todas as colunas são nullable para
-- não quebrar linhas existentes (backfill feito em runtime pelo paymentService)

-- 1. Cria o enum PaymentMethod (IF NOT EXISTS para ser idempotente)
DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'BALANCE', 'MIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Adiciona as 3 colunas nullable em payments
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "paymentMethod" "PaymentMethod",
  ADD COLUMN IF NOT EXISTS "balanceUsed"   DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "pixAmount"     DECIMAL(10,2);

-- 3. Backfill: lê os valores de metadata e preenche as colunas novas
--    Seguro: só atualiza linhas onde a coluna ainda é NULL
UPDATE "payments"
SET
  "paymentMethod" = CASE
    WHEN metadata->>'paymentMethod' = 'BALANCE' THEN 'BALANCE'::"PaymentMethod"
    WHEN metadata->>'paymentMethod' = 'MIXED'   THEN 'MIXED'::"PaymentMethod"
    WHEN metadata->>'paymentMethod' = 'PIX'     THEN 'PIX'::"PaymentMethod"
    WHEN metadata->>'paidWithBalance' = 'true'  THEN 'BALANCE'::"PaymentMethod"
    ELSE NULL
  END,
  "balanceUsed" = CASE
    WHEN (metadata->>'balanceUsed') IS NOT NULL
    THEN (metadata->>'balanceUsed')::DECIMAL(10,2)
    ELSE NULL
  END,
  "pixAmount" = CASE
    WHEN (metadata->>'pixAmount') IS NOT NULL
    THEN (metadata->>'pixAmount')::DECIMAL(10,2)
    ELSE NULL
  END
WHERE "paymentMethod" IS NULL;

-- 4. Índice para queries de analytics por método de pagamento
CREATE INDEX IF NOT EXISTS "payments_paymentMethod_status_idx"
  ON "payments"("paymentMethod", "status");
