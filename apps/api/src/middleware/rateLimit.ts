// Rate limiting para proteger endpoints públicos
import rateLimit from 'express-rate-limit';

// Limite geral para criação de pagamentos
export const paymentRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // máximo 10 requisições por janela
  message: {
    success: false,
    error: 'Muitas requisições. Tente novamente em 15 minutos.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Identifica por IP + telegramId
  keyGenerator: (req) => {
    const body = req.body as { telegramId?: string };
    return `${req.ip}_${body?.telegramId || 'anon'}`;
  },
});

// Limite para login (anti brute-force)
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
  },
  skipSuccessfulRequests: true, // não conta tentativas bem-sucedidas
});

// Limite para webhooks (mais permissivo, vem do Mercado Pago)
export const webhookRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 100,
  message: {
    success: false,
    error: 'Rate limit atingido',
  },
});
