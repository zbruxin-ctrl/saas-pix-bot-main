-- Migration: add_admin_settings_and_audit_logs
-- Cria as tabelas admin_settings e audit_logs que existem no schema.prisma
-- mas nunca foram migradas para o banco de dados.

-- ─── audit_logs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id"         TEXT NOT NULL,
    "adminId"    TEXT NOT NULL,
    "action"     TEXT NOT NULL,
    "targetType" TEXT,
    "targetId"   TEXT,
    "metadata"   TEXT,
    "ip"         TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_adminId_idx"   ON "audit_logs"("adminId");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx"    ON "audit_logs"("action");
CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- FK para admin_users (já existe no banco)
ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "admin_users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── admin_settings ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "admin_settings" (
    "id"        TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "value"     TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_settings_key_key" ON "admin_settings"("key");
