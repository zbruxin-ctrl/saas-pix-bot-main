/**
 * Gerenciamento de sessões de usuário via Redis (Upstash HTTP).
 * Em dev sem Upstash, usa fallback em memória (InMemoryRedis no redis.ts).
 *
 * P1 FIX: sessions migradas para Redis — sem perda de contexto em restart.
 * FIX #1: campo pixExpiresAt adicionado — permite re-agendar o timer de
 *         expiração do PIX ao receber /start após um restart do bot.
 * FIX-BUILD: adiciona 'awaiting_coupon' ao step + pendingProductId/pendingCoupon à interface
 * FIX-COUPON-DISCOUNT: adiciona pendingCouponDiscount para persistir valor de desconto entre telas
 * FEAT-COPYPASTE-CHECK: adiciona pixQrCodeText para reenviar copia e cola ao verificar pagamento
 * FIX-SESSION-TTL: TTL dinâmico por estado — sessões com PIX pendente expiram
 *   em 35min (margem sobre os 30min do PIX) em vez de ficar 1h no Redis.
 * AUDIT #14: getSession renova TTL do Redis (via saveSession) ao carregar sessão
 *   existente — sem isso, sessões de usuários ativos podiam expirar no Redis se
 *   o caller não chamasse saveSession ao final da operação.
 */
import { redis } from './redis';

export interface UserSession {
  step: 'idle' | 'selecting_product' | 'awaiting_payment' | 'awaiting_deposit_amount' | 'awaiting_coupon';
  selectedProductId?: string;
  paymentId?: string;
  /** ISO string com a data/hora de expiração do PIX em aberto (FIX #1) */
  pixExpiresAt?: string;
  /** Copia e Cola do PIX gerado — reexibido ao verificar pagamento pendente */
  pixQrCodeText?: string;
  depositPaymentId?: string;
  depositMessageId?: number;
  mainMessageId?: number;
  firstName?: string;
  lastActivityAt: number;
  /** Produto pendente enquanto aguarda input de cupom */
  pendingProductId?: string;
  /** Cupom digitado pelo usuário, antes de confirmar pagamento */
  pendingCoupon?: string | null;
  /** Valor do desconto do cupom (em reais) para exibir na tela de pagamento */
  pendingCouponDiscount?: number;
  /** Armazena produtos em cache local na sessão para evitar re-fetch */
  products?: never;
}

/** TTL em segundos por estado da sessão */
function getTTL(step: UserSession['step']): number {
  switch (step) {
    case 'awaiting_payment':
      // PIX expira em 30min — 5min de margem para o timer de expiração limpar antes
      return 35 * 60;
    case 'awaiting_deposit_amount':
    case 'awaiting_coupon':
      // Inputs curtos: usuário não precisa de mais de 10min para digitar
      return 10 * 60;
    default:
      // idle / selecting_product: 1h (comportamento anterior)
      return 60 * 60;
  }
}

function sessionKey(userId: number): string {
  return `session:${userId}`;
}

export async function getSession(userId: number): Promise<UserSession> {
  const raw = await redis.get(sessionKey(userId));
  if (raw) {
    const session: UserSession = JSON.parse(raw);
    session.lastActivityAt = Date.now();
    // AUDIT #14: renova TTL no Redis a cada leitura de sessão existente.
    // Sem isso, sessões de usuários ativos podiam expirar se o caller
    // não fizesse saveSession ao final da operação (ex: leituras somente).
    await redis.set(sessionKey(userId), JSON.stringify(session), getTTL(session.step));
    return session;
  }
  return { step: 'idle', lastActivityAt: Date.now() };
}

export async function saveSession(userId: number, session: UserSession): Promise<void> {
  session.lastActivityAt = Date.now();
  const ttl = getTTL(session.step);
  await redis.set(sessionKey(userId), JSON.stringify(session), ttl);
}

export async function clearSession(userId: number, keepFirstName?: string): Promise<void> {
  await saveSession(userId, {
    step: 'idle',
    firstName: keepFirstName,
    lastActivityAt: Date.now(),
  });
}
