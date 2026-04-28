#!/bin/sh
set -e

# Se SERVICE_NAME=bot, roda o bot direto sem migrations
if [ "$SERVICE_NAME" = "bot" ]; then
  echo '>>> Iniciando BOT'
  exec node apps/bot/dist/index.js
fi

# Caso contrário, assume API
# IMPORTANTE: prisma migrate deploy NÃO funciona com connection pooler (pgBouncer).
# O advisory lock exige conexão direta. Por isso, sobrescrevemos DATABASE_URL
# com DIRECT_URL apenas durante o migrate. O Prisma Client continua usando o pooler.
if [ -n "$DIRECT_URL" ]; then
  echo '>>> Usando DIRECT_URL para migrations (evita timeout de advisory lock)'
  MIGRATE_URL="$DIRECT_URL"
else
  echo '>>> DIRECT_URL não definida — usando DATABASE_URL para migrations'
  MIGRATE_URL="$DATABASE_URL"
fi

echo '>>> [1/4] Resolvendo migrations com falha (se houver)'
DATABASE_URL="$MIGRATE_URL" npx prisma migrate resolve --schema=./prisma/schema.prisma --rolled-back 20260428140000_add_missing_columns 2>/dev/null || true
DATABASE_URL="$MIGRATE_URL" npx prisma migrate resolve --schema=./prisma/schema.prisma --rolled-back 20260428160000_add_balance_and_missing_cols 2>/dev/null || true
DATABASE_URL="$MIGRATE_URL" npx prisma migrate resolve --schema=./prisma/schema.prisma --rolled-back 20260428170000_sync_all_missing_columns 2>/dev/null || true
DATABASE_URL="$MIGRATE_URL" npx prisma migrate resolve --schema=./prisma/schema.prisma --rolled-back 20260428200000_opt9_payment_method_columns 2>/dev/null || true

echo '>>> [2/4] Rodando migrations'
DATABASE_URL="$MIGRATE_URL" npx prisma migrate deploy --schema=./prisma/schema.prisma
echo '>>> [3/4] Migrations OK'

echo '>>> [4/4] Iniciando node'
exec node apps/api/dist/index.js
