import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';

import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { paymentsRouter } from './routes/payments';
import { webhooksRouter } from './routes/webhooks';
import adminRouter from './routes/admin';
import { telegramRouter } from './routes/telegram';
import { pricingRouter } from './routes/pricing';
import { couponsRouter } from './routes/coupons';
import { referralsRouter } from './routes/referrals';
import { kycRouter } from './routes/kyc';
import { startExpireJob, stopExpireJob } from './jobs/expirePayments';

// build: 2026-05-09
const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

const extraOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  env.ADMIN_URL,
  ...(env.BOT_WEBHOOK_URL ? [env.BOT_WEBHOOK_URL] : []),
  ...(env.NODE_ENV === 'development'
    ? ['http://localhost:3000', 'http://localhost:3001']
    : []),
  ...extraOrigins,
].filter(Boolean) as string[];

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (/^\/https:\/\/[a-z0-9-]+-[a-z0-9-]+-[a-z0-9]+-projects\.vercel\.app$/.test(origin)) return true;
  if (/^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/.test(origin)) return true;
  return allowedOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) callback(null, origin ?? '*');
    else callback(new Error(`CORS: origem nao permitida: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  exposedHeaders: ['Set-Cookie'],
}));

app.use(compression());
app.use(cookieParser(env.COOKIE_SECRET));
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// raw body parser para ambos os prefixos do webhooksRouter
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use('/webhooks',     express.raw({ type: 'application/json', limit: '1mb' }));

app.use('/telegram-webhook', express.json({ limit: '1mb' }));
app.use('/telegram-webhook', telegramRouter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/uploads', express.static('uploads'));

// --- Rota de setup via navegador (GET = formulário, POST = criar admin) ---
const SETUP_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Setup Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:2rem;width:100%;max-width:400px}
    h1{font-size:1.25rem;margin-bottom:1.5rem;color:#fff}
    label{display:block;font-size:.85rem;color:#aaa;margin-bottom:.3rem}
    input{width:100%;padding:.65rem .9rem;background:#111;border:1px solid #333;border-radius:8px;color:#fff;font-size:1rem;margin-bottom:1rem}
    input:focus{outline:none;border-color:#4f98a3}
    button{width:100%;padding:.75rem;background:#4f98a3;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600}
    button:hover{background:#227f8b}
    .msg{margin-top:1rem;padding:.75rem;border-radius:8px;font-size:.9rem;display:none}
    .msg.ok{background:#1e3a1e;color:#6daa45;display:block}
    .msg.err{background:#3a1e1e;color:#dd6974;display:block}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔧 Criar Admin</h1>
    <form id="f">
      <label>SETUP_SECRET (variável do Railway)</label>
      <input type="password" name="secret" placeholder="Ex: qualquercoisa123" required>
      <label>Email</label>
      <input type="email" name="email" placeholder="seuemail@gmail.com" required>
      <label>Senha (mín. 8 caracteres)</label>
      <input type="password" name="password" placeholder="Mínimo 8 caracteres" required minlength="8">
      <button type="submit">Criar / Redefinir Admin</button>
    </form>
    <div class="msg" id="msg"></div>
  </div>
  <script>
    document.getElementById('f').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const msg = document.getElementById('msg');
      msg.className = 'msg';
      msg.textContent = 'Aguarde...';
      msg.style.display = 'block';
      try {
        const r = await fetch('/setup-admin', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(Object.fromEntries(fd))
        });
        const d = await r.json();
        if (d.success) {
          msg.className = 'msg ok';
          msg.textContent = '✅ ' + d.message;
        } else {
          msg.className = 'msg err';
          msg.textContent = '❌ ' + (d.error || 'Erro desconhecido');
        }
      } catch(err) {
        msg.className = 'msg err';
        msg.textContent = '❌ Erro de conexão: ' + err;
      }
    });
  </script>
</body>
</html>`;

app.get('/setup-admin', (req, res) => {
  if (!process.env.SETUP_SECRET) { res.status(404).send('Not found'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.send(SETUP_HTML);
});

app.post('/setup-admin', async (req, res) => {
  const setupSecret = process.env.SETUP_SECRET;
  if (!setupSecret) { res.status(404).json({ error: 'Rota nao disponivel' }); return; }

  const { secret, email, password } = req.body as Record<string, string>;
  if (secret !== setupSecret) { res.status(403).json({ error: 'Secret invalido' }); return; }
  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: 'Informe email e password (minimo 8 caracteres)' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.adminUser.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, isActive: true },
    create: { email: email.toLowerCase(), passwordHash, name: 'Admin Principal', role: 'SUPERADMIN', isActive: true },
  });

  logger.info(`[setup-admin] Admin criado/atualizado: ${admin.email}`);
  res.json({ success: true, message: `Admin ${admin.email} criado! Remova SETUP_SECRET do Railway agora.` });
});

app.post('/internal/register-bot', (req, res) => {
  const secret = req.headers['x-bot-secret'];
  if (env.TELEGRAM_BOT_SECRET && secret !== env.TELEGRAM_BOT_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  logger.info('[internal] Bot registrado e online.');
  res.json({ ok: true });
});

app.use('/api/auth',      authRouter);
app.use('/api/payments',  paymentsRouter);
app.use('/api/webhooks',  webhooksRouter);
app.use('/webhooks',      webhooksRouter);  // alias sem /api — usado pelo MercadoPago
app.use('/api/admin',     adminRouter);
app.use('/api/pricing',   pricingRouter);
app.use('/api/coupons',   couponsRouter);
app.use('/api/referrals', referralsRouter);
app.use('/api/kyc',       kycRouter);       // KYC webhooks: Socure + Veriff

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info(`API rodando na porta ${env.PORT}`);
  logger.info(`Ambiente: ${env.NODE_ENV}`);
  startExpireJob();
});

async function shutdown(signal: string) {
  logger.info(`${signal} recebido. Encerrando servidor...`);
  stopExpireJob();
  server.close(async () => { await prisma.$disconnect(); process.exit(0); });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
