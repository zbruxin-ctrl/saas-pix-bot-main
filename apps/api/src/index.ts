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
import { startExpireJob, stopExpireJob } from './jobs/expirePayments';

// build: 2026-04-29
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
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));

// Rota do webhook do Telegram precisa de JSON parseado
app.use('/telegram-webhook', express.json({ limit: '1mb' }));
app.use('/telegram-webhook', telegramRouter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploads locais (fallback quando Cloudinary não está configurado)
app.use('/uploads', express.static('uploads'));

// --- Rota de setup inicial ---
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
  res.json({ success: true, message: `Admin ${admin.email} pronto. Remova SETUP_SECRET do Railway agora.` });
});

// --- Rota interna: bot notifica que subiu e está pronto ---
// Não há lógica de estado aqui — apenas health-check de conectividade bot→API.
// O handler de updates do Telegram roda dentro do processo do bot (via webhook HTTP direto).
app.post('/internal/register-bot', (req, res) => {
  const secret = req.headers['x-bot-secret'];
  if (env.TELEGRAM_BOT_SECRET && secret !== env.TELEGRAM_BOT_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  logger.info('[internal] Bot registrado e online.');
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/admin', adminRouter);

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
