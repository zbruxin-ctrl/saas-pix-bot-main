/**
 * Gerenciamento de sessões de usuário via Redis (Upstash HTTP).
 * Em dev sem Upstash, usa fallback em memória (InMemoryRedis no redis.ts).
 * TTL: 1 hora de inatividade.
 *
 * P1 FIX: sessions migradas para Redis — sem perda de contexto em restart.
 * FIX #1: campo pixExpiresAt adicionado — permite re-agendar o timer de
 *         expiração do PIX ao receber /start após um restart do bot.
 * FIX-BUILD: adiciona 'awaiting_coupon' ao step + pendingProductId/pendingCoupon à interface
 * FIX-COUPON-DISCOUNT: adiciona pendingCouponDiscount para persistir valor de desconto entre telas
 */
import { redis } from './redis';

export interface UserSession {
  step: 'idle' | 'selecting_product' | 'awaiting_payment' | 'awaiting_deposit_amount' | 'awaiting_coupon';
  selectedProductId?: string;
  paymentId?: string;
  /** ISO string com a data/hora de expiração do PIX em aberto (FIX #1) */
  pixExpiresAt?: string;
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

const SESSION_TTL_SECONDS = 3600; // 1 hora

function sessionKey(userId: number): string {
  return `session:${userId}`;
}

export async function getSession(userId: number): Promise<UserSession> {
  const raw = await redis.get(sessionKey(userId));
  if (raw) {
    const session: UserSession = JSON.parse(raw);
    session.lastActivityAt = Date.now();
    return session;
  }
  return { step: 'idle', lastActivityAt: Date.now() };
}

export async function saveSession(userId: number, session: UserSession): Promise<void> {
  session.lastActivityAt = Date.now();
  await redis.set(sessionKey(userId), JSON.stringify(session), SESSION_TTL_SECONDS);
}

export async function clearSession(userId: number, keepFirstName?: string): Promise<void> {
  await saveSession(userId, {
    step: 'idle',
    firstName: keepFirstName,
    lastActivityAt: Date.now(),
  });
}
