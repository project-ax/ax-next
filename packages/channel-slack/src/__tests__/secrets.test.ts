import { createCredentialsPlugin } from '@ax/credentials';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Logger,
  type Plugin,
} from '@ax/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBotToken, fakeConfigRefreshToken } from './fake-slack-tokens.js';
import { SECRET_NAMES, createSecretStore, secretRef, type SecretName } from '../secrets.js';

const INSTALL = { installId: 'q3VtZ0xH4kTn9Wb2LmPa1A', connectedByUserId: 'usr_admin1' } as const;

// Slack-shaped and distinctive, so a leak into a log line is easy to spot. Built
// from pieces (see fake-slack-tokens.ts) so no token-shaped literal is in source.
const VALUES: Record<SecretName, string> = {
  'bot-token': fakeBotToken('BOTTOKENSECRETVALUE'),
  'signing-secret': '8f742231b10e8888abcd99yyyzzz85a5',
  'client-secret': 'c1i3n7s3cr3t0123456789abcdef0123',
  'config-refresh-token': fakeConfigRefreshToken('My0xLTc1MTIzNDU2Nzg5MDEtUkVGUkVTSA'),
};

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return { logger, lines };
}

interface Call {
  hook: string;
  ctx: AgentContext;
  input: Record<string, unknown>;
}

/**
 * The real bus with a fake vault behind the three credentials hooks. Values
 * live in memory by ref; a missing ref answers like `@ax/credentials` does.
 * `fail` makes the named hook throw for one ref.
 */
function fakeVault(fail?: { hook: string; ref: string; error: unknown }) {
  const bus = new HookBus();
  const calls: Call[] = [];
  const rows = new Map<string, Uint8Array>();
  const record = (hook: string) => (ctx: AgentContext, input: unknown) => {
    const call = { hook, ctx, input: input as Record<string, unknown> };
    calls.push(call);
    if (fail !== undefined && fail.hook === hook && call.input['ref'] === fail.ref) {
      throw fail.error;
    }
    return call.input;
  };
  bus.registerService('credentials:set', '@ax/credentials', async (ctx, input) => {
    const i = record('credentials:set')(ctx, input);
    rows.set(i['ref'] as string, i['payload'] as Uint8Array);
  });
  bus.registerService('credentials:get', '@ax/credentials', async (ctx, input) => {
    const i = record('credentials:get')(ctx, input);
    const payload = rows.get(i['ref'] as string);
    if (payload === undefined) {
      throw new PluginError({
        code: 'credential-not-found',
        plugin: '@ax/credentials',
        message: `no credential for ref='${String(i['ref'])}'`,
      });
    }
    return new TextDecoder().decode(payload);
  });
  bus.registerService('credentials:delete', '@ax/credentials', async (ctx, input) => {
    const i = record('credentials:delete')(ctx, input);
    rows.delete(i['ref'] as string);
  });
  return { bus, calls, rows };
}

describe('secretRef', () => {
  it('is slack:<installId>:<name> for each of the four names', () => {
    expect(SECRET_NAMES).toEqual([
      'bot-token',
      'signing-secret',
      'client-secret',
      'config-refresh-token',
    ]);
    expect(SECRET_NAMES.map((name) => secretRef(INSTALL.installId, name))).toEqual([
      'slack:q3VtZ0xH4kTn9Wb2LmPa1A:bot-token',
      'slack:q3VtZ0xH4kTn9Wb2LmPa1A:signing-secret',
      'slack:q3VtZ0xH4kTn9Wb2LmPa1A:client-secret',
      'slack:q3VtZ0xH4kTn9Wb2LmPa1A:config-refresh-token',
    ]);
  });
});

