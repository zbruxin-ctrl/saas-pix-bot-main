/**
 * Testes de session.ts usando um Redis mock em memória.
 * O mock é injetado via vi.mock antes do import real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do módulo redis ANTES de importar session
const store: Record<string, string> = {};
vi.mock('../services/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => store[key] ?? null),
    set: vi.fn(async (key: string, value: string) => { store[key] = value; }),
    del: vi.fn(async (key: string) => { delete store[key]; }),
    setnx: vi.fn(async (key: string, value: string, _ttl?: number) => {
      if (store[key] !== undefined) return false;
      store[key] = value;
      return true;
    }),
  },
}));

import { getSession, saveSession, clearSession } from '../services/session';

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
});

describe('getSession', () => {
  it('retorna sessão padrão idle para usuário novo', async () => {
    const s = await getSession(123);
    expect(s.step).toBe('idle');
  });

  it('retorna sessão salva anteriormente', async () => {
    await saveSession(456, { step: 'awaiting_payment', paymentId: 'pay_001', lastActivityAt: Date.now() });
    const s = await getSession(456);
    expect(s.step).toBe('awaiting_payment');
    expect(s.paymentId).toBe('pay_001');
  });
});

describe('saveSession', () => {
  it('persiste todos os campos', async () => {
    const now = Date.now();
    await saveSession(789, {
      step: 'selecting_product',
      selectedProductId: 'prod_abc',
      firstName: 'Ana',
      lastActivityAt: now,
    });
    const s = await getSession(789);
    expect(s.selectedProductId).toBe('prod_abc');
    expect(s.firstName).toBe('Ana');
  });

  it('atualiza lastActivityAt no save', async () => {
    const before = Date.now();
    await saveSession(100, { step: 'idle', lastActivityAt: 0 });
    const s = await getSession(100);
    expect(s.lastActivityAt).toBeGreaterThanOrEqual(before);
  });
});

describe('clearSession', () => {
  it('reseta step para idle preservando firstName', async () => {
    await saveSession(200, { step: 'awaiting_payment', firstName: 'Carlos', lastActivityAt: Date.now() });
    await clearSession(200, 'Carlos');
    const s = await getSession(200);
    expect(s.step).toBe('idle');
    expect(s.firstName).toBe('Carlos');
    expect(s.paymentId).toBeUndefined();
  });

  it('reseta step para idle sem firstName', async () => {
    await saveSession(300, { step: 'selecting_product', lastActivityAt: Date.now() });
    await clearSession(300);
    const s = await getSession(300);
    expect(s.step).toBe('idle');
  });
});
