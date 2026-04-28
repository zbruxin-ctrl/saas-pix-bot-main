FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# cache-bust: 2026-04-28T14:00
COPY . .

RUN npm install
RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN cd apps/api && npx tsc
RUN test -f apps/api/dist/index.js || (echo 'ERRO: dist/index.js nao gerado' && exit 1)

ENV NODE_PATH=/app/node_modules
EXPOSE 3001
