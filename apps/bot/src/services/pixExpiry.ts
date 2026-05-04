/**
 * pixExpiry.ts — Persistência e reagendamento de timers PIX no boot.
 *
 * FIX-PIX-TIMER-MEMORY: timers PIX viviam apenas em memória. Após qualquer
 * redeploy todos eram perdidos e usuários ficavam com PIX "fantasma".
 *
 * Estratégia:
 *   - Cada PIX ativo é salvo como pix_expiry:{userId} no Redis com TTL.
 *   - Um Set pix_active_users rastreia quais userIds têm PIX ativo,
 *     pois o RedisAdapter não expe o comando KEYS (sem scan).
 *   - restorePixTimers() é chamado uma vez no boot: lê o Set, busca cada
 *     entrada e reagenda os timers ainda válidos.
 *   - Se o PIX já expirou durante o downtime, sendExpiry é chamado
 *     imediatamente para notificar o usuário.
 */
import { redis } from './redis';
import { cancelPIXTimer, registerPIXTimer } from './locks';
import { getSession, clearSession } from './session';

const ACTIVE_SET_KEY = 'pix_active_users';

export interface PixExpiryEntry {
  paymentId: string;
  expiresAt: string; // ISO 8601
}

function pixExpiryKey(userId: number): string {
  return `pix_expiry:${userId}`;
}

// ─ helpers do Set de usuários ativos ──────────────────────────────────────────────
// Usamos um JSON array salvo como string porque o RedisAdapter só expõe
// get/set/setnx/del — sem SADD/SREM/SMEMBERS nativos.

async function addActiveUser(userId: number): Promise<void> {
  try {
    const raw  = await redis.get(ACTIVE_SET_KEY);
    const ids: number[] = raw ? (JSON.parse(raw) as number[]) : [];
    if (!ids.includes(userId)) ids.push(userId);
    await redis.set(ACTIVE_SET_KEY, JSON.stringify(ids)); // sem TTL — o set é gerenciado manualmente
  } catch { /* falha silenciosa — apenas degrada o reagendamento no boot */ }
}

async function removeActiveUser(userId: number): Promise<void> {
  try {
    const raw = await redis.get(ACTIVE_SET_KEY);
    if (!raw) return;
    const ids = (JSON.parse(raw) as number[]).filter((id) => id !== userId);
    await redis.set(ACTIVE_SET_KEY, JSON.stringify(ids));
  } catch { /* falha silenciosa */ }
}

async function getActiveUsers(): Promise<number[]> {
  try {
    const raw = await redis.get(ACTIVE_SET_KEY);
    return raw ? (JSON.parse(raw) as number[]) : [];
  } catch {
    return [];
  }
}

// ─ API pública ─────────────────────────────────────────────────────────────────────

/**
 * Persiste no Redis a entrada de expiração de um PIX.
 * Chamado em schedulePIXExpiry após criar o timer em memória.
 */
export async function persistPixExpiry(
  userId: number,
  paymentId: string,
  expiresAt: string
): Promise<void> {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return;
  const ttl   = Math.ceil(ms / 1000) + 30; // +30s de margem
  const entry: PixExpiryEntry = { paymentId, expiresAt };
  await Promise.all([
    redis.set(pixExpiryKey(userId), JSON.stringify(entry), ttl).catch(() =>
      console.warn(`[pixExpiry] Falha ao persistir expiração userId=${userId}`)
    ),
    addActiveUser(userId),
  ]);
}

/**
 * Remove a entrada do Redis ao aprovar / cancelar / expirar o PIX.
 */
export async function clearPixExpiry(userId: number): Promise<void> {
  await Promise.all([
    redis.del(pixExpiryKey(userId)).catch(() => {}),
    removeActiveUser(userId),
  ]);
}

/**
 * Restaura os timers PIX no boot do processo.
 *
 * @param sendExpiry Callback que envia a mensagem de expiração ao usuário.
 *                   Recebe (userId, paymentId) e retorna Promise<void>.
 */
export async function restorePixTimers(
  sendExpiry: (userId: number, paymentId: string) => Promise<void>
): Promise<void> {
  const userIds = await getActiveUsers();
  if (userIds.length === 0) return;

  let restored = 0;
  for (const userId of userIds) {
    try {
      const raw = await redis.get(pixExpiryKey(userId));
      if (!raw) {
        await removeActiveUser(userId);
        continue;
      }

      const entry = JSON.parse(raw) as PixExpiryEntry;
      const ms    = new Date(entry.expiresAt).getTime() - Date.now();

      if (ms <= 0) {
        // PIX já expirou durante o downtime — notifica imediatamente
        await sendExpiry(userId, entry.paymentId).catch(() => {});
        await clearPixExpiry(userId);
        continue;
      }

      const timer = setTimeout(async () => {
        try {
          const session = await getSession(userId);
          if (session.paymentId !== entry.paymentId) return;
          cancelPIXTimer(userId);
          await clearPixExpiry(userId);
          await clearSession(userId, session.firstName ?? '');
          await sendExpiry(userId, entry.paymentId);
        } catch (err) {
          console.error(`[pixExpiry] Erro ao expirar PIX userId=${userId}:`, err);
        }
      }, ms);

      registerPIXTimer(userId, timer);
      restored++;
    } catch (err) {
      console.error(`[pixExpiry] Erro ao restaurar userId=${userId}:`, err);
    }
  }

  if (restored > 0) console.log(`[pixExpiry] ${restored} timer(s) PIX reagendado(s) no boot.`);
}
