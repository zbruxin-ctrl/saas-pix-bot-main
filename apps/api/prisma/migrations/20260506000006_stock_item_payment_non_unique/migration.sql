-- FIX-QTY: remove UNIQUE de stock_items.paymentId e orders.paymentId
-- para suportar múltiplos itens/orders por pagamento (qty > 1)

-- stock_items: drop unique, criar index comum
DROP INDEX IF EXISTS "stock_items_paymentId_key";
ALTER TABLE "stock_items" DROP CONSTRAINT IF EXISTS "stock_items_paymentId_key";
CREATE INDEX IF NOT EXISTS "stock_items_paymentId_idx" ON "stock_items"("paymentId");

-- orders: drop unique, criar index comum
DROP INDEX IF EXISTS "orders_paymentId_key";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_paymentId_key";
CREATE INDEX IF NOT EXISTS "orders_paymentId_idx" ON "orders"("paymentId");
