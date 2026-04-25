import { config } from 'dotenv';
import path from 'path';

// Em produção as variáveis já vêm injetadas pela plataforma (Railway/Render/Coolify)
// Em desenvolvimento carrega o .env da raiz do monorepo
// Tenta múltiplos caminhos para cobrir tanto `ts-node src/` quanto `node dist/`
if (process.env.NODE_ENV !== 'production') {
  const candidates = [
    path.resolve(process.cwd(), '.env'),                     // raiz onde o processo foi iniciado
    path.resolve(__dirname, '../../../../.env'),             // relativo ao src/config (ts-node)
    path.resolve(__dirname, '../../../../../.env'),          // relativo ao dist/config (node)
    path.resolve(__dirname, '../../.env'),                   // dentro de apps/api
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
  MERCADO_PAGO_WEBHOOK_SECRET: z.string().default('dev_placeholder_troque_em_producao'),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN é obrigatório'),
  TELEGRAM_BOT_SECRET: z.string().min(16, 'TELEGRAM_BOT_SECRET deve ter pelo menos 16 caracteres'),

  API_URL: z.string().url().default('http://localhost:3001'),
  ADMIN_URL: z.string().url().default('http://localhost:3000'),
  BOT_WEBHOOK_URL: z.string().url().optional(),

  REDIS_URL: z.string().optional(),
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
