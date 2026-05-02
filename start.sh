#!/bin/sh
set -e

# Se SERVICE_NAME=bot, roda o bot direto sem migrations
if [ "$SERVICE_NAME" = "bot" ]; then
  echo '>>> Iniciando BOT'
  exec node apps/bot/dist/index.js
fi

# Caso contrario, assume API
# IMPORTANTE: prisma migrate deploy NAO funciona com connection pooler (pgBouncer).
# O advisory lock exige conexao direta. Por isso, sobrescrevemos DATABASE_URL
# com DIRECT_URL apenas durante o migrate.
if [ -n "$DIRECT_URL" ]; then
  echo '>>> Usando DIRECT_URL para migrations (evita timeout de advisory lock)'
  MIGRATE_URL="$DIRECT_URL"
else
  echo '>>> DIRECT_URL nao definida -- usando DATABASE_URL para migrations'
  MIGRATE_URL="$DATABASE_URL"
fi

echo '>>> [1/3] Rodando migrations'

# Auto-resolve: se houver migration com status "failed" no banco (P3009),
# marca como rolled-back para que o deploy possa reaplicar.
DATABASE_URL="$MIGRATE_URL" npx prisma migrate resolve \
  --rolled-back 20260502000001_add_coupons_referrals_volume_tiers \
  --schema=./prisma/schema.prisma 2>/dev/null || true

DATABASE_URL="$MIGRATE_URL" npx prisma migrate deploy --schema=./prisma/schema.prisma
echo '>>> [2/3] Migrations OK'

echo '>>> [3/3] Iniciando node'
exec node apps/api/dist/index.js
