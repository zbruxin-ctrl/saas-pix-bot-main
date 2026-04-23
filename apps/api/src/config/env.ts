// Carrega o arquivo .env antes de qualquer validação
import { config } from 'dotenv';
import path from 'path';
// Caminho relativo: apps/api/src/config/ -> raiz do projeto
config({ path: path.resolve(__dirname, '../../../../.env') });

// Validação e tipagem das variáveis de ambiente
// A aplicação NÃO inicia se alguma variável obrigatória estiver faltando

import { z } from 'zod';

const envSchema = z.object({
  // Servidor
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3001').transform(Number),

  // Banco de dados
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),

  // JWT e Cookies
  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter pelo menos 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET deve ter pelo menos 32 caracteres'),

  // Mercado Pago
  MERCADO_PAGO_ACCESS_TOKEN: z.string().min(1, 'MERCADO_PAGO_ACCESS_TOKEN é obrigatório'),
  // Opcional em desenvolvimento; obrigatório em produção para validar assinaturas do webhook
  MERCADO_PAGO_WEBHOOK_SECRET: z.string().default('dev_placeholder_troque_em_producao'),

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN é obrigatório'),
  TELEGRAM_BOT_SECRET: z.string().min(16, 'TELEGRAM_BOT_SECRET deve ter pelo menos 16 caracteres'),

  // URLs
  API_URL: z.string().url().default('http://localhost:3001'),
  ADMIN_URL: z.string().url().default('http://localhost:3000'),
  BOT_WEBHOOK_URL: z.string().url().optional(),

  // Redis (opcional)
  REDIS_URL: z.string().optional(),
});

// Valida e exporta as variáveis de ambiente
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
