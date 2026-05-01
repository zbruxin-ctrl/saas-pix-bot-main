/**
 * Validação de variáveis de ambiente do bot.
 *
 * PRODUÇÃO: UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN são OBRIGATÓRIOS.
 * O bot não sobe sem Redis configurado em produção — evita perda silenciosa
 * de sessões e timers de PIX em caso de restart (FIX #1).
 *
 * DESENVOLVIMENTO: as vars do Upstash são opcionais; o redis.ts usa fallback
 * em memória com aviso explícito no console.
 */
import { z } from 'zod';
import 'dotenv/config';

const isProduction = process.env.NODE_ENV === 'production';

// Helper: campo obrigatório em produção, opcional em dev/test
const requiredInProd = (schema: z.ZodString) =>
  isProduction ? schema.min(1) : schema.optional();

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_BOT_SECRET: z.string().optional(),
    BOT_WEBHOOK_URL: z.string().url().optional(),
    API_URL: z.string().url().optional(),
    API_BASE_URL: z.string().url().optional(),
    API_SECRET: z.string().optional(),

    // Suporte: número do WhatsApp para contato (ex: 5511999999999)
    SUPPORT_PHONE: z.string().default(''),

    // Redis (Upstash) — OBRIGATÓRIO em produção
    UPSTASH_REDIS_REST_URL: requiredInProd(z.string().url()),
    UPSTASH_REDIS_REST_TOKEN: requiredInProd(z.string()),

    // Legado (não usado pelo adaptador HTTP do Upstash)
    REDIS_URL: z.string().optional(),

    SENTRY_DSN: z.string().url().optional(),
  })
  .transform((v) => ({
    ...v,
    API_URL: v.API_URL ?? v.API_BASE_URL ?? '',
  }));

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Variáveis de ambiente inválidas:');
    console.error(result.error.format());
    if (isProduction) {
      console.error(
        '\n🔴 Em PRODUÇÃO as variáveis UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN são OBRIGATÓRIAS.\n' +
        '   Sem Redis, sessões e timers de PIX são perdidos a cada restart do bot.\n' +
        '   Configure em: https://console.upstash.com\n'
      );
    }
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnv();
