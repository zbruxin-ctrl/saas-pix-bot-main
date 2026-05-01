import { z } from 'zod';
import 'dotenv/config';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_SECRET: z.string().optional(),
  BOT_WEBHOOK_URL: z.string().url().optional(),
  /** URL base da API interna (aceita tanto API_URL quanto API_BASE_URL para compatibilidade) */
  API_URL: z.string().url().optional(),
  API_BASE_URL: z.string().url().optional(),
  API_SECRET: z.string().min(1),
  /** Upstash Redis — obrigatório em produção, opcional em dev (usa fallback em memória) */
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  REDIS_URL: z.string().optional(),
  SENTRY_DSN: z.string().url().optional(),
}).transform((v) => ({
  ...v,
  // Normaliza: usa API_URL se existir, senão API_BASE_URL
  API_URL: v.API_URL ?? v.API_BASE_URL ?? '',
}));

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Variáveis de ambiente inválidas:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnv();
