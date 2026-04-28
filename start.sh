#!/bin/sh
set -e

echo "Running migrations..."
npx prisma migrate deploy --schema=./prisma/schema.prisma

echo "Starting API..."
exec node apps/api/dist/index.js
