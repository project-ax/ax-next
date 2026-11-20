import { HookBus, PluginError, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { moveConfigTokens, releaseConfigToken } from '../config-tokens.js';
import { createSecretStore, type SecretOwner } from '../secrets.js';
import type { InstallRow, InstallStore } from '../store.js';
import { fakeConfigRefreshToken } from './fake-slack-tokens.js';

/**
 * TASK-1175: the boot move of each install's old configuration token to its
 * person, and releasing a person's token once nothing names them. The secret
 * store is the real one, on the real bus, over a fake vault; the install store
 * is a fake of the two reads these use.
 */

const ADA = 'usr_ada';
const GRACE = 'usr_grace';

// Distinctive, so a leak into a log line is easy to spot. Built from pieces
// (fake-slack-tokens.ts), so no token-shaped literal is in source.
const TOKEN = {
  adaOlder: fakeConfigRefreshToken('ADAOLDERINSTALLREFRESH'),
  adaNewer: fakeConfigRefreshToken('ADANEWERINSTALLREFRESH'),
  /** What Ada's own slot already holds. */
  adaPerson: fakeConfigRefreshToken('ADAPERSONREFRESH'),
  /** What a rotate stored in Ada's slot after it was filled. */
  adaRotated: fakeConfigRefreshToken('ADAROTATEDSINCEREFRESH'),
  grace: fakeConfigRefreshToken('GRACEINSTALLREFRESH'),
};

// Spelled out here, not built by secrets.ts, so the refs are checked, not echoed.
/** Where an install kept its configuration token before TASK-1175. */
const oldRef = (install: Pick<InstallRow, 'installId'>): string =>
  `slack:${install.installId}:config-refresh-token`;
/** Where a person's one configuration token lives since TASK-1175. */
const personRef = (userId: string): string => `slack:person:${userId}:config-refresh-token`;

function row(r: Pick<InstallRow, 'installId' | 'connectedByUserId' | 'configTokenAddedAt'>): InstallRow {
  return {
    installId: r.installId,
    status: 'active',
    appId: 'A07QF9ZK2MN',
    clientId: '7512345678901.7598765432109',
    botName: 'Canopy Bot',
    teamId: 'T07ABCDEF12',
    teamName: 'Canopy Works',
    botUserId: 'U07BOTUSER1',
    connectedByUserId: r.connectedByUserId,
    createdAt: r.configTokenAddedAt,
    configTokenAddedAt: r.configTokenAddedAt,
    installedAt: r.configTokenAddedAt,
  };
}

// The ids sort the other way from the token dates, so only "the most recently
// added token first" picks Ada's newer install.
const ADA_OLDER = row({
  installId: 'adaInstallA00000000001',
  connectedByUserId: ADA,
  configTokenAddedAt: new Date('2026-10-01T09:00:00Z'),
});
const ADA_NEWER = row({
  installId: 'adaInstallB00000000002',
  connectedByUserId: ADA,
  configTokenAddedAt: new Date('2026-11-01T09:00:00Z'),
});
const GRACE_APP = row({
  installId: 'graceInstall0000000003',
  connectedByUserId: GRACE,
  configTokenAddedAt: new Date('2026-10-15T09:00:00Z'),
});

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

interface VaultCall {
  hook: string;
  ref: string;
  /** Who the call was made as. */
  userId: string;
}

/**
 * The real bus with a fake vault behind the three credentials hooks: values
 * by ref, and a missing ref answers like `@ax/credentials` does. A `faults`
 * entry (`<hook> <ref>`) makes that call throw, until it is removed.
 */
function fakeVault() {
  const bus = new HookBus();
  const rows = new Map<string, string>();
  const calls: VaultCall[] = [];
  const faults = new Map<string, unknown>();
  const record = (hook: string, ctx: AgentContext, input: unknown): Record<string, unknown> => {
    const i = input as Record<string, unknown>;
    const ref = i['ref'] as string;
    calls.push({ hook, ref, userId: ctx.userId });
    const fault = faults.get(`${hook} ${ref}`);
    if (fault !== undefined) throw fault;
    return i;
  };
  bus.registerService('credentials:set', '@ax/credentials', async (ctx, input) => {
    const i = record('credentials:set', ctx, input);
    rows.set(i['ref'] as string, new TextDecoder().decode(i['payload'] as Uint8Array));
  });
  bus.registerService('credentials:get', '@ax/credentials', async (ctx, input) => {
    const i = record('credentials:get', ctx, input);
    const value = rows.get(i['ref'] as string);
    if (value === undefined) {
      throw new PluginError({
        code: 'credential-not-found',
        plugin: '@ax/credentials',
        message: `no credential for ref='${String(i['ref'])}'`,
      });
    }
    return value;
  });
  bus.registerService('credentials:delete', '@ax/credentials', async (ctx, input) => {
    const i = record('credentials:delete', ctx, input);
    rows.delete(i['ref'] as string);
  });
  return { bus, rows, calls, faults };
}

/**
 * The install store's two reads. `list` orders as the real one does: the most
 * recently added configuration token first, then install id. `personHasApps`
 * answers from the installs and the leftover apps' persons (null: an app left
 * before TASK-1175, which names no one).
 */
function fakeStore(installs: InstallRow[], leftovers: Array<string | null>) {
  const faults: { list?: unknown; check?: unknown } = {};
  /** Every person `personHasApps` was asked about, in order. */
  const asked: string[] = [];
  const store: Pick<InstallStore, 'list' | 'personHasApps'> = {
    async list() {
      if (faults.list !== undefined) throw faults.list;
      return [...installs].sort(
        (a, b) =>
          b.configTokenAddedAt.getTime() - a.configTokenAddedAt.getTime() ||
          (a.installId < b.installId ? -1 : a.installId > b.installId ? 1 : 0),
      );
    },
    async personHasApps(userId) {
      asked.push(userId);
      if (faults.check !== undefined) throw faults.check;
      return installs.some((i) => i.connectedByUserId === userId) || leftovers.includes(userId);
    },
  };
  return { store, faults, asked };
}

function world(o: { installs?: InstallRow[]; leftovers?: Array<string | null> } = {}) {
  const vault = fakeVault();
  const { logger, lines } = recordingLogger();
  // One logger for both, so the secret store's own lines (a failed delete)
  // land beside the move's, in order.
  const secrets = createSecretStore(vault.bus, { logger });
  const { store, faults: storeFaults, asked } = fakeStore(o.installs ?? [], o.leftovers ?? []);
  return {
    vault,
    lines,
    storeFaults,
    asked,
    move: () => moveConfigTokens({ store, secrets, logger }),
    release: (
      app: SecretOwner,
      opts: { onFault: (err: unknown, step: 'check' | 'read') => void; onlyIfStored?: boolean },
    ) =>
      releaseConfigToken({ store, secrets }, app, opts),
  };
}

/** A vault failure whose message quotes whatever it is given. */
const vaultFault = (code: string, quoting = ''): PluginError =>
  new PluginError({ code, plugin: '@ax/credentials', message: `vault failed ${quoting}` });

/** A database failure behind the vault: a plain error, which the bus wraps as `unknown`. */
const dbFault = (sqlstate: string, quoting = ''): Error =>
  Object.assign(new Error(`terminating connection ${quoting}`), { code: sqlstate });

const moveFailed = (fields: Record<string, unknown>): Line => ({
  level: 'error',
  msg: 'slack_config_token_move_failed',
  fields,
});
const movedLine = (moved: number, dropped: number): Line => ({
  level: 'info',
  msg: 'slack_config_tokens_moved',
  fields: { moved, dropped },
});
const writesAndDeletes = (calls: VaultCall[]): VaultCall[] => calls.filter((c) => c.hook !== 'credentials:get');

describe("moveConfigTokens: at boot, each install's old configuration token moves to its person (TASK-1175)", () => {
  it("M1 moves an install's token to its person and deletes the old one", async () => {
    const w = world({ installs: [ADA_NEWER] });
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 0 });

    expect(w.vault.rows).toEqual(new Map([['slack:person:usr_ada:config-refresh-token', TOKEN.adaNewer]]));
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_config_tokens_moved', fields: { moved: 1, dropped: 0 } },
    ]);
  });

  it('M2 a second run writes nothing, deletes nothing and logs nothing', async () => {
    const w = world({ installs: [ADA_NEWER] });
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    await w.move();
    w.vault.calls.length = 0;
    w.lines.length = 0;

    await expect(w.move()).resolves.toEqual({ moved: 0, dropped: 0 });

    expect(writesAndDeletes(w.vault.calls)).toEqual([]);
    expect(w.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaNewer]]));
    expect(w.lines).toEqual([]);
  });

  it('M2 with no installs, or none holding an old token, it writes nothing, deletes nothing and logs nothing', async () => {
    const empty = world();
    await expect(empty.move()).resolves.toEqual({ moved: 0, dropped: 0 });
    expect(empty.vault.calls).toEqual([]);
    expect(empty.lines).toEqual([]);

    // Installs made since TASK-1175: no install holds a token of its own.
    const since = world({ installs: [ADA_NEWER, GRACE_APP] });
    since.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    await expect(since.move()).resolves.toEqual({ moved: 0, dropped: 0 });
    expect(writesAndDeletes(since.vault.calls)).toEqual([]);
    expect(since.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaPerson]]));
    expect(since.lines).toEqual([]);
  });

  it('M3 two installs of one person: the most recently added token wins, both old rows go', async () => {
    const w = world({ installs: [ADA_OLDER, ADA_NEWER] });
    w.vault.rows.set(oldRef(ADA_OLDER), TOKEN.adaOlder);
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 1 });

    expect(w.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaNewer]]));
    expect(w.lines).toEqual([movedLine(1, 1)]);
  });

  it('M4 a person token that is already there is never overwritten: the old row is dropped', async () => {
    const w = world({ installs: [ADA_NEWER] });
    w.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);

    await expect(w.move()).resolves.toEqual({ moved: 0, dropped: 1 });

    expect(w.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaPerson]]));
    expect(w.vault.calls.filter((c) => c.hook === 'credentials:set')).toEqual([]);
    expect(w.lines).toEqual([movedLine(0, 1)]);
  });

  it('M5 two people each get their own', async () => {
    const w = world({ installs: [ADA_NEWER, GRACE_APP] });
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    w.vault.rows.set(oldRef(GRACE_APP), TOKEN.grace);

    await expect(w.move()).resolves.toEqual({ moved: 2, dropped: 0 });

    expect(w.vault.rows).toEqual(
      new Map([
        [personRef(ADA), TOKEN.adaNewer],
        [personRef(GRACE), TOKEN.grace],
      ]),
    );
    expect(w.lines).toEqual([movedLine(2, 0)]);
  });

  it('M6 the install list failing is logged with stage list, and nothing else happens', async () => {
    const w = world({ installs: [ADA_NEWER] });
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    w.storeFaults.list = dbFault('57P01');

    await expect(w.move()).resolves.toEqual({ moved: 0, dropped: 0 });

    expect(w.vault.calls).toEqual([]);
    expect(w.vault.rows).toEqual(new Map([[oldRef(ADA_NEWER), TOKEN.adaNewer]]));
    expect(w.lines).toEqual([moveFailed({ stage: 'list', code: '57P01' })]);
  });

  it("M6 reading the newer install's old token failing leaves both of that person's old rows and stores nothing for them; others still move", async () => {
    const w = world({ installs: [ADA_OLDER, ADA_NEWER, GRACE_APP] });
    w.vault.rows.set(oldRef(ADA_OLDER), TOKEN.adaOlder);
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    w.vault.rows.set(oldRef(GRACE_APP), TOKEN.grace);
    w.vault.faults.set(`credentials:get ${oldRef(ADA_NEWER)}`, vaultFault('invalid-envelope'));

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 0 });

    // The older token never stands in for the newer one it can't see.
    expect(w.vault.rows).toEqual(
      new Map([
        [oldRef(ADA_OLDER), TOKEN.adaOlder],
        [oldRef(ADA_NEWER), TOKEN.adaNewer],
        [personRef(GRACE), TOKEN.grace],
      ]),
    );
    expect(w.lines).toEqual([
      moveFailed({ installId: ADA_NEWER.installId, stage: 'read-install-token', code: 'invalid-envelope' }),
      movedLine(1, 0),
    ]);
  });

  it("M6 reading the person's own token failing leaves that person untouched; others still move", async () => {
    const w = world({ installs: [ADA_NEWER, GRACE_APP] });
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    w.vault.rows.set(oldRef(GRACE_APP), TOKEN.grace);
    w.vault.faults.set(`credentials:get ${personRef(ADA)}`, vaultFault('invalid-envelope'));

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 0 });

    // Not "none stored": whatever is there may be newer, so nothing is written over it.
    expect(w.vault.calls.filter((c) => c.ref === personRef(ADA)).map((c) => c.hook)).toEqual(['credentials:get']);
    expect(w.vault.rows).toEqual(
      new Map([
        [oldRef(ADA_NEWER), TOKEN.adaNewer],
        [personRef(GRACE), TOKEN.grace],
      ]),
    );
    expect(w.lines).toEqual([
      moveFailed({ installId: ADA_NEWER.installId, stage: 'read-person-token', code: 'invalid-envelope' }),
      movedLine(1, 0),
    ]);
  });

  it("M6 storing the person's token failing deletes none of that person's old rows; others still move", async () => {
    const w = world({ installs: [ADA_OLDER, ADA_NEWER, GRACE_APP] });
    w.vault.rows.set(oldRef(ADA_OLDER), TOKEN.adaOlder);
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    w.vault.rows.set(oldRef(GRACE_APP), TOKEN.grace);
    w.vault.faults.set(`credentials:set ${personRef(ADA)}`, dbFault('57P01'));

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 0 });

    expect(w.vault.calls.filter((c) => c.hook === 'credentials:delete').map((c) => c.ref)).toEqual([
      oldRef(GRACE_APP),
    ]);
    expect(w.vault.rows).toEqual(
      new Map([
        [oldRef(ADA_OLDER), TOKEN.adaOlder],
        [oldRef(ADA_NEWER), TOKEN.adaNewer],
        [personRef(GRACE), TOKEN.grace],
      ]),
    );
    expect(w.lines).toEqual([
      moveFailed({ installId: ADA_NEWER.installId, stage: 'store-person-token', code: '57P01' }),
      movedLine(1, 0),
    ]);
  });

  it('M7 an old row whose delete fails is logged by the secret store, and the next run drops it without touching the person token', async () => {
    const w = world({ installs: [ADA_NEWER] });
    w.vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    w.vault.faults.set(`credentials:delete ${oldRef(ADA_NEWER)}`, vaultFault('timeout'));

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 0 });

    expect(w.vault.rows).toEqual(
      new Map([
        [oldRef(ADA_NEWER), TOKEN.adaNewer],
        [personRef(ADA), TOKEN.adaNewer],
      ]),
    );
    expect(w.lines).toEqual([
      {
        // The old per-install row: a warning, told apart from a person's token by its stage.
        level: 'warn',
        msg: 'slack_secret_remove_failed',
        fields: { installId: ADA_NEWER.installId, stage: 'config-refresh-token', code: 'timeout' },
      },
      movedLine(1, 0),
    ]);

    // Before the next boot, a rotate spent the moved token and stored its
    // successor: the old row is now a retired original.
    w.vault.rows.set(personRef(ADA), TOKEN.adaRotated);
    w.vault.faults.clear();
    w.vault.calls.length = 0;
    w.lines.length = 0;

    await expect(w.move()).resolves.toEqual({ moved: 0, dropped: 1 });

    expect(w.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaRotated]]));
    expect(w.vault.calls.filter((c) => c.hook === 'credentials:set')).toEqual([]);
    expect(w.lines).toEqual([movedLine(0, 1)]);
  });

  it('M8 an install whose person id cannot name a ref is skipped: its old row stays, and the others still move', async () => {
    const UNNAMED = row({
      installId: 'unnamedInstall00000004',
      connectedByUserId: 'ada@example.com',
      configTokenAddedAt: new Date('2026-11-10T09:00:00Z'),
    });
    const w = world({ installs: [UNNAMED, GRACE_APP] });
    w.vault.rows.set(oldRef(UNNAMED), TOKEN.adaNewer);
    w.vault.rows.set(oldRef(GRACE_APP), TOKEN.grace);

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 0 });

    expect(w.vault.rows).toEqual(
      new Map([
        [oldRef(UNNAMED), TOKEN.adaNewer],
        [personRef(GRACE), TOKEN.grace],
      ]),
    );
    // No ref was built from that id.
    expect(w.vault.calls.filter((c) => c.ref.includes('ada@example.com'))).toEqual([]);
    expect(w.lines).toEqual([
      moveFailed({ installId: UNNAMED.installId, stage: 'read-person-token', code: 'invalid-person-id' }),
      movedLine(1, 0),
    ]);
  });

  it('M9 no line or return value carries a token value or a person id', async () => {
    // One person for each way a move can fail, one whose token moves (its old
    // row then won't delete) and one whose slot is already full.
    const at = (day: number): Date => new Date(Date.UTC(2026, 10, day, 9));
    const people = {
      ada: ADA,
      grace: GRACE,
      hopper: 'usr_hopper',
      lin: 'usr_lin',
      kay: 'kay@example.com',
      max: 'usr_max',
    };
    const tokens = {
      ...TOKEN,
      hopper: fakeConfigRefreshToken('HOPPERINSTALLREFRESH'),
      lin: fakeConfigRefreshToken('LININSTALLREFRESH'),
      kay: fakeConfigRefreshToken('KAYINSTALLREFRESH'),
      max: fakeConfigRefreshToken('MAXINSTALLREFRESH'),
      maxPerson: fakeConfigRefreshToken('MAXPERSONREFRESH'),
    };
    const installs = {
      adaOlder: row({ installId: 'm9AdaOlder000000000001', connectedByUserId: people.ada, configTokenAddedAt: at(1) }),
      adaNewer: row({ installId: 'm9AdaNewer000000000002', connectedByUserId: people.ada, configTokenAddedAt: at(9) }),
      grace: row({ installId: 'm9Grace000000000000003', connectedByUserId: people.grace, configTokenAddedAt: at(8) }),
      hopper: row({ installId: 'm9Hopper00000000000004', connectedByUserId: people.hopper, configTokenAddedAt: at(7) }),
      lin: row({ installId: 'm9Lin00000000000000005', connectedByUserId: people.lin, configTokenAddedAt: at(6) }),
      kay: row({ installId: 'm9Kay00000000000000006', connectedByUserId: people.kay, configTokenAddedAt: at(5) }),
      max: row({ installId: 'm9Max00000000000000007', connectedByUserId: people.max, configTokenAddedAt: at(4) }),
    };
    const w = world({ installs: Object.values(installs) });
    w.vault.rows.set(oldRef(installs.adaOlder), tokens.adaOlder);
    w.vault.rows.set(oldRef(installs.adaNewer), tokens.adaNewer);
    w.vault.rows.set(oldRef(installs.grace), tokens.grace);
    w.vault.rows.set(oldRef(installs.hopper), tokens.hopper);
    w.vault.rows.set(oldRef(installs.lin), tokens.lin);
    w.vault.rows.set(oldRef(installs.kay), tokens.kay);
    w.vault.rows.set(oldRef(installs.max), tokens.max);
    w.vault.rows.set(personRef(people.max), tokens.maxPerson);

    // Every fault quotes every token, person and ref there is.
    const everything = [...Object.values(tokens), ...Object.values(people), ...w.vault.rows.keys()].join(' ');
    w.vault.faults.set(`credentials:get ${oldRef(installs.adaNewer)}`, vaultFault('invalid-envelope', everything));
    w.vault.faults.set(`credentials:get ${personRef(people.grace)}`, dbFault('57P01', everything));
    w.vault.faults.set(`credentials:set ${personRef(people.hopper)}`, vaultFault('invalid-payload', everything));
    w.vault.faults.set(`credentials:delete ${oldRef(installs.lin)}`, dbFault('57P01', everything));

    const result = await w.move();
    w.storeFaults.list = dbFault('08006', everything);
    const afterListFault = await w.move();

    expect(result).toEqual({ moved: 1, dropped: 1 });
    expect(afterListFault).toEqual({ moved: 0, dropped: 0 });
    // Every failure did reach the log, so the checks below are not vacuous.
    expect(w.lines.map((l) => [l.level, l.msg, l.fields?.['installId'] ?? null, l.fields?.['stage'] ?? null])).toEqual([
      ['error', 'slack_config_token_move_failed', installs.adaNewer.installId, 'read-install-token'],
      ['error', 'slack_config_token_move_failed', installs.grace.installId, 'read-person-token'],
      ['error', 'slack_config_token_move_failed', installs.hopper.installId, 'store-person-token'],
      ['warn', 'slack_secret_remove_failed', installs.lin.installId, 'config-refresh-token'],
      ['error', 'slack_config_token_move_failed', installs.kay.installId, 'read-person-token'],
      ['info', 'slack_config_tokens_moved', null, null],
      ['error', 'slack_config_token_move_failed', null, 'list'],
    ]);

    const allowed = new Set(['installId', 'stage', 'code', 'moved', 'dropped']);
    for (const line of w.lines) {
      expect(Object.keys(line.fields ?? {}).filter((k) => !allowed.has(k)), line.msg).toEqual([]);
    }
    const logged = JSON.stringify([w.lines, result, afterListFault]);
    for (const value of Object.values(tokens)) expect(logged).not.toContain(value);
    for (const person of Object.values(people)) expect(logged).not.toContain(person);
  });

  it("M10 a logger that throws can't fail the boot or stop anyone else's move", async () => {
    const down = (): void => {
      throw new Error('log sink down');
    };
    const logger: Logger = { debug: down, info: down, warn: down, error: down, child: () => logger };
    const vault = fakeVault();
    const secrets = createSecretStore(vault.bus, { logger });
    const { store, faults } = fakeStore([ADA_NEWER, GRACE_APP], []);
    vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    vault.rows.set(oldRef(GRACE_APP), TOKEN.grace);
    // Ada's token is the newest, so her failure is logged first; Grace's move
    // and the closing count come after it.
    vault.faults.set(`credentials:get ${personRef(ADA)}`, vaultFault('invalid-envelope'));

    await expect(moveConfigTokens({ store, secrets, logger })).resolves.toEqual({ moved: 1, dropped: 0 });
    expect(vault.rows).toEqual(
      new Map([
        [oldRef(ADA_NEWER), TOKEN.adaNewer],
        [personRef(GRACE), TOKEN.grace],
      ]),
    );

    faults.list = dbFault('57P01');
    await expect(moveConfigTokens({ store, secrets, logger })).resolves.toEqual({ moved: 0, dropped: 0 });
  });

  it("M11 the newest install holding no old token: the newest one that does is the one that moves", async () => {
    const w = world({ installs: [ADA_OLDER, ADA_NEWER] });
    w.vault.rows.set(oldRef(ADA_OLDER), TOKEN.adaOlder);

    await expect(w.move()).resolves.toEqual({ moved: 1, dropped: 0 });

    expect(w.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaOlder]]));
    expect(w.lines).toEqual([movedLine(1, 0)]);
  });

  it("M12 a secret store that throws where it promised not to can't fail the boot or stop anyone else's move", async () => {
    const vault = fakeVault();
    const { logger, lines } = recordingLogger();
    const real = createSecretStore(vault.bus, { logger });
    const surprise = Object.assign(new Error(`surprise ${TOKEN.adaNewer}`), { code: 'EBROKEN' });
    const secrets = {
      ...real,
      // `remove` promises never to throw; this one does, for Ada's old row only.
      remove: async (install: { installId: string }, name: Parameters<typeof real.remove>[1]) => {
        if (install.installId === ADA_NEWER.installId) throw surprise;
        await real.remove(install, name);
      },
    };
    const { store } = fakeStore([ADA_NEWER, GRACE_APP], []);
    vault.rows.set(oldRef(ADA_NEWER), TOKEN.adaNewer);
    vault.rows.set(oldRef(GRACE_APP), TOKEN.grace);

    await expect(moveConfigTokens({ store, secrets, logger })).resolves.toEqual({ moved: 1, dropped: 0 });

    expect(vault.rows.get(personRef(GRACE))).toBe(TOKEN.grace);
    expect(vault.rows.has(oldRef(GRACE_APP))).toBe(false);
    expect(lines).toEqual([
      moveFailed({ installId: ADA_NEWER.installId, stage: 'move', code: 'EBROKEN' }),
      movedLine(1, 0),
    ]);
    expect(JSON.stringify(lines)).not.toContain(TOKEN.adaNewer);
  });
});

