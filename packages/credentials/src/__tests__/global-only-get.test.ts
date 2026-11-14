/**
 * global-only-get.test.ts — `credentials:get({ ..., scope: 'global' })`.
 *
 * Some secrets belong to the whole install and nobody else: a value one
 * person stores under the same ref must never stand in for them. The plain
 * walk (user -> agent -> global) would hand back that person's row first, so
 * a caller that wants only the workspace-wide value asks for `scope: 'global'`
 * and the user and agent steps are skipped. Nothing else changes: the env
 * fallback (the same value for everyone) still applies, and `account:` refs
 * keep their global gate.
 *
 * Harness mirrors scope-precedence.test.ts: in-memory sqlite + the real
 * credentials-store-db + the real credentials facade.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin, type CredentialsPluginConfig } from '../plugin.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'alice' });

describe("credentials:get with scope: 'global'", () => {
  let savedKey: string | undefined;
  let savedFallback: string | undefined;
  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    savedFallback = process.env.MY_FALLBACK;
    process.env.AX_CREDENTIALS_KEY = KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
    if (savedFallback === undefined) delete process.env.MY_FALLBACK;
    else process.env.MY_FALLBACK = savedFallback;
  });

  async function makeBus(config: CredentialsPluginConfig = {}): Promise<HookBus> {
    const bus = new HookBus();
    await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: ':memory:' }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(config),
      ],
      config: {},
    });
    return bus;
  }

  async function put(
    bus: HookBus,
    scope: 'global' | 'user' | 'agent',
    ownerId: string | null,
    ref: string,
    value: string,
  ): Promise<void> {
    await bus.call('credentials:set', ctx, { scope, ownerId, ref, kind: 'api-key', payload: enc(value) });
  }

  it("returns the global row even when the user and the agent each have their own", async () => {
    const bus = await makeBus();
    await put(bus, 'global', null, 'install:secret', 'GLOBAL');
    await put(bus, 'agent', 'agent-1', 'install:secret', 'AGENT');
    await put(bus, 'user', 'alice', 'install:secret', 'USER');

    // The plain walk is unchanged: the person's own row wins.
    expect(await bus.call('credentials:get', ctx, { ref: 'install:secret', userId: 'alice' })).toBe('USER');
    expect(
      await bus.call('credentials:get', ctx, { ref: 'install:secret', userId: 'alice', scope: 'global' }),
    ).toBe('GLOBAL');
  });

  it('never falls back to a user or agent row', async () => {
    const bus = await makeBus();
    await put(bus, 'agent', 'agent-1', 'install:secret', 'AGENT');
    await put(bus, 'user', 'alice', 'install:secret', 'USER');
    await expect(
      bus.call('credentials:get', ctx, { ref: 'install:secret', userId: 'alice', scope: 'global' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });

    // A deleted global row (a tombstone) doesn't uncover them either.
    await put(bus, 'global', null, 'install:secret', 'GLOBAL');
    await bus.call('credentials:delete', ctx, { scope: 'global', ownerId: null, ref: 'install:secret' });
    await expect(
      bus.call('credentials:get', ctx, { ref: 'install:secret', userId: 'alice', scope: 'global' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });
  });

  it("refuses any scope but 'global'", async () => {
    const bus = await makeBus();
    await put(bus, 'user', 'alice', 'install:secret', 'USER');
    for (const scope of ['user', 'agent', 'GLOBAL', '', null, 42]) {
      await expect(
        bus.call('credentials:get', ctx, { ref: 'install:secret', userId: 'alice', scope }),
        JSON.stringify(scope),
      ).rejects.toMatchObject({ code: 'invalid-payload' });
    }
  });

  it("still ends at the operator's env fallback, which is the same for everyone", async () => {
    process.env.MY_FALLBACK = 'ENV_VALUE';
    const bus = await makeBus({ envFallback: { 'install:secret': 'MY_FALLBACK' } });
    await put(bus, 'user', 'alice', 'install:secret', 'USER');
    expect(
      await bus.call('credentials:get', ctx, { ref: 'install:secret', userId: 'alice', scope: 'global' }),
    ).toBe('ENV_VALUE');
  });

  it('keeps the global gate on account: refs', async () => {
    const bus = await makeBus();
    await put(bus, 'global', null, 'account:zendesk', 'COMPANY');
    // No `credentials:authorize-global:account` provider: the global step is closed.
    await expect(
      bus.call('credentials:get', ctx, { ref: 'account:zendesk', userId: 'alice', scope: 'global' }),
    ).rejects.toMatchObject({ code: 'credential-not-found' });

    bus.registerService('credentials:authorize-global:account', 'test', async () => ({ allowed: true }));
    expect(
      await bus.call('credentials:get', ctx, { ref: 'account:zendesk', userId: 'alice', scope: 'global' }),
    ).toBe('COMPANY');
  });
});
