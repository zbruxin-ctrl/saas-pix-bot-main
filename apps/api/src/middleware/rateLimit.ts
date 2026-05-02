/**
 * Rate limiting para proteger endpoints públicos.
 *
 * AUDIT #11: migrado de express-rate-limit (store em memória) para
 * @upstash/ratelimit + @upstash/redis. Em multi-réplica Railway, o store
 * em memória é zerado a cada deploy/instância — com Redis o contador é
 * compartilhado entre todas as réplicas, tornando o rate limit efetivo.
 *
 * Fallback automático para express-rate-limit em memória quando as variáveis
 * UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN não estão configuradas
 * (desenvolvimento local sem Redis). Em produção, sempre usa Redis.
 *
 * Limites preservados dos valores anteriores:
 *   paymentRateLimit  — 10 req / 15 min por IP+telegramId
 *   loginRateLimit    —  5 req / 15 min por IP (skipSuccessfulRequests)
 *   webhookRateLimit  — 100 req / 1 min  por IP
 */
import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';

// ─── Upstash rate limit (Redis) ───────────────────────────────────────────────

let upstashAvailable = false;

type UpstashRatelimitInstance = {
  limit(identifier: string): Promise<{ success: boolean; limit: number; remaining: number; reset: number }>;
};

interface UpstashLimiters {
  payment: UpstashRatelimitInstance;
  login: UpstashRatelimitInstance;
  webhook: UpstashRatelimitInstance;
}

let upstashLimiters: UpstashLimiters | null = null;

// Inicialização lazy — só tenta carregar Upstash se as variáveis existirem.
// Isso evita falha de import em dev sem Redis configurado.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (UPSTASH_URL && UPSTASH_TOKEN) {
  try {
    // Dynamic require para não quebrar build em ambientes sem o pacote
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Ratelimit } = require('@upstash/ratelimit') as typeof import('@upstash/ratelimit');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');

    const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

    upstashLimiters = {
      payment: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, '15 m'),
        prefix: 'rl:payment',
        analytics: false,
      }),
      login: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(5, '15 m'),
        prefix: 'rl:login',
        analytics: false,
      }),
      webhook: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(100, '1 m'),
        prefix: 'rl:webhook',
        analytics: false,
      }),
    };

    upstashAvailable = true;
    console.log('[rateLimit] ✅ Usando Upstash Redis para rate limiting (multi-réplica safe)');
  } catch (err) {
    console.warn('[rateLimit] ⚠️  Falha ao inicializar @upstash/ratelimit — usando fallback em memória:', err);
  }
} else {
  console.warn('[rateLimit] ⚠️  UPSTASH_REDIS_REST_URL/TOKEN não configurados — rate limit em memória (não compartilhado entre réplicas)');
}

// ─── Fallback: express-rate-limit em memória (dev / sem Upstash) ──────────────

const fallbackPaymentLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Muitas requisições. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = req.body as { telegramId?: string };
    return `${req.ip}_${body?.telegramId || 'anon'}`;
  },
});

const fallbackLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  skipSuccessfulRequests: true,
});

const fallbackWebhookLimit = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Rate limit atingido' },
});

// ─── Middleware factory (Upstash ou fallback) ─────────────────────────────────

function makeUpstashMiddleware(
  limiterKey: keyof UpstashLimiters,
  identifierFn: (req: Request) => string,
  fallback: ReturnType<typeof rateLimit>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!upstashAvailable || !upstashLimiters) {
      return fallback(req, res, next);
    }

    try {
      const identifier = identifierFn(req);
      const { success, limit, remaining, reset } = await upstashLimiters[limiterKey].limit(identifier);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', new Date(reset).toISOString());

      if (!success) {
        res.status(429).json({ success: false, error: 'Muitas requisições. Tente novamente em instantes.' });
        return;
      }

      next();
    } catch (err) {
      // Upstash indisponível: fail-open (não bloqueia requisição legítima)
      console.warn('[rateLimit] Upstash indisponível, fail-open:', err);
      next();
    }
  };
}

// ─── Exports públicos ─────────────────────────────────────────────────────────

export const paymentRateLimit = makeUpstashMiddleware(
  'payment',
  (req) => {
    const body = req.body as { telegramId?: string };
    return `${req.ip}_${body?.telegramId || 'anon'}`;
  },
  fallbackPaymentLimit
);

export const loginRateLimit = makeUpstashMiddleware(
  'login',
  (req) => req.ip ?? 'unknown',
  fallbackLoginLimit
);

export const webhookRateLimit = makeUpstashMiddleware(
  'webhook',
  (req) => req.ip ?? 'unknown',
  fallbackWebhookLimit
);