describe('releaseConfigToken: a person keeps their token while anything still names them (TASK-1175)', () => {
  const ADA_APP: SecretOwner = { installId: ADA_NEWER.installId, connectedByUserId: ADA };

  it('X1 deletes the token, as that person, when no install and no leftover names them', async () => {
    // Others' installs and leftovers, and a leftover from before TASK-1175 naming no one.
    const w = world({ installs: [GRACE_APP], leftovers: [GRACE, null] });
    w.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    w.vault.rows.set(personRef(GRACE), TOKEN.grace);
    const faults: unknown[] = [];

    await expect(w.release(ADA_APP, { onFault: (err) => faults.push(err) })).resolves.toBe('released');

    expect(w.asked).toEqual([ADA]);
    expect(w.vault.calls).toEqual([{ hook: 'credentials:delete', ref: personRef(ADA), userId: ADA }]);
    expect(w.vault.rows).toEqual(new Map([[personRef(GRACE), TOKEN.grace]]));
    expect(faults).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('X2 keeps it while an install names them, and while only a leftover does', async () => {
    const cases: Array<[string, Parameters<typeof world>[0]]> = [
      ['an install', { installs: [ADA_OLDER] }],
      ['a leftover', { leftovers: [ADA] }],
    ];
    for (const [label, named] of cases) {
      const w = world(named);
      w.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
      const faults: unknown[] = [];

      await expect(w.release(ADA_APP, { onFault: (err) => faults.push(err) }), label).resolves.toBe('kept');

      expect(w.asked, label).toEqual([ADA]);
      expect(w.vault.calls, label).toEqual([]);
      expect(w.vault.rows, label).toEqual(new Map([[personRef(ADA), TOKEN.adaPerson]]));
      expect(faults, label).toEqual([]);
    }
  });

  it("X3 a failed check keeps the token and calls onFault once with the error, step 'check'", async () => {
    const w = world();
    w.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    const fault = dbFault('57P01');
    w.storeFaults.check = fault;
    const faults: unknown[][] = [];

    await expect(w.release(ADA_APP, { onFault: (err, step) => faults.push([err, step]) })).resolves.toBe('kept');

    expect(faults).toHaveLength(1);
    expect(faults[0]![0]).toBe(fault);
    expect(faults[0]![1]).toBe('check');
    expect(w.vault.calls).toEqual([]);
    expect(w.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaPerson]]));

    // Nor does an onFault that throws make it throw, or delete.
    const throwing = (): void => {
      throw new Error('log sink down');
    };
    await expect(w.release(ADA_APP, { onFault: throwing })).resolves.toBe('kept');
    await expect(w.release(ADA_APP, { onFault: throwing, onlyIfStored: true })).resolves.toBe('kept');
    expect(w.vault.calls).toEqual([]);
  });

  it('X4 a delete that fails never throws: the secret store logs it', async () => {
    const w = world();
    w.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    w.vault.faults.set(`credentials:delete ${personRef(ADA)}`, vaultFault('timeout', TOKEN.adaPerson));
    const faults: unknown[] = [];

    await expect(w.release(ADA_APP, { onFault: (err) => faults.push(err) })).resolves.toBe('released');

    expect(w.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_secret_remove_failed',
        fields: { installId: ADA_APP.installId, stage: 'person-config-refresh-token', code: 'timeout' },
      },
    ]);
    expect(faults).toEqual([]);
  });

  it("X5 onlyIfStored: nothing stored, no delete (no tombstone); stored, deleted; the read faulting, reported (step 'read') and deleted anyway", async () => {
    // Only the read that fails may report a fault.
    const faults: unknown[][] = [];
    const onFault = (err: unknown, step: 'check' | 'read'): void => {
      faults.push([err, step]);
    };

    const nothing = world();
    await expect(nothing.release(ADA_APP, { onFault, onlyIfStored: true })).resolves.toBe('released');
    expect(nothing.vault.calls).toEqual([{ hook: 'credentials:get', ref: personRef(ADA), userId: ADA }]);

    const stored = world();
    stored.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    await expect(stored.release(ADA_APP, { onFault, onlyIfStored: true })).resolves.toBe('released');
    expect(stored.vault.calls.map((c) => c.hook)).toEqual(['credentials:get', 'credentials:delete']);
    expect(stored.vault.rows.size).toBe(0);

    // A read that fails is no proof it is gone: reported, then deleted anyway.
    expect(faults).toEqual([]);
    const unreadable = world();
    unreadable.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    const readFault = vaultFault('invalid-envelope');
    unreadable.vault.faults.set(`credentials:get ${personRef(ADA)}`, readFault);
    await expect(unreadable.release(ADA_APP, { onFault, onlyIfStored: true })).resolves.toBe('released');
    expect(unreadable.vault.calls.map((c) => c.hook)).toEqual(['credentials:get', 'credentials:delete']);
    expect(unreadable.vault.rows.size).toBe(0);
    expect(unreadable.lines).toEqual([]);
    expect(faults).toHaveLength(1);
    expect(faults[0]![0]).toBe(readFault);
    expect(faults[0]![1]).toBe('read');
    faults.length = 0;

    // An onFault that throws still lets the delete go ahead.
    const throwingSink = world();
    throwingSink.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    throwingSink.vault.faults.set(`credentials:get ${personRef(ADA)}`, readFault);
    const throwing = (): void => {
      throw new Error('log sink down');
    };
    await expect(throwingSink.release(ADA_APP, { onFault: throwing, onlyIfStored: true })).resolves.toBe('released');
    expect(throwingSink.vault.rows.size).toBe(0);

    // Still kept while something names the person: nothing is even read.
    const named = world({ leftovers: [ADA] });
    named.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    await expect(named.release(ADA_APP, { onFault, onlyIfStored: true })).resolves.toBe('kept');
    expect(named.vault.calls).toEqual([]);
    expect(named.vault.rows).toEqual(new Map([[personRef(ADA), TOKEN.adaPerson]]));

    expect(faults).toEqual([]);
  });

  it('X6 says whether the token was kept: named, or a check fault, is kept; unnamed, or nothing stored with onlyIfStored, is released', async () => {
    const onFault = (): void => {};

    const named = world({ installs: [ADA_OLDER] });
    named.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    await expect(named.release(ADA_APP, { onFault })).resolves.toBe('kept');

    const faulting = world();
    faulting.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    faulting.storeFaults.check = dbFault('57P01');
    await expect(faulting.release(ADA_APP, { onFault })).resolves.toBe('kept');

    const unnamed = world();
    unnamed.vault.rows.set(personRef(ADA), TOKEN.adaPerson);
    await expect(unnamed.release(ADA_APP, { onFault })).resolves.toBe('released');

    await expect(world().release(ADA_APP, { onFault, onlyIfStored: true })).resolves.toBe('released');
  });
});
