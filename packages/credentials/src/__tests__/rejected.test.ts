import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

// TASK-817 — `credentials:get {rejected: true}`: the caller presented the value
// it last got and the service refused it. The vault hands that fact to the
// kind's resolver (which may mint a new value) and never lets a "rejected"
// read share an in-flight ordinary read (which would hand back the same
// refused value).

function memStoragePlugin(beforeGet: () => Promise<void> = async () => {}) {
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
      bus.registerService('storage:get', 'mem-storage', async (_ctx, { key }: { key: string }) => {
        await beforeGet();
        return { value: store.get(key) };
      });
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

async function setup(
  resolve: (input: Record<string, unknown>) => Promise<{ value: string }>,
  beforeGet?: () => Promise<void>,
) {
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
    plugins: [memStoragePlugin(beforeGet), createCredentialsStoreDbPlugin(), createCredentialsPlugin(), resolver],
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

// `rejected: true` beside `scope: 'global'`: a renewal must stay on the
// install's own row. The person's same-named row (seeded by setup()) must
// never stand in for it, not even after the renewal waited for an ordinary
// read and re-reads the row (plugin.ts's post-wait walk).
describe("credentials:get {rejected, scope: 'global'}", () => {
  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  const decode = (input: Record<string, unknown>): string =>
    new TextDecoder().decode(input.payload as Uint8Array);

  async function setupWithGlobal(
    resolve: (input: Record<string, unknown>) => Promise<{ value: string }>,
    beforeGet?: () => Promise<void>,
  ) {
    const bus = await setup(resolve, beforeGet);
    await bus.call('credentials:set', ctx(), {
      scope: 'global',
      ownerId: null,
      ref: 'oauth1',
      kind: 'fake-oauth',
      payload: bytes('blob-global'),
    });
    return bus;
  }

  it("renews the global row, not the person's", async () => {
    const renewedFrom: string[] = [];
    const bus = await setupWithGlobal(async (input) => {
      if (input.rejected === true) renewedFrom.push(`${String(input.scope)}:${decode(input)}`);
      return { value: 'fresh' };
    });
    const global = { ref: 'oauth1', userId: 'u', scope: 'global' };
    expect(await bus.call('credentials:get', ctx(), { ...global, rejected: true })).toBe('fresh');
    expect(renewedFrom).toEqual(['global:blob-global']);
  });

  it('after waiting for an in-flight ordinary global read, renews the global row', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const renewedFrom: string[] = [];
    const bus = await setupWithGlobal(async (input) => {
      if (input.rejected === true) {
        renewedFrom.push(`${String(input.scope)}:${decode(input)}`);
        return { value: 'fresh' };
      }
      await gate;
      return { value: 'old' };
    });
    const global = { ref: 'oauth1', userId: 'u', scope: 'global' };
    const ordinary = bus.call<unknown, string>('credentials:get', ctx(), global);
    await new Promise((r) => setTimeout(r, 10));
    const rejected = bus.call<unknown, string>('credentials:get', ctx(), { ...global, rejected: true });
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await ordinary).toBe('old');
    expect(await rejected).toBe('fresh');
    expect(renewedFrom).toEqual(['global:blob-global']);
  });

  it("a global row deleted while the renewal waited is not-found, never the person's row", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const bus = await setupWithGlobal(async (input) => {
      if (input.rejected === true) return { value: `fresh-${decode(input)}` };
      await gate;
      return { value: 'old' };
    });
    const global = { ref: 'oauth1', userId: 'u', scope: 'global' };
    const ordinary = bus.call<unknown, string>('credentials:get', ctx(), global);
    await new Promise((r) => setTimeout(r, 10));
    const rejected = bus.call<unknown, string>('credentials:get', ctx(), { ...global, rejected: true });
    await new Promise((r) => setTimeout(r, 10));
    await bus.call('credentials:delete', ctx(), { scope: 'global', ownerId: null, ref: 'oauth1' });
    release();
    expect(await ordinary).toBe('old');
    await expect(rejected).rejects.toMatchObject({ code: 'credential-not-found' });
  });

  it('a renewal that finds yet another ordinary read in flight after its wait waits again, and renews the global row', async () => {
    const gates: Array<() => void> = [];
    const hold = (): Promise<void> => new Promise<void>((r) => gates.push(r));
    // One storage read is held when armed: the renewal's post-wait re-read.
    let holdNextGet = false;
    let releaseGet!: () => void;
    const renewedFrom: string[] = [];
    const bus = await setupWithGlobal(
      async (input) => {
        if (input.rejected === true) {
          renewedFrom.push(`${String(input.scope)}:${decode(input)}`);
          return { value: 'fresh' };
        }
        await hold();
        return { value: 'old' };
      },
      async () => {
        if (!holdNextGet) return;
        holdNextGet = false;
        await new Promise<void>((r) => {
          releaseGet = r;
        });
      },
    );
    const global = { ref: 'oauth1', userId: 'u', scope: 'global' };
    const tick = () => new Promise((r) => setTimeout(r, 10));

    const first = bus.call<unknown, string>('credentials:get', ctx(), global);
    await tick();
    const rejected = bus.call<unknown, string>('credentials:get', ctx(), { ...global, rejected: true });
    await tick();
    // The first ordinary read settles; the renewal's re-read of the row is held...
    holdNextGet = true;
    gates[0]!();
    expect(await first).toBe('old');
    await tick();
    // ...while a second ordinary read of the global row starts and stays in flight.
    const second = bus.call<unknown, string>('credentials:get', ctx(), global);
    await tick();
    expect(gates).toHaveLength(2);
    releaseGet();
    await tick();
    expect(renewedFrom).toEqual([]);
    gates[1]!();
    expect(await second).toBe('old');
    expect(await rejected).toBe('fresh');
    expect(renewedFrom).toEqual(['global:blob-global']);
  });
});
