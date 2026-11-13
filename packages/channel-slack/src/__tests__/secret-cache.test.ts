import { PluginError } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { fakeBotToken } from './fake-slack-tokens.js';
import { cacheSigningSecrets } from '../secret-cache.js';
import type { SecretName, SecretOwner, SecretStore } from '../secrets.js';

const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');
const TTL_MS = 60_000;
const A: SecretOwner = { installId: 'q3VtZ0xH4kTn9Wb2LmPa1A', connectedByUserId: 'usr_ada' };
const B: SecretOwner = { installId: 'Zx8_n2-QpL4mVb7cRt1sYw', connectedByUserId: 'usr_ada' };
const C: SecretOwner = { installId: 'Mm0rT7qWc3Yb9Vn2Ls5KdA', connectedByUserId: 'usr_ada' };

/** A vault behind the SecretStore interface that counts its reads. */
function countingStore() {
  const values = new Map<string, string>();
  const reads: string[] = [];
  const at = (installId: string, name: SecretName): string => `${installId}:${name}`;
  /** The next `get` of this key waits for this before it reads. */
  const gates = new Map<string, Promise<void>>();
  /** The next `get` of this key throws this. */
  const failures = new Map<string, unknown>();
  const store: SecretStore = {
    async put(install, name, value) {
      values.set(at(install.installId, name), value);
    },
    async get(install, name) {
      const key = at(install.installId, name);
      reads.push(key);
      const gate = gates.get(key);
      gates.delete(key);
      if (gate !== undefined) await gate;
      const failure = failures.get(key);
      failures.delete(key);
      if (failure !== undefined) throw failure;
      return values.get(key) ?? null;
    },
    async remove(install, name) {
      values.delete(at(install.installId, name));
    },
    async removeAll(install) {
      for (const key of [...values.keys()]) if (key.startsWith(`${install.installId}:`)) values.delete(key);
    },
  };
  return { store, values, reads, gates, failures, at };
}

