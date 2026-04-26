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
import { startExpireJob, stopExpireJob } from './jobs/expirePayments';

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

const fixedOrigins = env.NODE_ENV === 'development'
  ? ['http://localhost:3000', 'http://localhost:3001', env.ADMIN_URL]
  : [env.ADMIN_URL, env.BOT_WEBHOOK_URL].filter(Boolean) as string[];

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (fixedOrigins.includes(origin)) return true;
  if (origin.endsWith('.vercel.app')) return true;
  return false;
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Rota de setup inicial ---
// Uso: GET /setup-admin?secret=SETUP_SECRET&email=admin@x.com&password=Senha123
// Remova SETUP_SECRET do Railway depois de usar
app.get('/setup-admin', async (req, res) => {
  const setupSecret = process.env.SETUP_SECRET;
  if (!setupSecret) { res.status(404).json({ error: 'Rota nao disponivel' }); return; }

  const { secret, email, password } = req.query as Record<string, string>;
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
