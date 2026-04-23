# 🤖 SaaS PIX Bot — Sistema Completo

Bot do Telegram com pagamentos PIX via Mercado Pago + Painel Admin em Next.js.

---

## 📋 PRÉ-REQUISITOS

Antes de começar, instale:

| Ferramenta | Versão Mínima | Download |
|------------|--------------|---------|
| Node.js | 20+ | https://nodejs.org |
| npm | 10+ | (vem com Node.js) |
| Docker Desktop | qualquer | https://docker.com |
| Git | qualquer | https://git-scm.com |

---

## ⚡ CONFIGURAÇÃO PASSO A PASSO

### 1. Clone ou extraia o projeto

```bash
# Se baixou o ZIP, extraia e entre na pasta:
cd saas-pix-bot

# Ou clone do git:
git clone https://github.com/seu-usuario/saas-pix-bot.git
cd saas-pix-bot
```

---

### 2. Crie seu Bot no Telegram

1. Abra o Telegram e procure por **@BotFather**
2. Envie `/newbot`
3. Digite um nome para o bot (ex: `Meu Bot de Vendas`)
4. Digite um username para o bot (ex: `meubotdevendas_bot`) — deve terminar em `bot`
5. Copie o **token** que ele te enviar (parece: `1234567890:AABBCCxx...`)

---

### 3. Configure o Mercado Pago

1. Acesse https://www.mercadopago.com.br/developers/panel/app
2. Clique em **"Criar aplicação"**
3. Dê um nome (ex: "PIX Bot")
4. Vá em **Credenciais de produção** e copie o **Access Token**
   - ⚠️ Para testes use as **credenciais de sandbox** primeiro!
5. Vá em **Webhooks** e:
   - URL de notificação: `https://SUA-URL-PUBLICA/api/webhooks/mercadopago`
   - Selecione o evento: **Pagamentos**
   - Copie a **Chave secreta** gerada

---

### 4. Configure as variáveis de ambiente

```bash
# Copie o arquivo de exemplo
cp .env.example .env

# Edite com seu editor favorito
nano .env  # ou code .env no VS Code
```

Preencha **obrigatoriamente**:

```env
DATABASE_URL="postgresql://postgres:suasenha@localhost:5432/saas_pix_bot"
JWT_SECRET="(gere com: openssl rand -hex 32)"
COOKIE_SECRET="(gere com: openssl rand -hex 32)"
MERCADO_PAGO_ACCESS_TOKEN="APP_USR-..."
MERCADO_PAGO_WEBHOOK_SECRET="sua-chave-secreta-do-webhook"
TELEGRAM_BOT_TOKEN="0000000000:AAxx..."
TELEGRAM_BOT_SECRET="(qualquer string aleatória de 16+ chars)"
API_URL="http://localhost:3001"      # ou sua URL pública
ADMIN_URL="http://localhost:3000"
NEXT_PUBLIC_API_URL="http://localhost:3001"
```

**Gerar segredos no terminal:**
```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# COOKIE_SECRET (gere outro valor diferente)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# TELEGRAM_BOT_SECRET
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

---

### 5. Suba o banco de dados

```bash
# Inicia PostgreSQL e Redis com Docker
docker-compose up -d

# Verifica se subiu corretamente
docker-compose ps
# Deve mostrar "healthy" para o postgres
```

---

### 6. Instale as dependências

```bash
# Na raiz do projeto (instala tudo de uma vez)
npm install
```

---

### 7. Configure o banco de dados

```bash
# Gera o cliente Prisma
npm run db:generate

# Cria as tabelas no banco
npm run db:migrate

# Popula com dados iniciais (admin + produtos de exemplo)
npm run db:seed
```

Após o seed, você verá:
```
✅ Admin criado: admin@seusite.com.br
✅ 3 produtos criados
📋 Credenciais admin padrão:
   Email: admin@seusite.com.br
   Senha: Admin@123456
⚠️  ALTERE A SENHA APÓS O PRIMEIRO LOGIN!
```

---

### 8. Inicie os serviços

Abra **3 terminais separados**:

**Terminal 1 — API:**
```bash
npm run dev:api
# Deve mostrar: 🚀 API rodando na porta 3001
```

**Terminal 2 — Bot:**
```bash
npm run dev:bot
# Deve mostrar: 🤖 Bot iniciado em modo POLLING
```

**Terminal 3 — Painel Admin:**
```bash
npm run dev:web
# Deve mostrar: ▲ Next.js ... ready on http://localhost:3000
```

---

### 9. Acesse o sistema

| Serviço | URL |
|---------|-----|
| Painel Admin | http://localhost:3000/admin |
| API | http://localhost:3001 |
| Health Check | http://localhost:3001/health |
| Banco (Prisma Studio) | `npm run db:studio` |

**Login do painel:**
- Email: `admin@seusite.com.br`
- Senha: `Admin@123456`

---

## 🔗 RECEBER WEBHOOKS EM DESENVOLVIMENTO

O Mercado Pago precisa de uma URL pública para enviar webhooks.
Em desenvolvimento local, use o **ngrok**:

```bash
# Instale o ngrok: https://ngrok.com/download

# Exponha a porta da API
ngrok http 3001

# Você verá algo como:
# Forwarding  https://abc123.ngrok.io -> http://localhost:3001
```

Atualize seu `.env`:
```env
API_URL="https://abc123.ngrok.io"
```

E configure no Mercado Pago:
- Webhook URL: `https://abc123.ngrok.io/api/webhooks/mercadopago`

---

## 🏗️ ESTRUTURA DO PROJETO

