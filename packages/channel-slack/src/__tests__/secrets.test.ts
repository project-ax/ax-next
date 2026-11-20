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
import {
  PERSON_ID_RE,
  SECRET_NAMES,
  configTokenRef,
  createSecretStore,
  secretRef,
  type SecretName,
  type SecretOwner,
} from '../secrets.js';

const INSTALL = { installId: 'q3VtZ0xH4kTn9Wb2LmPa1A', connectedByUserId: 'usr_admin1' } as const;

// The configuration token is one per PERSON (TASK-1175): two apps of Ada's
// share hers, and Grace has her own.
const ADA_APP: SecretOwner = { installId: INSTALL.installId, connectedByUserId: 'usr_ada' };
const ADA_OTHER_APP: SecretOwner = { installId: 'Zx8_n2-QpL4mVb7cRt1sYw', connectedByUserId: 'usr_ada' };
const GRACE_APP: SecretOwner = { installId: 'Mm0rT7qWc3Yb9Vn2Ls5KdA', connectedByUserId: 'usr_grace' };
const ADA_TOKEN = fakeConfigRefreshToken('ADAPERSONREFRESHSECRET');
const GRACE_TOKEN = fakeConfigRefreshToken('GRACEPERSONREFRESHSECRET');
/** better-auth's own user id shape: 32 letters and digits. */
const BETTER_AUTH_ID = 'Xq7Rk2Lm9Pz4Wb8Nc3Vt6Yh1Jd5Fs0Ga';
/** The longest id a person may have: the vault's user-id limit. */
const LONGEST_ID = 'x'.repeat(128);

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
    // @ts-expect-error — put's type no longer takes the configuration token's name (TASK-1175); at runtime it still writes one, as a build from before it did
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

  it("an install's old configuration refresh token that will not delete is logged at warn: the boot move empties it once its person's move succeeds, and logs an error when that fails (TASK-1175)", async () => {
    const vault = fakeVault({
      hook: 'credentials:delete',
      ref: secretRef(INSTALL.installId, 'config-refresh-token'),
      error: new PluginError({
        code: 'timeout',
        plugin: '@ax/credentials',
        message: `vault slow for ${VALUES['config-refresh-token']}`,
      }),
    });
    const { logger, lines } = recordingLogger();
    const secrets = createSecretStore(vault.bus, { logger });
    await expect(secrets.removeAll({ installId: INSTALL.installId })).resolves.toBeUndefined();
    expect(lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_secret_remove_failed',
        fields: { installId: INSTALL.installId, stage: 'config-refresh-token', code: 'timeout' },
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
    // @ts-expect-error — put's type no longer takes the configuration token's name (TASK-1175); this plants the old per-install row a build from before it left
    for (const name of SECRET_NAMES) await secrets.put(INSTALL, name, VALUES[name]);
    for (const name of SECRET_NAMES) await secrets.get(INSTALL, name);
    await secrets.removeAll(INSTALL);

    // A person's configuration token (TASK-1175): stored, read back, and a
    // delete whose fault quotes it and its ref.
    const personVault = fakeVault({
      hook: 'credentials:delete',
      ref: configTokenRef(ADA_APP.connectedByUserId),
      error: new Error(`delete failed for ${ADA_TOKEN} at ${configTokenRef(ADA_APP.connectedByUserId)}`),
    });
    const people = createSecretStore(personVault.bus, { logger });
    await people.putConfigToken(ADA_APP, ADA_TOKEN);
    expect(await people.getConfigToken(ADA_APP)).toBe(ADA_TOKEN);
    await people.removeConfigToken(ADA_APP);
    // An id that can't name a ref: refused without quoting the value it was handed.
    const unnamed = { ...ADA_APP, connectedByUserId: 'ada@example.com' };
    const refused: unknown = await people.putConfigToken(unnamed, ADA_TOKEN).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).not.toContain(ADA_TOKEN);
    expect(JSON.stringify(refused)).not.toContain(ADA_TOKEN);
    await people.removeConfigToken(unnamed);

    // The failures did reach the log, so the checks below are not vacuous.
    expect(lines.map((l) => [l.level, l.fields?.['stage'], l.fields?.['code']])).toEqual([
      ['warn', 'bot-token', 'unknown'],
      ['error', 'person-config-refresh-token', 'unknown'],
      ['error', 'person-config-refresh-token', 'invalid-person-id'],
    ]);
    const logged = JSON.stringify(lines);
    for (const value of [...Object.values(VALUES), ADA_TOKEN]) expect(logged).not.toContain(value);
    // Nor whose token it is: a line names the app, never the person.
    for (const person of ['usr_ada', 'ada@example.com']) expect(logged).not.toContain(person);
  });
});

