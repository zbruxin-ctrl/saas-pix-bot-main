/**
 * Locks distribuídos via Redis (SET NX) — Upstash HTTP.
 * Funciona corretamente com múltiplas instâncias do bot.
 *
 * P1 FIX: locks migrados para Redis — sem race condition com 2+ instâncias.
 * P1 FIX: processedUpdateIds migrado para Redis — sem duplicatas em restart.
 * AUDIT #8: acquireLock retorna token UUID único; releaseLock verifica ownership
 *           antes de deletar — evita que processo A delete lock adquirido por B
 *           quando o TTL expirou durante processamento longo.
 * AUDIT #4: mapa pixTimers exportado com registerPIXTimer / cancelPIXTimer —
 *           evita acúmulo de setTimeout órfãos (memory leak) e permite cancelar
 *           timer ao aprovar/cancelar pagamento sem esperar o setTimeout disparar.
 */
import { redis } from './redis';
import { randomUUID } from 'crypto';

/**
 * Tenta adquirir um lock. Retorna o token único se adquiriu, null se já estava bloqueado.
 * @param key        Identificador único do lock (ex: `pay:${userId}`, `cancel:${paymentId}`)
 * @param ttlSeconds Tempo máximo de vida do lock em segundos
 */
export async function acquireLock(key: string, ttlSeconds = 30): Promise<string | null> {
  const token = randomUUID();
  const acquired = await redis.setnx(`lock:${key}`, token, ttlSeconds);
  return acquired ? token : null;
}

/**
 * Libera um lock apenas se o token bater com o valor armazenado.
 * Se o lock expirou e outro processo o adquiriu, NÃO deleta o lock alheio.
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  const current = await redis.get(`lock:${key}`);
  if (current === token) {
    await redis.del(`lock:${key}`);
  }
  // current !== token → lock expirou ou foi adquirido por outro processo — não deleta
}

/**
 * Verifica se um update_id já foi processado (idempotência de webhooks).
 * Retorna true se é NOVO (pode processar), false se já foi visto.
 * TTL 5 minutos — Telegram reenvia por no máximo 24h, mas IDs recentes bastam.
 */
export async function markUpdateProcessed(updateId: number): Promise<boolean> {
  return redis.setnx(`update:${updateId}`, '1', 300);
}

// ─── Mapa de timers PIX (AUDIT #4) ──────────────────────────────────────────
// Armazena o handle do setTimeout por userId para permitir cancelamento explícito
// e evitar acúmulo de timers órfãos quando o usuário gera múltiplos PIX.

const pixTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Registra o handle de um timer PIX, cancelando qualquer timer anterior
 * do mesmo userId antes de registrar o novo.
 */
export function registerPIXTimer(
  userId: number,
  timer: ReturnType<typeof setTimeout>
): void {
  const existing = pixTimers.get(userId);
  if (existing) clearTimeout(existing);
  pixTimers.set(userId, timer);
}

/**
 * Cancela e remove o timer PIX do userId, se existir.
 * Deve ser chamado ao aprovar, cancelar ou expirar um pagamento.
 */
export function cancelPIXTimer(userId: number): void {
  const t = pixTimers.get(userId);
  if (t) {
    clearTimeout(t);
    pixTimers.delete(userId);
  }
}
