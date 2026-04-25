FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# 1. Copia TUDO de uma vez
COPY . .

# 2. Instala tudo (cria os symlinks de workspace corretamente)
RUN npm install

# 3. Build na ordem certa
RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npm run build -w apps/api

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
