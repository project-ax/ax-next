import { describe, it, expect, beforeEach } from 'vitest';
import { HookBus, makeAgentContext, bootstrap } from '@ax/core';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '../plugin.js';

function memStoragePlugin() {
  const store = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'mem-storage',
      version: '0.0.0',
      registers: [
        'storage:get',
        'storage:set',
        'storage:list-prefix',
        'storage:delete-prefix',
      ],
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
        async (_ctx, { prefix }: { prefix: string }) => {
          const entries: Array<{ key: string; value: Uint8Array }> = [];
          for (const [k, v] of store.entries()) {
            if (k.startsWith(prefix)) entries.push({ key: k, value: v });
          }
          return { entries };
        },
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

const TEST_KEY_HEX = '42'.repeat(32);

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

async function makeHarness() {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [memStoragePlugin(), createCredentialsStoreDbPlugin(), createCredentialsPlugin()],
    config: {},
  });
  return { bus, ctx: ctx() };
}

const enc = (s: string) => new TextEncoder().encode(s);

async function put(bus: HookBus, scope: 'user' | 'agent' | 'global', ownerId: string | null, ref: string) {
  await bus.call('credentials:set', ctx(), { scope, ownerId, ref, kind: 'api-key', payload: enc('v') });
}

async function refs(bus: HookBus): Promise<string[]> {
  const out = await bus.call<object, { credentials: Array<{ scope: string; ownerId: string | null; ref: string }> }>(
    'credentials:list', ctx(), {},
  );
  return out.credentials.map((c) => `${c.scope}:${c.ownerId ?? '_'}:${c.ref}`).sort();
}

describe('credentials:purge-account', () => {
  beforeEach(() => { process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX; });

  it('tombstones one connector\'s rows in the given scopes only', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    await put(bus, 'agent', 'agt2', 'account:gmail:HEADER_X');
    await put(bus, 'agent', 'agt1', 'account:gmail2');          // prefix neighbour — must survive
    await put(bus, 'user', 'u1', 'account:gmail');              // scope not requested — must survive
    await put(bus, 'global', null, 'account:gmail');            // scope not requested — must survive
    await put(bus, 'agent', 'agt1', 'provider:anthropic');      // other namespace — must survive
    const out = await bus.call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] });
    expect(out).toEqual({ purged: 2 });
    expect(await refs(bus)).toEqual([
      'agent:agt1:account:gmail2',
      'agent:agt1:provider:anthropic',
      'global:_:account:gmail',
      'user:u1:account:gmail',
    ]);
  });

  it('with no connectorId purges every account: row in the scopes, nothing else', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'user', 'u1', 'account:a');
    await put(bus, 'user', 'u2', 'account:b:SLOT');
    await put(bus, 'user', 'u1', 'skill:x');
    await put(bus, 'user', 'u1', 'routine:r');
    await put(bus, 'agent', 'agt1', 'account:a');
    const out = await bus.call('credentials:purge-account', ctx(), { scopes: ['user'] });
    expect(out).toEqual({ purged: 2 });
    expect(await refs(bus)).toEqual(['agent:agt1:account:a', 'user:u1:routine:r', 'user:u1:skill:x']);
  });

  it('does not count rows that are already tombstoned', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    await bus.call('credentials:delete', ctx(), { scope: 'agent', ownerId: 'agt1', ref: 'account:gmail' });
    const out = await bus.call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] });
    expect(out).toEqual({ purged: 0 });
  });

  it('purges an undecryptable row without throwing', async () => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    // Overwrite the stored blob with garbage (different-key aftermath).
    await bus.call('credentials:store-blob:put', ctx(), {
      scope: 'agent', ownerId: 'agt1', ref: 'account:gmail', blob: new Uint8Array([1, 2, 3]),
    });
    const out = await bus.call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] });
    expect(out).toEqual({ purged: 1 });
    // The garbage row is now a real tombstone: a second purge finds nothing live.
    expect(await bus.call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] }))
      .toEqual({ purged: 0 });
  });

  it('a store fault that is not an unreadable blob propagates and tombstones nothing', async () => {
    // A store-blob backend returning a broken entry (blob: null) is a real
    // fault, not key-rotation aftermath: the purge must fail loudly, not
    // tombstone a row it never looked at.
    const puts: unknown[] = [];
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        {
          manifest: {
            name: 'broken-store',
            version: '0.0.0',
            registers: [
              'credentials:store-blob:get',
              'credentials:store-blob:put',
              'credentials:store-blob:list',
              'credentials:store-blob:purge-by-owner',
            ],
            calls: [],
            subscribes: [],
          },
          async init({ bus: b }: { bus: HookBus }) {
            b.registerService('credentials:store-blob:get', 'broken-store', async () => ({ blob: undefined }));
            b.registerService('credentials:store-blob:put', 'broken-store', async (_c, input) => {
              puts.push(input);
            });
            b.registerService('credentials:store-blob:list', 'broken-store', async () => ({
              entries: [{ scope: 'agent', ownerId: 'agt1', ref: 'account:gmail', blob: null }],
            }));
            b.registerService('credentials:store-blob:purge-by-owner', 'broken-store', async () => ({ purged: 0 }));
          },
        },
        createCredentialsPlugin(),
      ],
      config: {},
    });
    const err = await bus
      .call('credentials:purge-account', ctx(), { connectorId: 'gmail', scopes: ['agent'] })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).not.toBe('invalid-payload');
    expect(puts).toEqual([]);
  });

  it.each([
    [{ connectorId: 'Gmail', scopes: ['agent'] }],
    [{ connectorId: 'a:b', scopes: ['agent'] }],
    [{ connectorId: '', scopes: ['agent'] }],
    [{ connectorId: 'gmail', scopes: [] }],
    [{ connectorId: 'gmail', scopes: ['team'] }],
    [{ connectorId: 'gmail' }],
    // 'global' is refused: no caller needs it (a company key is purged by ref).
    [{ connectorId: 'gmail', scopes: ['global'] }],
    [{ connectorId: 'gmail', scopes: ['agent', 'global'] }],
    [{ scopes: ['global'] }],
  ])('rejects invalid input %j without purging anything', async (input) => {
    const { bus } = await makeHarness();
    await put(bus, 'agent', 'agt1', 'account:gmail');
    await expect(bus.call('credentials:purge-account', ctx(), input)).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(await refs(bus)).toEqual(['agent:agt1:account:gmail']);
  });
});
