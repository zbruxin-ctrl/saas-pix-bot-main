FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# Copia tudo
COPY . .

# Instala dependencias do monorepo
RUN npm install

# Compila shared primeiro (API depende dele)
RUN npm run build -w packages/shared

# Gera Prisma client UMA UNICA VEZ na raiz do monorepo
# O script de build da API tambem roda prisma generate — removemos essa duplicacao
# usando diretamente o tsc sem o prisma generate extra
RUN npx prisma generate --schema=./prisma/schema.prisma

# Compila a API (so o tsc, sem prisma generate duplicado)
RUN cd apps/api && npx tsc

EXPOSE 3001
CMD ["sh", "start.sh"]