function setup(o: { max?: number } = {}) {
  const inner = countingStore();
  let nowMs = NOW_MS;
  const cached = cacheSigningSecrets(inner.store, { ttlMs: TTL_MS, max: o.max ?? 16, now: () => nowMs });
  return {
    inner,
    cached,
    advance(ms: number) {
      nowMs += ms;
    },
    /** How many times the vault was read for this install's signing secret. */
    vaultReads: (install: SecretOwner) =>
      inner.reads.filter((r) => r === inner.at(install.installId, 'signing-secret')).length,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('cacheSigningSecrets', () => {
  it('reads an install’s signing secret from the vault once per TTL', async () => {
    const t = setup();
    await t.inner.store.put(A, 'signing-secret', 'secret-a');
    for (let i = 0; i < 5; i += 1) expect(await t.cached.get(A, 'signing-secret')).toBe('secret-a');
    expect(t.vaultReads(A)).toBe(1);

    t.advance(TTL_MS - 1);
    expect(await t.cached.get(A, 'signing-secret')).toBe('secret-a');
    expect(t.vaultReads(A)).toBe(1);

    t.advance(1);
    expect(await t.cached.get(A, 'signing-secret')).toBe('secret-a');
    expect(t.vaultReads(A)).toBe(2);
  });

  it('caches nothing else: the other secrets, a missing secret, a vault failure', async () => {
    const t = setup();
    await t.inner.store.put(A, 'bot-token', fakeBotToken('NOTREAL'));
    await t.cached.get(A, 'bot-token');
    await t.cached.get(A, 'bot-token');
    expect(t.inner.reads.filter((r) => r.endsWith(':bot-token'))).toHaveLength(2);

    // None stored: asked again each time, and the moment one is stored it is seen.
    expect(await t.cached.get(A, 'signing-secret')).toBeNull();
    expect(await t.cached.get(A, 'signing-secret')).toBeNull();
    expect(t.vaultReads(A)).toBe(2);

    const down = new PluginError({ code: 'timeout', plugin: '@ax/credentials', message: 'slow' });
    t.inner.failures.set(t.inner.at(B.installId, 'signing-secret'), down);
    await t.inner.store.put(B, 'signing-secret', 'secret-b');
    await expect(t.cached.get(B, 'signing-secret')).rejects.toBe(down);
    expect(await t.cached.get(B, 'signing-secret')).toBe('secret-b');
    expect(t.vaultReads(B)).toBe(2);
  });

  it('put, remove and removeAll for an install drop its cached secret, and only its', async () => {
    for (const change of ['put', 'remove', 'removeAll'] as const) {
      const t = setup();
      await t.inner.store.put(A, 'signing-secret', 'old-a');
      await t.inner.store.put(B, 'signing-secret', 'secret-b');
      expect(await t.cached.get(A, 'signing-secret')).toBe('old-a');
      expect(await t.cached.get(B, 'signing-secret')).toBe('secret-b');

      if (change === 'put') await t.cached.put(A, 'signing-secret', 'new-a');
      if (change === 'remove') await t.cached.remove(A, 'signing-secret');
      if (change === 'removeAll') await t.cached.removeAll(A);

      // The change reached the vault...
      expect(t.inner.values.get(t.inner.at(A.installId, 'signing-secret'))).toBe(
        change === 'put' ? 'new-a' : undefined,
      );
      // ...and the next read goes there too.
      expect(await t.cached.get(A, 'signing-secret'), change).toBe(change === 'put' ? 'new-a' : null);
      expect(t.vaultReads(A), change).toBe(2);
      // Another install's entry stays.
      expect(await t.cached.get(B, 'signing-secret')).toBe('secret-b');
      expect(t.vaultReads(B), change).toBe(1);
    }
  });

  it('a read in flight when the install changes does not cache what it read', async () => {
    const t = setup();
    await t.inner.store.put(A, 'signing-secret', 'old-a');
    const gate = deferred();
    t.inner.gates.set(t.inner.at(A.installId, 'signing-secret'), gate.promise);
    const inFlight = t.cached.get(A, 'signing-secret');
    // Disconnect: the secret goes while the read is still out.
    await t.cached.removeAll(A);
    t.inner.values.set(t.inner.at(A.installId, 'signing-secret'), 'old-a');
    gate.resolve();
    expect(await inFlight).toBe('old-a');
    // What it read is not kept: the next read asks the vault again.
    t.inner.values.delete(t.inner.at(A.installId, 'signing-secret'));
    expect(await t.cached.get(A, 'signing-secret')).toBeNull();
    expect(t.vaultReads(A)).toBe(2);
  });

  it('a read that starts while a change is being written does not cache the value from before it', async () => {
    const t = setup();
    await t.inner.store.put(A, 'signing-secret', 'old-a');
    // A put whose vault write is slow.
    const write = deferred();
    const slowPut = t.inner.store.put.bind(t.inner.store);
    t.inner.store.put = async (install, name, value) => {
      await write.promise;
      await slowPut(install, name, value);
    };
    const putting = t.cached.put(A, 'signing-secret', 'new-a');
    // Started after the put began, read before its write landed.
    expect(await t.cached.get(A, 'signing-secret')).toBe('old-a');
    write.resolve();
    await putting;
    expect(await t.cached.get(A, 'signing-secret')).toBe('new-a');
  });

  it('holds at most max installs, forgetting the oldest first', async () => {
    const t = setup({ max: 2 });
    for (const [install, value] of [
      [A, 'secret-a'],
      [B, 'secret-b'],
      [C, 'secret-c'],
    ] as const) {
      await t.inner.store.put(install, 'signing-secret', value);
      await t.cached.get(install, 'signing-secret');
    }
    await t.cached.get(B, 'signing-secret');
    await t.cached.get(C, 'signing-secret');
    expect([t.vaultReads(B), t.vaultReads(C)]).toEqual([1, 1]);
    // A was the oldest when C arrived.
    await t.cached.get(A, 'signing-secret');
    expect(t.vaultReads(A)).toBe(2);
  });

  it('clear forgets every install', async () => {
    const t = setup();
    await t.inner.store.put(A, 'signing-secret', 'secret-a');
    await t.cached.get(A, 'signing-secret');
    t.cached.clear();
    await t.cached.get(A, 'signing-secret');
    expect(t.vaultReads(A)).toBe(2);
  });

  it('refuses a TTL or bound that is not a positive integer', () => {
    const { store } = countingStore();
    for (const o of [
      { ttlMs: 0, max: 10 },
      { ttlMs: 1000, max: 0 },
      { ttlMs: Number.NaN, max: 10 },
      { ttlMs: 1000, max: 1.5 },
    ]) {
      expect(() => cacheSigningSecrets(store, { ...o, now: () => NOW_MS }), JSON.stringify(o)).toThrow(RangeError);
    }
  });
});