describe('createSecretStore', () => {
  it('put writes global api-key under slack:<id>:<name>', async () => {
    const vault = fakeVault();
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });
    for (const name of SECRET_NAMES) await secrets.put(INSTALL, name, VALUES[name]);

    const sets = vault.calls.filter((c) => c.hook === 'credentials:set');
    expect(sets).toHaveLength(4);
    for (const [i, name] of SECRET_NAMES.entries()) {
      const { input, ctx } = sets[i]!;
      // Exactly these fields: no metadata, no expiry, nothing listed beside the ref.
      expect(Object.keys(input).sort()).toEqual(['kind', 'ownerId', 'payload', 'ref', 'scope']);
      expect(input).toMatchObject({
        scope: 'global',
        ownerId: null,
        ref: `slack:${INSTALL.installId}:${name}`,
        kind: 'api-key',
      });
      expect(input['payload']).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(input['payload'] as Uint8Array).toString('utf8')).toBe(VALUES[name]);
      expect(ctx.agentId).toBe('');
    }
  });

  it('put refuses an empty value before reaching the vault', async () => {
    const vault = fakeVault();
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });
    await expect(secrets.put(INSTALL, 'bot-token', '')).rejects.toThrow();
    expect(vault.calls).toHaveLength(0);
  });

  it("get reads the global row only, as the connector's userId with agentId ''", async () => {
    const vault = fakeVault();
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });
    await secrets.put(INSTALL, 'signing-secret', VALUES['signing-secret']);

    expect(await secrets.get(INSTALL, 'signing-secret')).toBe(VALUES['signing-secret']);
    const get = vault.calls.find((c) => c.hook === 'credentials:get')!;
    expect(get.input).toEqual({
      ref: `slack:${INSTALL.installId}:signing-secret`,
      userId: 'usr_admin1',
      scope: 'global',
    });
    // An empty agentId skips the vault's agent step; a non-id one would throw.
    expect(get.ctx.agentId).toBe('');
    expect(get.ctx.userId).toBe('usr_admin1');
  });

  it('get maps not-found to null and rethrows other errors', async () => {
    const vault = fakeVault();
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });
    expect(await secrets.get(INSTALL, 'bot-token')).toBeNull();

    const decryptFailed = new PluginError({
      code: 'decrypt-failed',
      plugin: '@ax/credentials',
      message: 'credential decrypt failed',
    });
    const broken = fakeVault({
      hook: 'credentials:get',
      ref: secretRef(INSTALL.installId, 'bot-token'),
      error: decryptFailed,
    });
    const s2 = createSecretStore(broken.bus, { logger: recordingLogger().logger });
    await expect(s2.get(INSTALL, 'bot-token')).rejects.toBe(decryptFailed);

    // A plain throw behind the bus arrives wrapped as `unknown`: still not "none saved".
    const down = fakeVault({
      hook: 'credentials:get',
      ref: secretRef(INSTALL.installId, 'bot-token'),
      error: new Error('connection terminated'),
    });
    const s3 = createSecretStore(down.bus, { logger: recordingLogger().logger });
    await expect(s3.get(INSTALL, 'bot-token')).rejects.toMatchObject({ code: 'unknown' });
  });

  it('get treats an empty stored value as missing', async () => {
    const vault = fakeVault();
    vault.rows.set(secretRef(INSTALL.installId, 'signing-secret'), new Uint8Array());
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });
    expect(await secrets.get(INSTALL, 'signing-secret')).toBeNull();
  });

  it('removeAll calls delete for all four names even when one throws, and logs only installId + code', async () => {
    const vault = fakeVault({
      hook: 'credentials:delete',
      ref: secretRef(INSTALL.installId, 'signing-secret'),
      // A message that quotes things a log line must never carry.
      error: new PluginError({
        code: 'timeout',
        plugin: '@ax/credentials',
        message: `vault slow for ${VALUES['signing-secret']} at slack:${INSTALL.installId}:signing-secret`,
      }),
    });
    for (const name of SECRET_NAMES) {
      vault.rows.set(secretRef(INSTALL.installId, name), Buffer.from(VALUES[name]));
    }
    const { logger, lines } = recordingLogger();
    const secrets = createSecretStore(vault.bus, { logger });

    await expect(secrets.removeAll({ installId: INSTALL.installId })).resolves.toBeUndefined();

    const deletes = vault.calls.filter((c) => c.hook === 'credentials:delete');
    expect(deletes.map((c) => c.input)).toEqual(
      SECRET_NAMES.map((name) => ({
        scope: 'global',
        ownerId: null,
        ref: secretRef(INSTALL.installId, name),
      })),
    );
    expect(lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_secret_remove_failed',
        fields: { installId: INSTALL.installId, stage: 'signing-secret', code: 'timeout' },
      },
    ]);
  });

  it('remove deletes only the named secret', async () => {
    const vault = fakeVault();
    for (const name of SECRET_NAMES) {
      vault.rows.set(secretRef(INSTALL.installId, name), Buffer.from(VALUES[name]));
    }
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });

    await expect(secrets.remove({ installId: INSTALL.installId }, 'bot-token')).resolves.toBeUndefined();

    expect(vault.calls.map((c) => [c.hook, c.input])).toEqual([
      [
        'credentials:delete',
        { scope: 'global', ownerId: null, ref: secretRef(INSTALL.installId, 'bot-token') },
      ],
    ]);
    expect(await secrets.get(INSTALL, 'bot-token')).toBeNull();
    expect(await secrets.get(INSTALL, 'signing-secret')).toBe(VALUES['signing-secret']);
  });

  it('remove never throws, and logs a failure with only installId, the name and a code', async () => {
    const vault = fakeVault({
      hook: 'credentials:delete',
      ref: secretRef(INSTALL.installId, 'bot-token'),
      error: new PluginError({
        code: 'timeout',
        plugin: '@ax/credentials',
        message: `vault slow for ${VALUES['bot-token']}`,
      }),
    });
    const { logger, lines } = recordingLogger();
    const secrets = createSecretStore(vault.bus, { logger });
    await expect(secrets.remove({ installId: INSTALL.installId }, 'bot-token')).resolves.toBeUndefined();
    expect(lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_secret_remove_failed',
        fields: { installId: INSTALL.installId, stage: 'bot-token', code: 'timeout' },
      },
    ]);
  });

  it('removeAll never throws, even when every delete fails with no readable code', async () => {
    const bus = new HookBus();
    bus.registerService('credentials:delete', '@ax/credentials', async () => {
      throw Object.assign(new Error(`boom ${VALUES['bot-token']}`), { code: 'has spaces!' });
    });
    const { logger, lines } = recordingLogger();
    const secrets = createSecretStore(bus, { logger });
    await expect(secrets.removeAll({ installId: INSTALL.installId })).resolves.toBeUndefined();
    expect(lines.map((l) => l.fields)).toEqual(
      SECRET_NAMES.map((name) => ({ installId: INSTALL.installId, stage: name, code: 'unknown' })),
    );
  });

  it('no log line or error ever carries a secret value', async () => {
    const vault = fakeVault({
      hook: 'credentials:delete',
      ref: secretRef(INSTALL.installId, 'bot-token'),
      error: new Error(`delete failed for ${VALUES['bot-token']}`),
    });
    const { logger, lines } = recordingLogger();
    const secrets = createSecretStore(vault.bus, { logger });
    for (const name of SECRET_NAMES) await secrets.put(INSTALL, name, VALUES[name]);
    for (const name of SECRET_NAMES) await secrets.get(INSTALL, name);
    await secrets.removeAll(INSTALL);

    const logged = JSON.stringify(lines);
    for (const value of Object.values(VALUES)) expect(logged).not.toContain(value);
  });
});

