-- CreateTable AdminSetting para configurações do bot via painel admin
-- Compatible com Neon (PostgreSQL)
CREATE TABLE IF NOT EXISTS "AdminSetting" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "key"       TEXT NOT NULL,
    "value"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdminSetting_key_key" ON "AdminSetting"("key");
