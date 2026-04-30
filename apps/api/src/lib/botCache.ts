// botCache.ts — notifica o bot para invalidar o cache de produtos em memória
//
// Como usar em adminProducts.ts (e qualquer rota que mute produtos):
//
//   import { notifyBotProductCacheInvalidation } from '../lib/botCache';
//
//   // após prisma.product.create / update / delete / updateMany:
//   notifyBotProductCacheInvalidation(); // fire-and-forget, não bloqueia
//
// Requer env var BOT_INTERNAL_URL na API (URL pública do bot no Railway).
// Sem essa var a função retorna silenciosamente — o fallback TTL 30s cobre.
import { env } from '../config/env';
import { logger } from './logger';

export function notifyBotProductCacheInvalidation(): void {
  if (!env.BOT_INTERNAL_URL) return;

  // fire-and-forget — não deve bloquear nem falhar a resposta do admin
  fetch(`${env.BOT_INTERNAL_URL}/internal/cache/invalidate-products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bot-secret': env.TELEGRAM_BOT_SECRET,
    },
    signal: AbortSignal.timeout(3000),
  })
    .then(() => {
      logger.info('[botCache] Cache de produtos do bot invalidado com sucesso');
    })
    .catch((err: unknown) => {
      logger.warn('[botCache] Falha ao notificar bot para invalidar cache de produtos:', err);
    });
}
