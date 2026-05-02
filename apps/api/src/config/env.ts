import { config } from 'dotenv';
import path from 'path';

// Em produção as variáveis já vêm injetadas pela plataforma (Railway/Render/Coolify)
// Em desenvolvimento carrega o .env da raiz do monorepo
if (process.env.NODE_ENV !== 'production') {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../../.env'),
    path.resolve(__dirname, '../../../../../.env'),
    path.resolve(__dirname, '../../.env'),
  ];

  for (const p of candidates) {
    const result = config({ path: p });
    if (result.parsed) {
      console.log(`[env] .env carregado de: ${p}`);
      break;
    }
  }
}

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3001').transform(Number),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter pelo menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET deve ter pelo menos 32 caracteres'),

  MERCADO_PAGO_ACCESS_TOKEN: z.string().min(1, 'MERCADO_PAGO_ACCESS_TOKEN é obrigatório'),
  MERCADO_PAGO_WEBHOOK_SECRET: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN é obrigatório'),
  TELEGRAM_BOT_SECRET: z.string().min(16, 'TELEGRAM_BOT_SECRET deve ter pelo menos 16 caracteres'),

  API_URL: z.string().url().default('http://localhost:3001'),
  ADMIN_URL: z.string().url().default('http://localhost:3000'),
  BOT_WEBHOOK_URL: z.string().url().optional(),

  // URL pública ou interna do bot — usada pela API para invalidar o cache de produtos
  // instantaneamente após create/update/delete no painel admin.
  // Exemplo Railway: https://saas-pix-bot-production.up.railway.app
  // Sem essa var, o fallback de TTL 30s ainda funciona automaticamente.
  BOT_INTERNAL_URL: z.string().url().optional(),

  ALLOWED_ORIGINS: z.string().optional(),
  CLOUDINARY_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // ─── FEAT #3: Configurações do bot via env var (Railway) ──────────────────
  // Todas opcionais — o painel admin sobrescreve via banco quando não definidas aqui.
  // Defina no Railway para fixar um valor independente do banco de dados.
  SUPPORT_PHONE_NUMBER: z.string().optional(),  // Ex: "5511999990000" (sem + ou espaços)
  BOT_WELCOME_MESSAGE:  z.string().optional(),  // Mensagem de boas-vindas do /start
  BOT_START_MESSAGE:    z.string().optional(),  // Mensagem após o primeiro /start
  BOT_MAINTENANCE_MODE: z.enum(['true', 'false']).optional(), // Modo manutenção
  BOT_MAINTENANCE_MESSAGE: z.string().optional(), // Mensagem durante manutenção
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Erro nas variáveis de ambiente:');
    result.error.errors.forEach((err) => {
      console.error(`   ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnv();
export type Env = typeof env;
