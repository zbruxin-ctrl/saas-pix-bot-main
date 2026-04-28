FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# cache-bust: 2026-04-28T13:01
COPY . .

RUN npm install
RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN cd apps/api && npx tsc

# Verifica que o build gerou o arquivo esperado
RUN test -f apps/api/dist/index.js || (echo 'ERRO: apps/api/dist/index.js nao foi gerado!' && exit 1)

EXPOSE 3001

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["npx prisma migrate deploy --schema=./prisma/schema.prisma && echo 'Migrations OK' && exec node apps/api/dist/index.js"]
