FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# cache-bust: 2026-05-01T21:00
COPY . .

RUN npm install
RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN cd apps/api && npx tsc
RUN test -f apps/api/dist/index.js || (echo 'ERRO: apps/api/dist/index.js nao gerado' && exit 1)
RUN cd apps/bot && npx tsc
RUN test -f apps/bot/dist/index.js || (echo 'ERRO: apps/bot/dist/index.js nao gerado' && exit 1)

ENV NODE_PATH=/app/node_modules
EXPOSE 3001
