FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# cache-bust: 2026-04-28T12:53
COPY . .

RUN npm install
RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN cd apps/api && npx tsc

EXPOSE 3001
CMD ["sh", "start.sh"]
