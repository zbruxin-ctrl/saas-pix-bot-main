#!/bin/sh
set -e

echo "=== [1/3] Rodando migrations ==="
npx prisma migrate deploy --schema=./prisma/schema.prisma

echo "=== [2/3] Verificando dist ==="
if [ ! -f apps/api/dist/index.js ]; then
  echo "ERRO CRITICO: apps/api/dist/index.js nao encontrado!"
  echo "Arquivos em apps/api/:"
  ls -la apps/api/
  exit 1
fi
echo "dist/index.js encontrado OK"

echo "=== [3/3] Iniciando API ==="
exec node apps/api/dist/index.js
