-- OPT #4: Índice composto para queries de reutilização de PIX e depósitos pendentes
-- Usado em: paymentService._findPendingPixPayment, _findPendingDeposit
-- Query padrão: WHERE telegramUserId = ? AND status = 'PENDING' AND pixExpiresAt > NOW()
CREATE INDEX IF NOT EXISTS "payments_telegramUserId_status_pixExpiresAt_idx"
  ON "payments"("telegramUserId", "status", "pixExpiresAt");
