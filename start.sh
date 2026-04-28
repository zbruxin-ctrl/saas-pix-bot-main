#!/bin/sh
set -e

echo '>>> [1/3] Rodando migrations'
npx prisma migrate deploy --schema=./prisma/schema.prisma
echo '>>> [2/3] Migrations OK'

echo '>>> [3/3] Iniciando node'
exec node apps/api/dist/index.js
