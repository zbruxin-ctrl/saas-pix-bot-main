FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npm run build -w apps/api
RUN chmod +x start.sh
EXPOSE 3001
CMD ["sh", "start.sh"]
