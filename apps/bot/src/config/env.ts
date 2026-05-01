import { z } from 'zod';
import 'dotenv/config';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_SECRET: z.string().optional(),
  BOT_WEBHOOK_URL: z.string().url().optional(),
  API_BASE_URL: z.string().url(),
  API_SECRET: z.string().min(1),
  REDIS_URL: z.string().optional(),
  SENTRY_DSN: z.string().url().optional(),
});

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
