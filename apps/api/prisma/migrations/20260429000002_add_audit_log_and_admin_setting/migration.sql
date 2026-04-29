-- Migration: AuditLog + AdminSetting
-- Compatible com Neon (PostgreSQL). Usa IF NOT EXISTS para ser idempotente.

CREATE TABLE IF NOT EXISTS "AdminSetting" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "key"       TEXT NOT NULL,
    "value"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminSetting_key_key" ON "AdminSetting"("key");

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "adminId"    TEXT NOT NULL,
    "action"     TEXT NOT NULL,
    "targetType" TEXT,
    "targetId"   TEXT,
    "metadata"   TEXT,
    "ip"         TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AuditLog_adminId_idx"  ON "AuditLog"("adminId");
CREATE INDEX IF NOT EXISTS "AuditLog_action_idx"   ON "AuditLog"("action");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- FK opcional: só aplica se a tabela Admin já existir
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Admin') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'AuditLog_adminId_fkey'
    ) THEN
      ALTER TABLE "AuditLog"
        ADD CONSTRAINT "AuditLog_adminId_fkey"
        FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE;
    END IF;
  END IF;
END;
$$;