```
saas-pix-bot/
├── apps/
│   ├── api/          ← Backend Express (porta 3001)
│   │   └── src/
│   │       ├── config/       env.ts
│   │       ├── lib/          prisma.ts, logger.ts
│   │       ├── middleware/   auth.ts, errorHandler.ts, rateLimit.ts
│   │       ├── routes/       auth, payments, webhooks, admin/*
│   │       └── services/     mercadoPago, payment, delivery, telegram
│   │
│   ├── bot/          ← Bot Telegraf (modo polling ou webhook)
│   │   └── src/
│   │       ├── config/       env.ts
│   │       ├── services/     apiClient.ts
│   │       └── index.ts      ← todos os handlers aqui
│   │
│   └── web/          ← Painel Admin Next.js (porta 3000)
│       └── src/
│           ├── app/          login/, admin/{page,payments,products,users}
│           ├── components/   layout/, admin/
│           └── lib/          api.ts, utils.ts
│
├── packages/
│   └── shared/       ← Tipos TypeScript compartilhados
│
├── prisma/
│   ├── schema.prisma ← Modelos do banco
│   └── seed.ts       ← Dados iniciais
│
├── docker-compose.yml
├── .env.example
└── package.json      ← Workspace raiz
```

---

## 🗃️ MODELOS DO BANCO

| Tabela | Descrição |
|--------|-----------|
| `admin_users` | Usuários do painel admin |
| `telegram_users` | Usuários que interagiram com o bot |
| `products` | Produtos/planos à venda |
| `payments` | Pagamentos PIX gerados |
| `orders` | Pedidos criados após pagamento aprovado |
| `delivery_logs` | Logs de tentativas de entrega |
| `webhook_events` | Todos os eventos recebidos do Mercado Pago |

---

## 💳 FLUXO COMPLETO DE COMPRA

```
Usuário → /start no bot
       → Escolhe produto (botão inline)
       → Confirma compra
       → Bot chama POST /api/payments/create
       → API cria pagamento no Mercado Pago
       → Retorna QR Code base64 + código copia/cola
       → Bot envia foto do QR Code + código para o usuário
       → Usuário paga pelo banco
       → Mercado Pago envia POST /api/webhooks/mercadopago
       → Webhook valida assinatura HMAC
       → Busca pagamento no MP via API
       → Valida status "approved" + valor correto
       → Atualiza Payment → APPROVED no banco
       → Cria Order → PROCESSING
       → DeliveryService envia produto via Telegram
       → Order → DELIVERED
       → Usuário recebe o produto ✅
```

---

## 🔒 SEGURANÇA IMPLEMENTADA

- ✅ Variáveis de ambiente validadas com Zod na inicialização
- ✅ JWT em cookies httpOnly + signed (imune a XSS)
- ✅ Rate limiting nos endpoints públicos
- ✅ Validação HMAC dos webhooks do Mercado Pago
- ✅ Idempotência: webhooks duplicados são ignorados
- ✅ Verificação do pagamento diretamente na API do MP (não confia cegamente no webhook)
- ✅ Token secreto para comunicação Bot → API
- ✅ Bcrypt para hash de senhas
- ✅ Prisma previne SQL injection por padrão
- ✅ Helmet para headers HTTP seguros

---

## 🚀 DEPLOY EM PRODUÇÃO

### Opção 1 — Railway (mais simples)

1. Crie conta em https://railway.app
2. Crie um projeto com PostgreSQL
3. Faça deploy da API: conecte o repositório, defina o start command como `npm run start -w apps/api`
4. Configure todas as variáveis de ambiente
5. Deploy do bot: mesmo processo, start command `npm run start -w apps/bot`
6. Deploy do web: use Vercel (https://vercel.com) para o Next.js

### Opção 2 — VPS (Ubuntu)

```bash
# Instala Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Instala PM2 para gerenciar processos
npm install -g pm2

# Clona e configura o projeto
git clone ... && cd saas-pix-bot
cp .env.example .env
# Edite o .env com os valores de produção

npm install
npm run db:generate
npm run db:migrate:prod
npm run db:seed
npm run build

# Inicia com PM2
pm2 start apps/api/dist/index.js --name "pix-api"
pm2 start apps/bot/dist/index.js --name "pix-bot"
pm2 save
pm2 startup  # configura para iniciar com o servidor

# Para o painel admin, use Nginx como proxy reverso para o Next.js
# ou hospede separadamente na Vercel
```

---

## ❓ PROBLEMAS COMUNS

**"DATABASE_URL é obrigatório"**
→ Verifique se criou o arquivo `.env` (não apenas `.env.example`)

**"Bot não responde"**
→ Verifique se o TELEGRAM_BOT_TOKEN está correto no `.env`

**"Erro ao criar pagamento"**
→ Verifique o MERCADO_PAGO_ACCESS_TOKEN. Use credenciais de sandbox para testes.

**"Webhook não processa"**
→ Em desenvolvimento, verifique se está usando ngrok e se a URL está atualizada no MP

**Erro de conexão com banco**
→ Verifique se o Docker está rodando: `docker-compose ps`

---

## 📞 ONDE ALTERAR CADA COISA

| O que alterar | Onde |
|---------------|------|
| Mensagens do bot | `apps/bot/src/index.ts` |
| Lógica de pagamento | `apps/api/src/services/paymentService.ts` |
| Lógica de entrega | `apps/api/src/services/deliveryService.ts` |
| Produtos iniciais | `prisma/seed.ts` |
| Layout do painel | `apps/web/src/components/layout/` |
| Dashboard | `apps/web/src/app/admin/page.tsx` |
| Credenciais do admin padrão | `prisma/seed.ts` + rode `npm run db:seed` |
"# saas-pix-bot" 