// ── Against the real vault ──────────────────────────────────────────────────

/**
 * The credentials facade's storage seam, in memory: blobs by (scope, owner,
 * ref), nothing more. Everything that decides which row a read gets is the
 * real @ax/credentials.
 */
function memoryBlobStore(): Plugin {
  const name = 'test/credentials-store-memory';
  const blobs = new Map<string, Uint8Array>();
  const key = (i: { scope: string; ownerId: string | null; ref: string }): string =>
    `${i.scope}\u0000${i.ownerId ?? ''}\u0000${i.ref}`;
  return {
    manifest: {
      name,
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
    init({ bus }) {
      type Where = { scope: string; ownerId: string | null; ref: string };
      bus.registerService<Where, { blob: Uint8Array | undefined }>(
        'credentials:store-blob:get',
        name,
        async (_ctx, i) => ({ blob: blobs.get(key(i)) }),
      );
      bus.registerService<Where & { blob: Uint8Array }, void>('credentials:store-blob:put', name, async (_ctx, i) => {
        blobs.set(key(i), i.blob);
      });
      bus.registerService('credentials:store-blob:list', name, async () => ({ entries: [] }));
      bus.registerService('credentials:store-blob:purge-by-owner', name, async () => ({ deleted: 0 }));
    },
  };
}

describe('createSecretStore against the real @ax/credentials', () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
  });

  it("never reads a person's own slack: row, not even the connecting admin's", async () => {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [memoryBlobStore(), createCredentialsPlugin()], config: {} });
    const secrets = createSecretStore(bus, { logger: recordingLogger().logger });
    const admin = makeAgentContext({ sessionId: 't', agentId: '', userId: INSTALL.connectedByUserId });
    const forged = 'forged-signing-secret-not-real';

    // A row stored for the connecting admin alone, under the install's own ref.
    await bus.call('credentials:set', admin, {
      scope: 'user',
      ownerId: INSTALL.connectedByUserId,
      ref: secretRef(INSTALL.installId, 'signing-secret'),
      kind: 'api-key',
      payload: new TextEncoder().encode(forged),
    });
    // With no install-wide value there is no secret at all, rather than theirs.
    expect(await secrets.get(INSTALL, 'signing-secret')).toBeNull();

    // With one, it is always the install's.
    await secrets.put(INSTALL, 'signing-secret', VALUES['signing-secret']);
    expect(await secrets.get(INSTALL, 'signing-secret')).toBe(VALUES['signing-secret']);

    // And deleting the install's value doesn't uncover theirs.
    await secrets.remove(INSTALL, 'signing-secret');
    expect(await secrets.get(INSTALL, 'signing-secret')).toBeNull();
  });
});
