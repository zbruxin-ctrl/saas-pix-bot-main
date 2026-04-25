FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json ./apps/api/

RUN npm install

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY prisma ./prisma
COPY tsconfig.json ./

RUN npm run build -w packages/shared
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npm run build -w apps/api

EXPOSE 3001

CMD ["node", "apps/api/dist/index.js"]