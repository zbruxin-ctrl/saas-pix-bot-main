-- OPT #9: Promove campos de metadata para colunas reais na tabela Payment
-- Seguro: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS para ser idempotente
-- Colunas já existentes (paymentMethod, balanceUsed) são mantidas caso já criadas
-- por migration anterior (schema manual).

-- 1. Garante que paymentMethod existe como TEXT (Prisma enum → TEXT em Postgres)
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;

-- 2. Garante que balanceUsed existe como DECIMAL
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "balanceUsed" DECIMAL(10,2);

-- 3. Adiciona pixAmount (quanto foi pago via PIX em pagamentos MIXED)
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "pixAmount" DECIMAL(10,2);

-- 4. Adiciona isDeposit para distinguir PIX de depósito de carteira de compra de produto
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "isDeposit" BOOLEAN NOT NULL DEFAULT false;

-- 5. Índices úteis para queries de relatório e dedup
CREATE INDEX IF NOT EXISTS "Payment_paymentMethod_idx" ON "Payment"("paymentMethod");
CREATE INDEX IF NOT EXISTS "Payment_isDeposit_idx"     ON "Payment"("isDeposit");

-- 6. Backfill: popula colunas a partir de metadata existente
--    Só altera linhas onde a coluna ainda é NULL (safe para rodar múltiplas vezes)

-- 6a. paymentMethod from metadata
UPDATE "Payment"
SET "paymentMethod" = "metadata"->>'paymentMethod'
WHERE "paymentMethod" IS NULL
  AND "metadata" IS NOT NULL
  AND "metadata"->>'paymentMethod' IS NOT NULL;

-- 6b. balanceUsed from metadata
UPDATE "Payment"
SET "balanceUsed" = ("metadata"->>'balanceUsed')::DECIMAL
WHERE "balanceUsed" IS NULL
  AND "metadata" IS NOT NULL
  AND "metadata"->>'balanceUsed' IS NOT NULL;

-- 6c. pixAmount from metadata
UPDATE "Payment"
SET "pixAmount" = ("metadata"->>'pixAmount')::DECIMAL
WHERE "pixAmount" IS NULL
  AND "metadata" IS NOT NULL
  AND "metadata"->>'pixAmount' IS NOT NULL;

-- 6d. isDeposit: marca pagamentos cujo metadata indica tipo WALLET_DEPOSIT
UPDATE "Payment"
SET "isDeposit" = true
WHERE "isDeposit" = false
  AND "metadata" IS NOT NULL
  AND (
    "metadata"->>'type' = 'WALLET_DEPOSIT'
    OR "metadata"->>'isDeposit' = 'true'
  );

-- 6e. Para pagamentos PIX sem paymentMethod explícito no metadata,
--     infere PIX quando há pixQrCode preenchido e não é depósito
UPDATE "Payment"
SET "paymentMethod" = 'PIX'
WHERE "paymentMethod" IS NULL
  AND "isDeposit" = false
  AND "pixQrCode" IS NOT NULL
  AND "pixQrCode" <> '';

-- 6f. Pagamentos de depósito sem paymentMethod → PIX (único método suportado para depósito)
UPDATE "Payment"
SET "paymentMethod" = 'PIX'
WHERE "paymentMethod" IS NULL
  AND "isDeposit" = true;
