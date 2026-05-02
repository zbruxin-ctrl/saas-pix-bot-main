-- OPT #9: Promove campos de metadata para colunas reais na tabela payments
-- Seguro: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS para ser idempotente
-- Colunas já existentes (paymentMethod, balanceUsed) são mantidas caso já criadas
-- por migration anterior (schema manual).

-- 1. Garante que paymentMethod existe como TEXT
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;

-- 2. Garante que balanceUsed existe como DECIMAL
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS "balanceUsed" DECIMAL(10,2);

-- 3. Adiciona pixAmount (quanto foi pago via PIX em pagamentos MIXED)
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS "pixAmount" DECIMAL(10,2);

-- 4. Adiciona isDeposit para distinguir PIX de depósito de compra de produto
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS "isDeposit" BOOLEAN NOT NULL DEFAULT false;

-- 5. Índices úteis para queries de relatório e dedup
CREATE INDEX IF NOT EXISTS "payments_paymentMethod_idx" ON payments("paymentMethod");
CREATE INDEX IF NOT EXISTS "payments_isDeposit_idx"     ON payments("isDeposit");

-- 6. Backfill: popula colunas a partir de metadata existente
--    Só altera linhas onde a coluna ainda é NULL (safe para rodar múltiplas vezes)

-- 6a. paymentMethod from metadata
UPDATE payments
SET "paymentMethod" = metadata->>'paymentMethod'
WHERE "paymentMethod" IS NULL
  AND metadata IS NOT NULL
  AND metadata->>'paymentMethod' IS NOT NULL;

-- 6b. balanceUsed from metadata
UPDATE payments
SET "balanceUsed" = (metadata->>'balanceUsed')::DECIMAL
WHERE "balanceUsed" IS NULL
  AND metadata IS NOT NULL
  AND metadata->>'balanceUsed' IS NOT NULL;

-- 6c. pixAmount from metadata
UPDATE payments
SET "pixAmount" = (metadata->>'pixAmount')::DECIMAL
WHERE "pixAmount" IS NULL
  AND metadata IS NOT NULL
  AND metadata->>'pixAmount' IS NOT NULL;

-- 6d. isDeposit: marca pagamentos cujo metadata indica tipo WALLET_DEPOSIT
UPDATE payments
SET "isDeposit" = true
WHERE "isDeposit" = false
  AND metadata IS NOT NULL
  AND (
    metadata->>'type' = 'WALLET_DEPOSIT'
    OR metadata->>'isDeposit' = 'true'
  );

-- 6e. Infere PIX quando há pixQrCode preenchido e não é depósito
UPDATE payments
SET "paymentMethod" = 'PIX'
WHERE "paymentMethod" IS NULL
  AND "isDeposit" = false
  AND "pixQrCode" IS NOT NULL
  AND "pixQrCode" <> '';

-- 6f. Pagamentos de depósito sem paymentMethod → PIX
UPDATE payments
SET "paymentMethod" = 'PIX'
WHERE "paymentMethod" IS NULL
  AND "isDeposit" = true;
