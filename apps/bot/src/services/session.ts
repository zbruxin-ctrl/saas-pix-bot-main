/**
 * Gerenciamento de sessões de usuário via Redis (Upstash HTTP).
 * Em dev sem Upstash, usa fallback em memória (InMemoryRedis no redis.ts).
 *
 * FEAT: usedCoupons — lista de cupons já utilizados pelo usuário (por código).
 *       Garante que cada cupão possa ser usado apenas 1x por conta.
 * FIX #7: clearSession preserva usedCoupons da sessão atual quando não fornecido.
 * FIX #6: UserSession inclui referralCode (salvo no /start a partir do startPayload).
 */
import { redis } from './redis';

export interface UserSession {
  step: 'idle' | 'selecting_product' | 'awaiting_payment' | 'awaiting_deposit_amount' | 'awaiting_coupon' | 'awaiting_quantity';
  selectedProductId?: string;
  paymentId?: string;
  pixExpiresAt?: string;
  pixQrCodeText?: string;
  depositPaymentId?: string;
  depositMessageId?: number;
  mainMessageId?: number;
  firstName?: string;
  /** Código de indicação capturado do startPayload — propagado ao createPayment */
  referralCode?: string;
  /** Nome do produto pendente — salvo ao criar PIX para usar na mensagem de entrega */
  pendingProductName?: string;
  lastActivityAt: number;
  pendingProductId?: string;
  pendingCoupon?: string | null;
  pendingCouponDiscount?: number;
  pendingQty?: number;
  products?: never;
  /** Lista de códigos de cupão já utilizados por este usuário */
  usedCoupons?: string[];
}

function getTTL(step: UserSession['step']): number {
  switch (step) {
    case 'awaiting_payment':
      return 35 * 60;
    case 'awaiting_deposit_amount':
    case 'awaiting_coupon':
    case 'awaiting_quantity':
      return 10 * 60;
    default:
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
    await redis.set(sessionKey(userId), JSON.stringify(session), getTTL(session.step));
    return session;
  }
  return { step: 'idle', lastActivityAt: Date.now(), usedCoupons: [] };
}

export async function saveSession(userId: number, session: UserSession): Promise<void> {
  session.lastActivityAt = Date.now();
  const ttl = getTTL(session.step);
  await redis.set(sessionKey(userId), JSON.stringify(session), ttl);
}

/**
 * Reseta a sessão para idle, preservando firstName, referralCode e usedCoupons.
 * FIX #7: lê usedCoupons da sessão atual antes de limpar, para nunca perdê-los.
 */
export async function clearSession(userId: number, keepFirstName?: string): Promise<void> {
  // Lê a sessão atual para preservar usedCoupons e referralCode
  const current = await getSession(userId);
  await saveSession(userId, {
    step: 'idle',
    firstName: keepFirstName ?? current.firstName,
    referralCode: current.referralCode,
    lastActivityAt: Date.now(),
    usedCoupons: current.usedCoupons ?? [],
  });
}

/** Registra um cupão como utilizado pelo usuário. Persiste mesmo após clearSession. */
export async function markCouponUsed(userId: number, couponCode: string): Promise<void> {
  const session = await getSession(userId);
  const used = session.usedCoupons ?? [];
  const upper = couponCode.toUpperCase();
  if (!used.includes(upper)) {
    used.push(upper);
  }
  session.usedCoupons = used;
  await saveSession(userId, session);
}

/** Verifica se o usuário já usou um determinado cupão. */
export async function hasCouponBeenUsed(userId: number, couponCode: string): Promise<boolean> {
  const session = await getSession(userId);
  const used = session.usedCoupons ?? [];
  return used.includes(couponCode.toUpperCase());
}
