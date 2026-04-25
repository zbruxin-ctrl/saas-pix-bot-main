FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npm run build -w apps/api
EXPOSE 3001
CMD npx prisma migrate deploy --schema=./prisma/schema.prisma && node apps/api/dist/index.js
