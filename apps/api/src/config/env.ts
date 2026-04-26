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
  // FIX BUG3: sem default — se não configurado em produção, o sistema detecta e avisa
  // no lugar de silenciosamente descartar todos os webhooks com assinatura "inválida".
  MERCADO_PAGO_WEBHOOK_SECRET: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN é obrigatório'),
  TELEGRAM_BOT_SECRET: z.string().min(16, 'TELEGRAM_BOT_SECRET deve ter pelo menos 16 caracteres'),

  API_URL: z.string().url().default('http://localhost:3001'),
  ADMIN_URL: z.string().url().default('http://localhost:3000'),
  BOT_WEBHOOK_URL: z.string().url().optional(),

  // CORS extra: domínios adicionais separados por vírgula (ex: previews do Vercel específicos)
  ALLOWED_ORIGINS: z.string().optional(),

  // Cloudinary: configure CLOUDINARY_URL no Railway para usar Cloudinary.
  CLOUDINARY_URL: z.string().optional(),

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
