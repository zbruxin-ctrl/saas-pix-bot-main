import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { acquireLock, releaseLock, markUpdateProcessed } from '../services/locks';

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
});

describe('acquireLock', () => {
  it('adquire lock se não existir', async () => {
    const token = await acquireLock('pay:1');
    expect(token).not.toBeNull();
  });

  it('bloqueia segunda tentativa no mesmo key', async () => {
    await acquireLock('pay:2');
    const second = await acquireLock('pay:2');
    expect(second).toBeNull();
  });

  it('libera lock e permite nova aquisição', async () => {
    const token = await acquireLock('pay:3');
    await releaseLock('pay:3', token!);
    const newToken = await acquireLock('pay:3');
    expect(newToken).not.toBeNull();
  });
});

describe('markUpdateProcessed', () => {
  it('retorna true para update_id novo', async () => {
    const isNew = await markUpdateProcessed(9001);
    expect(isNew).toBe(true);
  });

  it('retorna false para update_id duplicado', async () => {
    await markUpdateProcessed(9002);
    const isDup = await markUpdateProcessed(9002);
    expect(isDup).toBe(false);
  });

  it('IDs diferentes não colidem', async () => {
    await markUpdateProcessed(1000);
    const ok = await markUpdateProcessed(1001);
    expect(ok).toBe(true);
  });
});