describe('the configuration token, one per person (TASK-1175)', () => {
  it('S1 configTokenRef is slack:person:<id>:config-refresh-token', () => {
    expect(configTokenRef('usr_ada')).toBe('slack:person:usr_ada:config-refresh-token');
    expect(BETTER_AUTH_ID).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(configTokenRef(BETTER_AUTH_ID)).toBe(`slack:person:${BETTER_AUTH_ID}:config-refresh-token`);
    expect(configTokenRef(LONGEST_ID)).toBe(`slack:person:${LONGEST_ID}:config-refresh-token`);
    // The setup admin's `usr_` + hex, and the separators an id may hold.
    for (const id of ['usr_0123456789abcdef0123456789abcdef', 'a.b-c_d']) {
      expect(configTokenRef(id)).toBe(`slack:person:${id}:config-refresh-token`);
    }
    for (const id of ['usr_ada', BETTER_AUTH_ID, LONGEST_ID, 'a.b-c_d']) expect(PERSON_ID_RE.test(id), id).toBe(true);
  });

  it('S2 configTokenRef refuses an id that cannot name a vault ref, before any vault call', async () => {
    // `null` and `undefined` included: a RegExp test would read them as the
    // text "null" and "undefined", which look like ids.
    const refusedIds: unknown[] = ['', 'ada@example.com', 'a:b', 'a/b', '-x', 'a b', 'x'.repeat(129), null, undefined, 42];
    const messages = new Set<string>();
    for (const id of refusedIds) {
      const label = String(id);
      let thrown: unknown;
      try {
        configTokenRef(id as string);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, label).toBeInstanceOf(Error);
      expect((thrown as { code?: unknown }).code, label).toBe('invalid-person-id');
      // A fixed message: it never quotes the id.
      messages.add((thrown as Error).message);
      if (label.length > 0) {
        expect((thrown as Error).message, label).not.toContain(label);
        expect(JSON.stringify(thrown), label).not.toContain(label);
      }
      if (typeof id === 'string') expect(PERSON_ID_RE.test(id), label).toBe(false);

      const vault = fakeVault();
      const { logger, lines } = recordingLogger();
      const secrets = createSecretStore(vault.bus, { logger });
      const app = { installId: INSTALL.installId, connectedByUserId: id as string };
      await expect(secrets.getConfigToken(app), label).rejects.toMatchObject({ code: 'invalid-person-id' });
      await expect(secrets.putConfigToken(app, ADA_TOKEN), label).rejects.toMatchObject({ code: 'invalid-person-id' });
      await expect(secrets.removeConfigToken(app), label).resolves.toBeUndefined();
      expect(lines, label).toEqual([
        {
          level: 'error',
          msg: 'slack_secret_remove_failed',
          fields: { installId: INSTALL.installId, stage: 'person-config-refresh-token', code: 'invalid-person-id' },
        },
      ]);
      expect(vault.calls, label).toEqual([]);
    }
    expect(messages.size).toBe(1);
  });

  it("S3 putConfigToken writes the global api-key row under the person's ref, as that person", async () => {
    const vault = fakeVault();
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });
    await secrets.putConfigToken(ADA_APP, ADA_TOKEN);

    expect(vault.calls.map((c) => c.hook)).toEqual(['credentials:set']);
    const { input, ctx } = vault.calls[0]!;
    // Exactly these fields: no metadata, no expiry, nothing listed beside the ref.
    expect(Object.keys(input).sort()).toEqual(['kind', 'ownerId', 'payload', 'ref', 'scope']);
    expect(input).toMatchObject({
      scope: 'global',
      ownerId: null,
      ref: configTokenRef('usr_ada'),
      kind: 'api-key',
    });
    expect(input['payload']).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(input['payload'] as Uint8Array).toString('utf8')).toBe(ADA_TOKEN);
    expect(ctx.userId).toBe('usr_ada');
    expect(ctx.agentId).toBe('');
    // Never under the install's own ref.
    expect([...vault.rows.keys()]).toEqual([configTokenRef('usr_ada')]);

    // An empty value is refused before the vault.
    const empty = fakeVault();
    const s2 = createSecretStore(empty.bus, { logger: recordingLogger().logger });
    await expect(s2.putConfigToken(ADA_APP, '')).rejects.toThrow();
    expect(empty.calls).toHaveLength(0);
  });

  it('S4 getConfigToken reads the global row only, as the person; two installs of one person read one ref, another person reads another', async () => {
    const vault = fakeVault();
    const secrets = createSecretStore(vault.bus, { logger: recordingLogger().logger });
    await secrets.putConfigToken(ADA_APP, ADA_TOKEN);
    // A token Grace's install held before TASK-1175 is not hers to read here.
    vault.rows.set(secretRef(GRACE_APP.installId, 'config-refresh-token'), Buffer.from(GRACE_TOKEN));
    vault.calls.length = 0;

    expect(await secrets.getConfigToken(ADA_APP)).toBe(ADA_TOKEN);
    expect(await secrets.getConfigToken(ADA_OTHER_APP)).toBe(ADA_TOKEN);
    expect(await secrets.getConfigToken(GRACE_APP)).toBeNull();
    expect(vault.calls.map((c) => [c.hook, c.input, c.ctx.userId, c.ctx.agentId])).toEqual([
      ['credentials:get', { ref: configTokenRef('usr_ada'), userId: 'usr_ada', scope: 'global' }, 'usr_ada', ''],
      ['credentials:get', { ref: configTokenRef('usr_ada'), userId: 'usr_ada', scope: 'global' }, 'usr_ada', ''],
      ['credentials:get', { ref: configTokenRef('usr_grace'), userId: 'usr_grace', scope: 'global' }, 'usr_grace', ''],
    ]);

    // Once Grace has her own, each person reads only theirs.
    await secrets.putConfigToken(GRACE_APP, GRACE_TOKEN);
    expect(await secrets.getConfigToken(GRACE_APP)).toBe(GRACE_TOKEN);
    expect(await secrets.getConfigToken(ADA_OTHER_APP)).toBe(ADA_TOKEN);

    // An empty stored value is as good as none.
    vault.rows.set(configTokenRef('usr_ada'), new Uint8Array());
    expect(await secrets.getConfigToken(ADA_APP)).toBeNull();

    // Any other fault is not "none stored".
    const decryptFailed = new PluginError({
      code: 'decrypt-failed',
      plugin: '@ax/credentials',
      message: 'credential decrypt failed',
    });
    const broken = fakeVault({ hook: 'credentials:get', ref: configTokenRef('usr_ada'), error: decryptFailed });
    const s2 = createSecretStore(broken.bus, { logger: recordingLogger().logger });
    await expect(s2.getConfigToken(ADA_APP)).rejects.toBe(decryptFailed);
    const down = fakeVault({
      hook: 'credentials:get',
      ref: configTokenRef('usr_ada'),
      error: new Error('connection terminated'),
    });
    const s3 = createSecretStore(down.bus, { logger: recordingLogger().logger });
    await expect(s3.getConfigToken(ADA_APP)).rejects.toMatchObject({ code: 'unknown' });
  });

  it('S5 removeConfigToken deletes as the person; a failure is logged at error with the install, stage person-config-refresh-token and a code, and never throws', async () => {
    const vault = fakeVault();
    vault.rows.set(configTokenRef('usr_ada'), Buffer.from(ADA_TOKEN));
    vault.rows.set(configTokenRef('usr_grace'), Buffer.from(GRACE_TOKEN));
    const { logger, lines } = recordingLogger();
    const secrets = createSecretStore(vault.bus, { logger });

    await expect(secrets.removeConfigToken(ADA_OTHER_APP)).resolves.toBeUndefined();
    expect(vault.calls.map((c) => [c.hook, c.input, c.ctx.userId, c.ctx.agentId])).toEqual([
      ['credentials:delete', { scope: 'global', ownerId: null, ref: configTokenRef('usr_ada') }, 'usr_ada', ''],
    ]);
    // Ada's one token is gone for every app of hers; Grace's stays.
    expect(await secrets.getConfigToken(ADA_APP)).toBeNull();
    expect(await secrets.getConfigToken(GRACE_APP)).toBe(GRACE_TOKEN);
    expect(lines).toEqual([]);

    const failing = fakeVault({
      hook: 'credentials:delete',
      ref: configTokenRef('usr_ada'),
      // A message that quotes things a log line must never carry.
      error: new PluginError({
        code: 'timeout',
        plugin: '@ax/credentials',
        message: `vault slow for ${ADA_TOKEN} at ${configTokenRef('usr_ada')}`,
      }),
    });
    const failed = recordingLogger();
    const s2 = createSecretStore(failing.bus, { logger: failed.logger });
    await expect(s2.removeConfigToken(ADA_APP)).resolves.toBeUndefined();
    expect(failed.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_secret_remove_failed',
        fields: { installId: ADA_APP.installId, stage: 'person-config-refresh-token', code: 'timeout' },
      },
    ]);

    // Not even a logger that throws makes it throw.
    const throwing: Logger = {
      ...failed.logger,
      error: () => {
        throw new Error('log sink down');
      },
    };
    const s3 = createSecretStore(failing.bus, { logger: throwing });
    await expect(s3.removeConfigToken(ADA_APP)).resolves.toBeUndefined();
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

  it("S6 a person's token is theirs alone: a user-scoped row under their ref, stored by them or by anyone else, never stands in; deleting the global one doesn't uncover it", async () => {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [memoryBlobStore(), createCredentialsPlugin()], config: {} });
    const secrets = createSecretStore(bus, { logger: recordingLogger().logger });

    // The longest id too: the vault's own ref pattern takes every ref we build.
    for (const person of ['usr_ada', BETTER_AUTH_ID, LONGEST_ID]) {
      const app: SecretOwner = { installId: INSTALL.installId, connectedByUserId: person };
      const ref = configTokenRef(person);
      // Rows planted under the person's ref that are not the global one: the
      // person's own, another person's, and an agent's. The vault doesn't
      // check who writes a row, so "by them" and "by anyone else" land alike.
      const planted: Array<{ by: string; scope: 'user' | 'agent'; ownerId: string }> = [
        { by: person, scope: 'user', ownerId: person },
        { by: 'usr_mallory', scope: 'user', ownerId: person },
        { by: 'usr_mallory', scope: 'user', ownerId: 'usr_mallory' },
        { by: 'usr_mallory', scope: 'agent', ownerId: 'agt_mallory' },
      ];
      for (const row of planted) {
        await bus.call('credentials:set', makeAgentContext({ sessionId: 't', agentId: '', userId: row.by }), {
          scope: row.scope,
          ownerId: row.ownerId,
          ref,
          kind: 'api-key',
          payload: new TextEncoder().encode(`forged-by-${row.by}-not-a-token`),
        });
      }
      // With no global value there is no token at all, rather than a planted one.
      expect(await secrets.getConfigToken(app), person).toBeNull();

      // With one, it is always the global one.
      await secrets.putConfigToken(app, ADA_TOKEN);
      expect(await secrets.getConfigToken(app), person).toBe(ADA_TOKEN);

      // And deleting it doesn't uncover a planted one.
      await secrets.removeConfigToken(app);
      expect(await secrets.getConfigToken(app), person).toBeNull();
    }
  });
});
