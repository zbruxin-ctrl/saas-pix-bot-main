/**
 * pixExpiry.ts — Reagendamento de timers PIX no boot.
 *
 * FIX-PIX-TIMER-MEMORY: timers PIX viviam apenas em memória. Após qualquer
 * redeploy todos os timers eram perdidos e usuários ficavam com PIX "fantasma".
 *
 * Solução:
 *   - schedulePIXExpiry (payments.ts) continua registrando o timer em memória
 *     (para o processo atual), mas agora também persiste
 *     pix_expiry:{userId} = paymentId  no Redis com TTL = segundos restantes.
 *   - restorePixTimers() é chamado uma vez no boot do bot. Varre as chaves
 *     pix_expiry:* no Redis e reagenda os timers para os PIX ainda ativos,
 *     enviando a mensagem de expiração quando o timer disparar.
 *
 * Limitações aceitas:
 *   - O reagendamento depende de ter acesso ao objeto `bot` (Telegraf) no boot,
 *     por isso a função recebe `sendExpiry` como callback.
 *   - Se o processo ficar offline por mais tempo do que o TTL do PIX, o Redis
 *     já terá expirado a chave e o timer não será reagendado (comportamento
 *     correto — PIX já expirou no gateway).
 */
import { redis } from './redis';
import { cancelPIXTimer, registerPIXTimer } from './locks';
import { getSession, clearSession } from './session';

export interface PixExpiryEntry {
  paymentId: string;
  expiresAt: string; // ISO 8601
}

/** Chave Redis para o registro de expiração de um PIX de usuário. */
export function pixExpiryKey(userId: number): string {
  return `pix_expiry:${userId}`;
}

/**
 * Persiste no Redis a entrada de expiração de um PIX.
 * Deve ser chamado em schedulePIXExpiry logo após criar o timer em memória.
 */
export async function persistPixExpiry(
  userId: number,
  paymentId: string,
  expiresAt: string
): Promise<void> {
  const ms  = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return;
  const ttl = Math.ceil(ms / 1000) + 30; // +30s de margem
  const entry: PixExpiryEntry = { paymentId, expiresAt };
  await redis.set(pixExpiryKey(userId), JSON.stringify(entry), ttl).catch(() => {
    // falha silenciosa — o timer em memória ainda funciona para esta instância
    console.warn(`[pixExpiry] Falha ao persistir expiração de PIX para userId=${userId}`);
  });
}

/**
 * Remove a entrada de expiração do Redis quando o PIX for aprovado / cancelado.
 */
export async function clearPixExpiry(userId: number): Promise<void> {
  await redis.del(pixExpiryKey(userId)).catch(() => {});
}

/**
 * Restaura os timers PIX no boot do processo.
 *
 * @param sendExpiry  Callback chamado quando um timer disparar — deve enviar
 *                    a mensagem de expiração ao usuário via Telegram.
 *                    Recebe (userId, paymentId) e retorna Promise<void>.
 */
export async function restorePixTimers(
  sendExpiry: (userId: number, paymentId: string) => Promise<void>
): Promise<void> {
  try {
    // Varre todas as chaves pix_expiry:* no Redis
    const keys = await redis.keys('pix_expiry:*');
    if (!keys || keys.length === 0) return;

    let restored = 0;
    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;

        const entry = JSON.parse(raw) as PixExpiryEntry;
        const userId = parseInt(key.replace('pix_expiry:', ''), 10);
        if (isNaN(userId)) continue;

        const ms = new Date(entry.expiresAt).getTime() - Date.now();
        if (ms <= 0) {
          // PIX já deveria ter expirado durante o downtime — notifica imediatamente
          await sendExpiry(userId, entry.paymentId).catch(() => {});
          await redis.del(key).catch(() => {});
          continue;
        }

        // Reagenda o timer
        const timer = setTimeout(async () => {
          try {
            const session = await getSession(userId);
            if (session.paymentId !== entry.paymentId) return; // já foi resolvido
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
        console.error(`[pixExpiry] Erro ao restaurar chave ${key}:`, err);
      }
    }

    if (restored > 0) {
      console.log(`[pixExpiry] ${restored} timer(s) PIX reagendado(s) no boot.`);
    }
  } catch (err) {
    console.error('[pixExpiry] Erro ao varrer chaves Redis:', err);
  }
}
