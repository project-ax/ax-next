import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

// TASK-817 — `credentials:get {rejected: true}`: the caller presented the value
// it last got and the service refused it. The vault hands that fact to the
// kind's resolver (which may mint a new value) and never lets a "rejected"
// read share an in-flight ordinary read (which would hand back the same
// refused value).

function memStoragePlugin() {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: ['storage:get', 'storage:set', 'storage:list-prefix', 'storage:delete-prefix'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService('storage:get', 'mem-storage', async (_ctx, { key }: { key: string }) => ({
        value: store.get(key),
      }));
      bus.registerService(
        'storage:set',
        'mem-storage',
        async (_ctx, { key, value }: { key: string; value: Uint8Array }) => {
          store.set(key, value);
        },
      );
      bus.registerService(
        'storage:list-prefix',
        'mem-storage',
        async (_ctx, { prefix }: { prefix: string }) => ({
          entries: [...store.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(([key, value]) => ({ key, value })),
        }),
      );
      bus.registerService(
        'storage:delete-prefix',
        'mem-storage',
        async (_ctx, { prefix }: { prefix: string }) => {
          let deleted = 0;
          for (const k of [...store.keys()]) {
            if (k.startsWith(prefix)) {
              store.delete(k);
              deleted++;
            }
          }
          return { deleted };
        },
      );
    },
  };
}

const ctx = () => makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
const bytes = (s: string) => new TextEncoder().encode(s);

async function setup(resolve: (input: Record<string, unknown>) => Promise<{ value: string }>) {
  const bus = new HookBus();
  const resolver = {
    manifest: {
      name: 'fake-resolver',
      version: '0.0.0',
      registers: ['credentials:resolve:fake-oauth'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }: { bus: HookBus }) {
      bus.registerService(
        'credentials:resolve:fake-oauth',
        'fake-resolver',
        async (_c, input: Record<string, unknown>) => resolve(input),
      );
    },
  };
  await bootstrap({
    bus,
    plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin(), resolver],
    config: {},
  });
  await bus.call('credentials:set', ctx(), {
    scope: 'user',
    ownerId: 'u',
    ref: 'oauth1',
    kind: 'fake-oauth',
    payload: bytes('blob'),
  });
  return bus;
}

describe('credentials:get {rejected} (TASK-817)', () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  it("tells the resolver the caller's value was rejected — and only when the caller said so", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const bus = await setup(async (input) => {
      seen.push(input);
      return { value: 'tok' };
    });
    await bus.call('credentials:get', ctx(), { ref: 'oauth1', userId: 'u' });
    await bus.call('credentials:get', ctx(), { ref: 'oauth1', userId: 'u', rejected: true });
    // Anything but a literal `true` is the ordinary read.
    await bus.call('credentials:get', ctx(), { ref: 'oauth1', userId: 'u', rejected: 'yes' });
    expect(seen).toHaveLength(3);
    expect('rejected' in seen[0]!).toBe(false);
    expect(seen[1]).toMatchObject({ rejected: true, scope: 'user', ownerId: 'u' });
    expect('rejected' in seen[2]!).toBe(false);
  });

  it('a rejected read neither joins nor runs beside an in-flight ordinary read of the same row', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const log: string[] = [];
    const bus = await setup(async (input) => {
      if (input.rejected === true) {
        log.push('rejected-start');
        return { value: 'fresh' };
      }
      log.push('ordinary-start');
      await gate;
      log.push('ordinary-end');
      return { value: 'refused-old' };
    });
    const ordinary = bus.call<unknown, string>('credentials:get', ctx(), { ref: 'oauth1', userId: 'u' });
    // Let the ordinary read reach its resolver before the rejected one starts.
    await new Promise((r) => setTimeout(r, 10));
    const rejected = bus.call<unknown, string>('credentials:get', ctx(), {
      ref: 'oauth1',
      userId: 'u',
      rejected: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    // Still waiting: the renew must not run beside the ordinary read.
    expect(log).toEqual(['ordinary-start']);
    release();
    expect(await rejected).toBe('fresh');
    expect(await ordinary).toBe('refused-old');
    expect(log).toEqual(['ordinary-start', 'ordinary-end', 'rejected-start']);
  });

  // Review finding: a renewal that waited must renew from the row as it is
  // NOW. If the read it waited for rotated the refresh token, renewing from
  // the pre-wait snapshot presents the old one, which a rotating authorization
  // server refuses as reuse — a false "sign-in expired".
  it('a rejected read that waited renews from the row the ordinary read just re-stored, not its pre-wait snapshot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const renewedFrom: string[] = [];
    const bus = await setup(async (input) => {
      const payload = new TextDecoder().decode(input.payload as Uint8Array);
      if (input.rejected === true) {
        renewedFrom.push(payload);
        return { value: 'fresh' };
      }
      await gate;
      return { value: 'rotated', refreshed: { payload: bytes('blob-v2') } } as { value: string };
    });
    const ordinary = bus.call<unknown, string>('credentials:get', ctx(), { ref: 'oauth1', userId: 'u' });
    await new Promise((r) => setTimeout(r, 10));
    const rejected = bus.call<unknown, string>('credentials:get', ctx(), {
      ref: 'oauth1',
      userId: 'u',
      rejected: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await ordinary).toBe('rotated');
    expect(await rejected).toBe('fresh');
    expect(renewedFrom).toEqual(['blob-v2']);
  });

  it('a rejected read whose row was deleted while it waited answers not-found, never renewing the stale snapshot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let renewals = 0;
    const bus = await setup(async (input) => {
      if (input.rejected === true) {
        renewals++;
        return { value: 'fresh' };
      }
      await gate;
      return { value: 'old' };
    });
    const ordinary = bus.call<unknown, string>('credentials:get', ctx(), { ref: 'oauth1', userId: 'u' });
    await new Promise((r) => setTimeout(r, 10));
    const rejected = bus.call<unknown, string>('credentials:get', ctx(), {
      ref: 'oauth1',
      userId: 'u',
      rejected: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    await bus.call('credentials:delete', ctx(), { scope: 'user', ownerId: 'u', ref: 'oauth1' });
    release();
    expect(await ordinary).toBe('old');
    await expect(rejected).rejects.toMatchObject({ code: 'credential-not-found' });
    expect(renewals).toBe(0);
  });

  it('an ordinary read arriving while a rejected read renews shares the renewed value', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const bus = await setup(async (input) => {
      calls++;
      if (input.rejected === true) {
        await gate;
        return { value: 'fresh' };
      }
      return { value: 'refused-old' };
    });
    const rejected = bus.call<unknown, string>('credentials:get', ctx(), {
      ref: 'oauth1',
      userId: 'u',
      rejected: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    const ordinary = bus.call<unknown, string>('credentials:get', ctx(), { ref: 'oauth1', userId: 'u' });
    // Let the ordinary read finish its row walk and reach the mutex.
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await rejected).toBe('fresh');
    expect(await ordinary).toBe('fresh');
    expect(calls).toBe(1);
  });
});
