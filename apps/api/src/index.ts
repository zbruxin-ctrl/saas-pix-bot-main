// Ponto de entrada da API
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

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

// ─── Segurança ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// Origens fixas permitidas (env vars)
const fixedOrigins = env.NODE_ENV === 'development'
  ? ['http://localhost:3000', 'http://localhost:3001', env.ADMIN_URL]
  : [env.ADMIN_URL, env.BOT_WEBHOOK_URL].filter(Boolean) as string[];

// Função que valida origem dinamicamente
// Aceita origens fixas + qualquer subdomínio *.vercel.app (previews e deployments)
function isOriginAllowed(origin: string | undefined): boolean {
  // ✅ Permite chamadas servidor-a-servidor (proxy Next.js não envia Origin)
  if (!origin) return true;
  if (fixedOrigins.includes(origin)) return true;
  if (origin.endsWith('.vercel.app')) return true;
  return false;
}

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, origin ?? '*'); // reflete a origin exata (obrigatório com credentials)
    } else {
      callback(new Error(`CORS: origem não permitida: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  exposedHeaders: ['Set-Cookie'],
}));

// ─── Middlewares gerais ────────────────────────────────────────────────────────────
app.use(compression());
app.use(cookieParser(env.COOKIE_SECRET));
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// Body parser (webhooks precisam raw)
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/admin', adminRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Handler de erros ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Inicialização ───────────────────────────────────────────────────────────────────
const server = app.listen(env.PORT, () => {
  logger.info(`🚀 API rodando na porta ${env.PORT}`);
  logger.info(`🌍 Ambiente: ${env.NODE_ENV}`);
  startExpireJob();
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} recebido. Encerrando servidor...`);
  stopExpireJob();
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Servidor encerrado.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
