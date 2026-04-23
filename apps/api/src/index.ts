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
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { paymentsRouter } from './routes/payments';
import { webhooksRouter } from './routes/webhooks';
<<<<<<< HEAD
import adminRouter from './routes/admin';
=======
import { adminRouter } from './routes/admin';
>>>>>>> a4ba2a08fda8eebc6f3ab2989f5f9326189aee05

const app = express();

// ─── Segurança ─────────────────────────────────────────────────────────────
<<<<<<< HEAD
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// Em desenvolvimento permite localhost; em produção só URLs configuradas
const allowedOrigins =
  env.NODE_ENV === 'development'
    ? ['http://localhost:3000', env.ADMIN_URL]
    : [env.ADMIN_URL, env.BOT_WEBHOOK_URL].filter(Boolean) as string[];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  })
);
=======
app.use(helmet({
  contentSecurityPolicy: false, // Desabilitado para uso com painel admin
}));

// Em desenvolvimento permite sempre localhost:3000; em produção só as URLs configuradas
const allowedOrigins = env.NODE_ENV === 'development'
  ? ['http://localhost:3000', env.ADMIN_URL]
  : [env.ADMIN_URL, env.BOT_WEBHOOK_URL].filter(Boolean) as string[];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
}));
>>>>>>> a4ba2a08fda8eebc6f3ab2989f5f9326189aee05

// ─── Middlewares gerais ────────────────────────────────────────────────────
app.use(compression());
app.use(cookieParser(env.COOKIE_SECRET));
<<<<<<< HEAD
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// Body parser (webhooks precisam raw)
=======
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// Body parser com limite para webhooks (precisam de raw body)
>>>>>>> a4ba2a08fda8eebc6f3ab2989f5f9326189aee05
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Rotas ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/admin', adminRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Handler de erros ─────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Inicialização ─────────────────────────────────────────────────────────
const server = app.listen(env.PORT, () => {
  logger.info(`🚀 API rodando na porta ${env.PORT}`);
  logger.info(`🌍 Ambiente: ${env.NODE_ENV}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM recebido. Encerrando servidor...');
  server.close(() => {
    logger.info('Servidor encerrado.');
    process.exit(0);
  });
});

export default app;
