#!/bin/sh

echo "=== Running migrations ==="
npx prisma migrate deploy --schema=./prisma/schema.prisma

echo "=== Checking dist ==="
ls -la apps/api/dist/ || echo "ERROR: dist folder not found!"

echo "=== Starting API ==="
node apps/api/dist/index.js
EXIT_CODE=$?
echo "ERROR: node exited with code $EXIT_CODE"
exit $EXIT_CODE
