#!/bin/sh
set -e
echo '=== [1/3] Migrations ==='
npx prisma migrate deploy --schema=./prisma/schema.prisma
echo '=== [2/3] Verificando dist ==='
test -f apps/api/dist/index.js || (echo 'ERRO: dist/index.js nao encontrado' && exit 1)
echo '=== [3/3] Iniciando API ==='
exec node apps/api/dist/index.js
