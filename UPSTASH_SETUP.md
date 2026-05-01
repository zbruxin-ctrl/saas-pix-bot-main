# Configuração do Upstash Redis

O bot usa Redis (via Upstash) para:
- **Sessões de usuário** — contexto do fluxo de compra (produto selecionado, pagamento em aberto)
- **Timer de expiração do PIX (FIX #1)** — ao reiniciar o bot, o timer é re-agendado usando `pixExpiresAt` salvo na sessão
- **Deduplicação de updates** — evita processar o mesmo update do Telegram duas vezes
- **Locks distribuídos** — evita race conditions em pagamentos simultâneos

**Em produção, Redis é obrigatório.** O bot não sobe sem ele.

---

## Passo a Passo

### 1. Criar o banco no Upstash

1. Acesse [console.upstash.com](https://console.upstash.com)
2. Clique em **Create Database**
3. Escolha:
   - **Type:** Redis
   - **Name:** `saas-pix-bot` (ou qualquer nome)
   - **Region:** escolha a mais próxima do Railway (ex: `us-east-1` ou `sa-east-1`)
   - **Plan:** Free (suficiente para produção com volume baixo/médio)
4. Clique em **Create**

### 2. Copiar as credenciais

1. Na página do banco, clique na aba **REST API**
2. Copie:
   - `UPSTASH_REDIS_REST_URL` — começa com `https://`
   - `UPSTASH_REDIS_REST_TOKEN` — string longa

### 3. Configurar no Railway

1. Acesse seu projeto no [Railway](https://railway.app)
2. Clique no serviço do **bot**
3. Vá em **Variables**
4. Adicione as duas variáveis:
   ```
   UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
   UPSTASH_REDIS_REST_TOKEN=xxxx
   ```
5. O Railway vai fazer redeploy automaticamente

### 4. Verificar

No log do Railway, você deve ver:
```
[redis] ✅ Usando Upstash Redis (HTTP)
```

Se aparecer o aviso de fallback em memória, as variáveis não foram carregadas corretamente.

---

## Configuração local (.env)

Copie `.env.example` para `.env` e preencha:

```env
UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxx
```

Em desenvolvimento, se não quiser configurar Upstash, deixe em branco — o bot usa
fallback em memória com aviso no console. **Não use isso em produção.**

---

## Como o FIX #1 funciona

Quando um usuário gera um PIX:
1. A sessão é salva no Redis com `step: 'awaiting_payment'`, `paymentId` e `pixExpiresAt`
2. Um `setTimeout` de 30 min é agendado em memória
3. Se o bot reiniciar, o `setTimeout` é perdido — mas a sessão ainda está no Redis
4. Quando o usuário envia `/start`, o handler detecta `step === 'awaiting_payment'` e chama `schedulePIXExpiry` com o tempo restante calculado a partir de `pixExpiresAt`
5. O timer é re-agendado com precisão — sem avisar o usuário de um PIX que já expirou ou foi pago

Sem Redis, a sessão é perdida no restart e o usuário fica "preso" sem conseguir avançar.
