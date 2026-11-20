import { randomBytes } from 'node:crypto';
import { HookBus, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createBotChanges } from '../bot-changes.js';
import { logCode } from '../log-code.js';
import { botUrls, buildBotManifest } from '../manifest.js';
import { createMutex, type Mutex } from '../mutex.js';
import { configTokenRef, createSecretStore, secretRef } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import { pngHeader } from './fake-png.js';
import {
  BOT_USER,
  GRANT,
  MINTED_ACCESS,
  NOW_MS,
  fakeSlack,
  mintedRefresh,
  type SlackBehaviour,
} from './fake-slack-config.js';
import {
  BOT_PREFIX,
  CONFIG_ACCESS_PREFIX,
  CONFIG_REFRESH_PREFIX,
  fakeBotToken,
  fakeConfigRefreshToken,
} from './fake-slack-tokens.js';
import { busVault } from './fake-vault.js';
import { memoryStore, type Row } from './memory-install-store.js';

/*
  A team agent's live Slack bot, renamed or given a new picture after its Allow
  (TASK-1171). The domain (bot-changes.ts) on the in-memory install store
  (memory-install-store.ts), the real secret store over a fake vault on the bus
  (fake-vault.ts), and a fake Slack that retires a rotated refresh token at once
  (fake-slack-config.ts). The routes in front of it are agent-routes.test.ts.

  The rules pinned here are about whose token: always the bot's APPROVER's
  (`connectedByUserId`), whoever asked. The domain takes no actor, so a team
  admin's own token, live and stored, is never read, rotated or written. That
  token is rotated under the one app lock, and its successor saved BEFORE the
  access token minted with it is used. Every refusal that needs no Slack call
  comes first. AX's row changes only once Slack took the change.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORIGIN = 'https://ax.example';
const HTTP_ORIGIN = 'http://ax.internal:8080';
const TEAM_ID = 'T07ABCDEF12';

/** The shared app (Admin › Slack), connected by Ada, named `canopy-works`. */
const SHARED_INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const SHARED_APP = 'A07SHAREDAPP';
/**
 * The support agent's own bot. Ada asked for it and Grace approved it, so
 * Grace's token made its app. Two people on purpose (TASK-1169's shape): a
 * change that used the requester's token, Ada's live one, would show.
 */
const SUPPORT_BOT = 'U3VwcG9ydEJvdEluc3RhbA';
const SUPPORT_APP = 'A07SUPPORTB1';
const SUPPORT_BOT_TOKEN = fakeBotToken('SUPPORTBOTSECRET');
/** The sales agent's own bot, Sam's. Its handle differs from its name on purpose. */
const SALES_BOT = 'U2FsZXNCb3RJbnN0YWxsMQ';
const SALES_APP = 'A07OTHERBOT1';
/** An app of Grace's that Slack wouldn't delete: it still names her. */
const LEFTOVER = 'TGVmdG92ZXJBcHBPZkdyYWNl';

const SUPPORT = 'agt_support';
const SALES = 'agt_sales';

/** Connected the shared app, and asked for the support bot; a team admin of the support team, with her own live token stored. */
const ADA = 'usr_ada';
/** The support bot's approver: her token made its app. */
const GRACE = 'usr_grace';
/** The sales bot's approver and requester. */
const SAM = 'usr_sam';

/** Each person's own configuration token (TASK-1175), as their last use of it left it. */
const ADA_STORED = fakeConfigRefreshToken('ADASTOREDSECRET');
const GRACE_STORED = fakeConfigRefreshToken('GRACESTOREDSECRET');

const OLD_NAME = 'Support Helper';
/** The support bot user's @handle, as Slack named it at the Allow. The fake's users.info keeps it. */
const OLD_HANDLE = BOT_USER.name;
const NEW_NAME = 'Quill Desk';
/** The picture the browser drew: a 512 px PNG's header, all parseIconPng reads. */
const PNG = pngHeader(512, 512);
/** Text a failure's message carries, which no log line may repeat. */
const FAILURE_CANARY = 'failure-text-canary-5e2a';

/** A database or vault fault, as pg throws one: an errno code (logged) and a message (never logged). */
const connectionReset = (): Error => Object.assign(new Error(`connection reset ${FAILURE_CANARY}`), { code: 'ECONNRESET' });

/**
 * Everything one rename touches, in order, when Slack keeps the handle: the
 * bot, the names in use (the shared bot, every bot, and every open request
 * for one, TASK-1169), Grace's token (read, rotated, its successor saved
 * before the access token is used), the update, the row, then the handle
 * read again with the bot's own token.
 */
const ONE_RENAME = [
  'store:botForAgent',
  'store:current',
  'store:listBots',
  'store:listBotRequests',
  'vault:get config-refresh-token',
  'slack:rotateConfigToken',
  'vault:set config-refresh-token',
  'slack:updateApp',
  'store:setBotName',
  'vault:get bot-token',
  'slack:usersInfo',
];
/** The names-in-use reads a rename makes before anything else: where a name clash stops it. */
const NAME_CHECK = ONE_RENAME.slice(0, 4);
/** How far into ONE_RENAME a rename gets before a step fails. */
const STOPS_AFTER = { 'config-token': 5, rotate: 6, 'save-config-token': 7, 'update-app': 8 } as const;
/** Everything one picture change touches, in order. */
const ONE_PICTURE = [
  'store:botForAgent',
  'vault:get config-refresh-token',
  'slack:rotateConfigToken',
  'vault:set config-refresh-token',
  'slack:setAppIcon',
  'store:get',
];

const RENAMED = { level: 'info', msg: 'slack_bot_renamed', fields: { installId: SUPPORT_BOT } };

// ── The world ───────────────────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(o: { publicOrigin?: string; lock?: Mutex } = {}) {
  /** Every vault, store and Slack call, in order. */
  const trail: string[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const bus = new HookBus();
  const { vault, vaultCalls, vaultAs, vaultFailures } = busVault(bus, trail);
  const memory = memoryStore(() => NOW_MS, trail);
  const slack = fakeSlack(trail);
  const changes = createBotChanges({
    installs: memory.store,
    secrets: createSecretStore(bus, { logger }),
    api: slack.api,
    lock: o.lock ?? createMutex(),
    publicOrigin: o.publicOrigin ?? ORIGIN,
    logger,
    now: () => NOW_MS,
    randomBytes: (n) => randomBytes(n),
  });

  /** Every answer the domain gave, for the leak scan. */
  const replies: unknown[] = [];
  const keep = <T>(reply: T): T => {
    replies.push(reply);
    return reply;
  };

  return {
    vault,
    vaultCalls,
    vaultAs,
    vaultFailures,
    memory,
    slack,
    trail,
    lines,
    replies,
    rename: async (botName: string, agentId: string = SUPPORT) => keep(await changes.rename({ agentId, botName })),
    setPicture: async (png: Buffer = PNG, agentId: string = SUPPORT) =>
      keep(await changes.setPicture({ agentId, png })),
  };
}

type World = ReturnType<typeof world>;

/** Start watching from here: the calls so far were the test's own seeding. */
function forget(w: World): void {
  w.trail.length = 0;
  w.memory.calls.length = 0;
  w.slack.calls.length = 0;
  w.vaultCalls.length = 0;
  w.vaultAs.length = 0;
  w.lines.length = 0;
}

/**
 * The world every test starts from, written through the store's own API:
 *   - the shared app, live, connected by Ada, and her own token;
 *   - the support agent's bot (live unless told otherwise), asked for by Ada
 *     and approved by Grace: named `Support Helper`, handle `supporthelper`,
 *     its bot token, and Grace's token;
 *   - the sales agent's bot, live, Sam's: named `Sales Desk`, handle `deskbot`.
 */
async function seeded(
  o: { publicOrigin?: string; lock?: Mutex; support?: 'live' | 'pending' | 'none' } = {},
): Promise<World> {
  const w = world(o);
  const live = (installId: string, botUserId: string) =>
    w.memory.store.activate(installId, {
      teamId: TEAM_ID,
      teamName: 'Canopy Works',
      botUserId,
      installedAt: new Date(NOW_MS),
    });

  await w.memory.store.insertPending({
    installId: SHARED_INSTALL,
    appId: SHARED_APP,
    clientId: '7512345678901.7500000000001',
    botName: 'canopy-works',
    connectedByUserId: ADA,
  });
  await live(SHARED_INSTALL, 'U07SHAREDBOT');
  w.vault.set(configTokenRef(ADA), ADA_STORED);

  const support = o.support ?? 'live';
  if (support !== 'none') {
    await w.memory.store.insertPendingBot({
      installId: SUPPORT_BOT,
      appId: SUPPORT_APP,
      clientId: '7512345678901.7511111111111',
      botName: OLD_NAME,
      connectedByUserId: GRACE,
      agentId: SUPPORT,
      requestedByUserId: ADA,
    });
    if (support === 'live') {
      await live(SUPPORT_BOT, GRANT.botUserId);
      await w.memory.store.setBotHandle(SUPPORT_BOT, OLD_HANDLE);
      w.vault.set(secretRef(SUPPORT_BOT, 'bot-token'), SUPPORT_BOT_TOKEN);
    }
    w.vault.set(configTokenRef(GRACE), GRACE_STORED);
  }

  await w.memory.store.insertPendingBot({
    installId: SALES_BOT,
    appId: SALES_APP,
    clientId: '7512345678901.7533333333333',
    botName: 'Sales Desk',
    connectedByUserId: SAM,
    agentId: SALES,
    requestedByUserId: SAM,
  });
  await live(SALES_BOT, 'U07OTHERBOT');
  await w.memory.store.setBotHandle(SALES_BOT, 'deskbot');

  forget(w);
  return w;
}

/** The support agent's bot row. */
function supportRow(w: World): Row {
  const row = w.memory.rows.get(SUPPORT_BOT);
  if (row === undefined) throw new Error('the support bot has no row');
  return row;
}

function methods(w: World): string[] {
  return w.slack.calls.map((c) => c.method);
}

/** The trail's vault and Slack entries: what a refusal must never reach. */
function reached(w: World): string[] {
  return w.trail.filter((t) => t.startsWith('vault:') || t.startsWith('slack:'));
}

/** users.info answering about the bot user, with `fields` in place of its own. */
function answer(fields: Record<string, unknown>): SlackBehaviour['usersInfo'] {
  return async () => ({ ...structuredClone(BOT_USER), ...fields });
}

/** Slack's update refusing with `code`. */
function failUpdate(w: World, code: string): void {
  w.slack.on.updateApp = async () => {
    throw new SlackApiError('apps.manifest.update', code);
  };
}

/** Every rotate refusing with `code`. */
function failRotate(w: World, code: string): void {
  w.slack.on.rotateConfigToken = async () => {
    throw new SlackApiError('tooling.tokens.rotate', code);
  };
}

/**
 * A whole bootstrap reset while the approver's token is being rotated: the
 * vault wiped (credentials-store-db does that first) and every row removed.
 * Then Slack refuses the rotate with `invalid_refresh_token` (the token it
 * was sent is gone with the reset), so nothing is saved after the wipe; or,
 * with `'mint'`, the rotate goes through and its successor is saved after the
 * wipe, as a rotate already on its way to Slack would.
 */
function resetDuringRotate(w: World, then: 'refuse' | 'mint'): void {
  const rotate = w.slack.on.rotateConfigToken;
  w.slack.on.rotateConfigToken = async (refreshToken) => {
    w.vault.clear();
    await w.memory.store.removeAll();
    if (then === 'refuse') throw new SlackApiError('tooling.tokens.rotate', 'invalid_refresh_token');
    return rotate(refreshToken);
  };
}

/** A failing `w.rename` or `w.setPicture`'s rejection, or a sign it resolved. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (err: unknown) => err,
  );
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Hold the app lock, as another Slack-app step would, from the moment this
 * resolves until `free()`. `done` settles once the lock is let go.
 */
async function holdLock(lock: Mutex): Promise<{ free: () => void; done: Promise<void> }> {
  let free!: () => void;
  let held!: () => void;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const done = lock.run(
    () =>
      new Promise<void>((resolve) => {
        free = resolve;
        held();
      }),
  );
  await holding;
  return { free, done };
}

/** The two fields a rename changes, as a test reads them out of a manifest. */
type ManifestNames = { display_information: { name: string }; features: { bot_user: { display_name: string } } };

// ── rename ──────────────────────────────────────────────────────────────────

describe('rename', () => {
  it("R1 renames with the APPROVER's token: rotate, save its successor, then Slack gets the whole bot manifest with only the name changed; the row keeps the new name", async () => {
    const w = await seeded();

    const reply = await w.rename(NEW_NAME);

    expect(reply).toEqual({ status: 200, body: { botName: NEW_NAME } });
    // Slack first, the row after: the row only ever shows a name Slack took.
    expect(w.trail).toEqual(ONE_RENAME);
    // Grace's stored token is the one rotated, read and written as herself.
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args)).toEqual([[GRACE_STORED]]);
    expect(w.vaultAs.filter((v) => v.name === 'config-refresh-token')).toEqual([
      { hook: 'credentials:get', name: 'config-refresh-token', userId: GRACE },
      { hook: 'credentials:set', name: 'config-refresh-token', userId: GRACE },
    ]);

    // The bot's whole manifest, made with the access token that rotate minted.
    const update = w.slack.calls.find((c) => c.method === 'updateApp')!;
    expect(update.args).toEqual([MINTED_ACCESS, SUPPORT_APP, buildBotManifest(NEW_NAME, botUrls(ORIGIN, SUPPORT_BOT))]);
    // Slack keeps nothing it isn't sent: the manifest it had, with only the two name fields changed.
    const renamed = buildBotManifest(OLD_NAME, botUrls(ORIGIN, SUPPORT_BOT)) as ManifestNames;
    renamed.display_information.name = NEW_NAME;
    renamed.features.bot_user.display_name = NEW_NAME;
    expect(update.args[2]).toEqual(renamed);
    // The minted access token goes to the update and nowhere else.
    expect(w.slack.calls.filter((c) => c.args.includes(MINTED_ACCESS)).map((c) => c.method)).toEqual(['updateApp']);

    // The vault: Grace's token is the rotate's successor. Ada asked for the
    // bot and has her own live token stored, and it is never named.
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(w.vault.get(configTokenRef(ADA))).toBe(ADA_STORED);
    expect(w.vaultCalls.map((c) => c.ref)).not.toContain(configTokenRef(ADA));

    // The handle, asked of Slack with the bot's own token, about its own bot user.
    expect(w.slack.calls.find((c) => c.method === 'usersInfo')!.args).toEqual([SUPPORT_BOT_TOKEN, GRANT.botUserId]);
    expect(supportRow(w)).toMatchObject({ status: 'active', botName: NEW_NAME, botHandle: OLD_HANDLE });
    expect(w.lines).toEqual([RENAMED]);
  });

  it('R2 keeps the handle Slack reports after the rename: written only when usable and changed; anything else keeps the stored one and still answers 200', async () => {
    // Slack changed the bot user's name: kept, written once.
    const changed = await seeded();
    changed.slack.on.usersInfo = answer({ name: 'quilldesk' });
    expect(await changed.rename(NEW_NAME)).toEqual({ status: 200, body: { botName: NEW_NAME } });
    expect(supportRow(changed)).toMatchObject({ botName: NEW_NAME, botHandle: 'quilldesk' });
    expect(changed.trail).toEqual([...ONE_RENAME, 'store:setBotHandle']);
    expect(changed.memory.calls.filter((c) => c.method === 'setBotHandle')).toEqual([
      { method: 'setBotHandle', args: [SUPPORT_BOT, 'quilldesk'] },
    ]);
    expect(changed.lines).toEqual([RENAMED]);

    // Slack kept it (as the TASK-1090 spike saw): nothing to write.
    const same = await seeded();
    expect(await same.rename(NEW_NAME)).toEqual({ status: 200, body: { botName: NEW_NAME } });
    expect(same.trail).not.toContain('store:setBotHandle');
    expect(supportRow(same).botHandle).toBe(OLD_HANDLE);

    // Anything else: the stored handle stays, one code-only line says why, and the rename still answers 200.
    const cases: Array<[label: string, breakIt: (w: World) => void, level: 'warn' | 'error', code: string]> = [
      [
        'a reserved word',
        (w) => {
          w.slack.on.usersInfo = answer({ name: 'channel' });
        },
        'warn',
        'unusable-handle',
      ],
      [
        'the display name, not a handle',
        (w) => {
          w.slack.on.usersInfo = answer({ name: NEW_NAME });
        },
        'warn',
        'unusable-handle',
      ],
      [
        'an answer about someone else',
        (w) => {
          w.slack.on.usersInfo = answer({ id: 'U07SOMEONE1' });
        },
        'warn',
        'user-mismatch',
      ],
      [
        'users.info failing',
        (w) => {
          w.slack.on.usersInfo = async () => {
            throw new SlackApiError('users.info', 'ratelimited');
          };
        },
        'warn',
        'ratelimited',
      ],
      [
        'no bot token stored',
        (w) => {
          w.vault.delete(secretRef(SUPPORT_BOT, 'bot-token'));
        },
        'warn',
        'missing',
      ],
      [
        'no bot user on the row',
        (w) => {
          supportRow(w).botUserId = null;
        },
        'warn',
        'missing',
      ],
      [
        'the vault failing on the bot token',
        (w) => {
          w.vaultFailures.set('credentials:get bot-token', connectionReset());
        },
        'error',
        'ECONNRESET',
      ],
      [
        'the store refusing the new handle',
        (w) => {
          w.slack.on.usersInfo = answer({ name: 'quilldesk' });
          w.memory.failures.set('setBotHandle', connectionReset());
        },
        'error',
        'ECONNRESET',
      ],
    ];
    for (const [label, breakIt, level, code] of cases) {
      const w = await seeded();
      breakIt(w);

      expect(await w.rename(NEW_NAME), label).toEqual({ status: 200, body: { botName: NEW_NAME } });

      expect(supportRow(w), label).toMatchObject({ botName: NEW_NAME, botHandle: OLD_HANDLE });
      expect(w.lines, label).toEqual([
        { level, msg: 'slack_bot_failed', fields: { installId: SUPPORT_BOT, stage: 'bot-handle', code } },
        RENAMED,
      ]);
    }
  });

  it("R3 refuses a name the shared bot, another bot, another bot's handle, or an open bot request has, by the 21-char key, before the vault or Slack; its own name in another case is fine", async () => {
    // The shared bot's name; the sales bot's name, as typed two ways; the sales bot's HANDLE (`deskbot`).
    for (const name of ['Canopy Works', 'sales desk', 'Sales-Desk', 'Desk Bot']) {
      const w = await seeded();

      expect(await w.rename(name), name).toEqual({ status: 409, body: { error: 'bot-name-taken' } });

      expect(w.trail, name).toEqual(NAME_CHECK);
      expect(supportRow(w), name).toMatchObject({ botName: OLD_NAME, botHandle: OLD_HANDLE });
      expect(w.lines, name).toEqual([]);
    }

    // A name another agent's open ask for an AX admin's approval holds (TASK-1169)
    // is taken too, by the same key: approving that ask must not find it in use.
    for (const name of ['Ops Helper', 'ops-helper']) {
      const w = await seeded();
      await w.memory.store.insertBotRequest({
        requestId: 'UmVxdWVzdEZvck9wc0JvdDE',
        agentId: 'agt_ops',
        requestedByUserId: SAM,
        botName: 'Ops Helper',
      });
      forget(w);

      expect(await w.rename(name), name).toEqual({ status: 409, body: { error: 'bot-name-taken' } });

      expect(w.trail, name).toEqual(NAME_CHECK);
      expect(reached(w), name).toEqual([]);
      expect(supportRow(w), name).toMatchObject({ botName: OLD_NAME, botHandle: OLD_HANDLE });
      expect(w.lines, name).toEqual([]);
    }

    // Its own name and handle are left out of the check, so it may vary its own name.
    const own = await seeded();
    expect(await own.rename('support helper')).toEqual({ status: 200, body: { botName: 'support helper' } });
    expect(supportRow(own).botName).toBe('support helper');
  });

  it('R4 409 not-live for an agent with no bot, or a pending bot; 409 public-origin-not-https on an http origin (rename only); none touches the vault or Slack', async () => {
    // No bot at all.
    const none = await seeded({ support: 'none' });
    expect(await none.rename(NEW_NAME)).toEqual({ status: 409, body: { error: 'not-live' } });
    expect(await none.setPicture()).toEqual({ status: 409, body: { error: 'not-live' } });
    expect(none.trail).toEqual(['store:botForAgent', 'store:botForAgent']);

    // A bot still waiting for its Allow: Cancel is its way out, not a rename.
    const pending = await seeded({ support: 'pending' });
    expect(await pending.rename(NEW_NAME)).toEqual({ status: 409, body: { error: 'not-live' } });
    expect(await pending.setPicture()).toEqual({ status: 409, body: { error: 'not-live' } });
    expect(pending.trail).toEqual(['store:botForAgent', 'store:botForAgent']);
    expect(supportRow(pending)).toMatchObject({ status: 'pending', botName: OLD_NAME });
    expect(pending.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);

    for (const w of [none, pending]) {
      expect(reached(w)).toEqual([]);
      expect(w.lines).toEqual([]);
    }

    // An http origin: the manifest carries the URLs Slack calls back on, so a rename is refused.
    const http = await seeded({ publicOrigin: HTTP_ORIGIN });
    expect(await http.rename(NEW_NAME)).toEqual({ status: 409, body: { error: 'public-origin-not-https' } });
    expect(http.trail).toEqual(['store:botForAgent']);
    expect(supportRow(http).botName).toBe(OLD_NAME);
    expect(http.lines).toEqual([]);
    // A picture carries no URL, so the origin doesn't stop one.
    expect(await http.setPicture()).toEqual({ status: 200, body: {} });
  });

  it("R5 the approver's token refused (each of invalid_refresh_token, token_revoked, invalid_auth at the rotate; no_permission and app_not_owned_by_manager_app at the update), or missing → 502 slack-config-token; name and handle unchanged; Ada's token untouched", async () => {
    type Case = [stage: keyof typeof STOPS_AFTER, code: string, breakIt: (w: World) => void];
    const cases: Case[] = [
      [
        'config-token',
        'missing',
        (w) => {
          w.vault.delete(configTokenRef(GRACE));
        },
      ],
      ...['invalid_refresh_token', 'token_revoked', 'invalid_auth'].map(
        (code): Case => ['rotate', code, (w) => failRotate(w, code)],
      ),
      ...['no_permission', 'app_not_owned_by_manager_app'].map(
        (code): Case => ['update-app', code, (w) => failUpdate(w, code)],
      ),
    ];
    for (const [stage, code, breakIt] of cases) {
      // Grace's token is dead, while Ada (who asked for the bot, a team admin of its team) has her own live one stored.
      const w = await seeded();
      breakIt(w);

      expect(await w.rename(NEW_NAME), code).toEqual({ status: 502, body: { error: 'slack-config-token' } });

      // Stopped at the step that failed: no store:setBotName, no handle read;
      // only the row read again, to see a reset meanwhile.
      expect(w.trail, code).toEqual([...ONE_RENAME.slice(0, STOPS_AFTER[stage]), 'store:get']);
      expect(supportRow(w), code).toMatchObject({ botName: OLD_NAME, botHandle: OLD_HANDLE });
      // Only Grace's token was named, as herself. Ada's was never read, rotated or written.
      const named = w.vaultAs.filter((v) => v.name === 'config-refresh-token');
      expect(named.length, code).toBeGreaterThan(0);
      expect(named.every((v) => v.userId === GRACE), code).toBe(true);
      expect(w.vaultCalls.map((c) => c.ref), code).not.toContain(configTokenRef(ADA));
      expect(w.vault.get(configTokenRef(ADA)), code).toBe(ADA_STORED);
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', fields: { installId: SUPPORT_BOT, stage, code } },
      ]);
    }
  });

  it('R6 invalid_manifest → 502 slack-name; app_not_found → 502 slack-app-gone; ratelimited and timeout → 502 slack-error; the row unchanged', async () => {
    const cases: Array<[code: string, error: string]> = [
      ['invalid_manifest', 'slack-name'],
      ['app_not_found', 'slack-app-gone'],
      ['ratelimited', 'slack-error'],
      ['timeout', 'slack-error'],
    ];
    for (const [code, error] of cases) {
      const w = await seeded();
      failUpdate(w, code);

      expect(await w.rename(NEW_NAME), code).toEqual({ status: 502, body: { error } });

      expect(w.trail, code).toEqual([...ONE_RENAME.slice(0, STOPS_AFTER['update-app']), 'store:get']);
      expect(supportRow(w), code).toMatchObject({ botName: OLD_NAME, botHandle: OLD_HANDLE });
      // Saved before the update, so the next try rotates it.
      expect(w.vault.get(configTokenRef(GRACE)), code).toBe(mintedRefresh(1));
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', fields: { installId: SUPPORT_BOT, stage: 'update-app', code } },
      ]);
    }
  });

  it("R7 the successor won't save → 500 internal; Slack is never asked to update; the stored token is left as it was", async () => {
    const w = await seeded();
    w.vaultFailures.set(`credentials:set ${configTokenRef(GRACE)}`, connectionReset());

    expect(await w.rename(NEW_NAME)).toEqual({ status: 500, body: { error: 'internal' } });

    expect(w.trail).toEqual([...ONE_RENAME.slice(0, STOPS_AFTER['save-config-token']), 'store:get']);
    expect(methods(w)).toEqual(['rotateConfigToken']);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);
    expect(supportRow(w)).toMatchObject({ botName: OLD_NAME, botHandle: OLD_HANDLE });
    expect(w.lines).toEqual([
      {
        level: 'error',
        msg: 'slack_bot_failed',
        fields: { installId: SUPPORT_BOT, stage: 'save-config-token', code: 'ECONNRESET' },
      },
    ]);
  });

  it("R8 the bot's row gone at the write (a reset takes no lock) → 409 not-live; the token just saved goes, unless something still names the approver", async () => {
    // A reset removes every row while Slack is renaming the bot.
    const w = await seeded();
    w.slack.on.updateApp = async () => {
      await w.memory.store.removeAll();
    };

    expect(await w.rename(NEW_NAME)).toEqual({ status: 409, body: { error: 'not-live' } });

    // setBotName found the row gone; then the rename asked whether anything still names Grace.
    expect(w.memory.calls.slice(-2)).toEqual([
      { method: 'setBotName', args: [SUPPORT_BOT, NEW_NAME] },
      { method: 'personHasApps', args: [GRACE] },
    ]);
    // Nothing does, so the token it just saved goes too: the reset's own sweep
    // only catches one saved before the sweep ran.
    expect(w.trail.slice(-2)).toEqual(['store:personHasApps', 'vault:delete config-refresh-token']);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    // No handle is read for a bot that's gone.
    expect(methods(w)).not.toContain('usersInfo');
    expect(w.lines).toEqual([]);

    // An app of Grace's is left over: it names her, so her token stays, for it.
    const kept = await seeded();
    await kept.memory.store.rememberLeftoverApp({
      installId: LEFTOVER,
      appId: 'A07LEFTOVER1',
      botName: 'Old Helper',
      connectedByUserId: GRACE,
    });
    forget(kept);
    kept.slack.on.updateApp = async () => {
      await kept.memory.store.removeAll();
    };
    expect(await kept.rename(NEW_NAME)).toEqual({ status: 409, body: { error: 'not-live' } });
    expect(kept.trail.at(-1)).toBe('store:personHasApps');
    expect(kept.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(kept.lines).toEqual([]);

    // Our own store failing at the write is no reset: it rejects (the route's
    // 500), the row still names Grace, and her token stays.
    const broken = await seeded();
    broken.memory.failures.set('setBotName', connectionReset());
    expect(logCode(await rejection(broken.rename(NEW_NAME)))).toBe('ECONNRESET');
    expect(broken.trail.at(-1)).toBe('store:setBotName');
    expect(broken.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(supportRow(broken).botName).toBe(OLD_NAME);
  });

  it('R9 two renames at once take turns under the app lock, each whole; the later name stays', async () => {
    // A double click, or two team admins: the first holds the lock inside Slack's update.
    const w = await seeded();
    const gate = deferred();
    let held = false;
    w.slack.on.updateApp = async () => {
      if (held) return;
      held = true;
      await gate.promise;
    };

    const one = w.rename(NEW_NAME);
    const two = w.rename('Quill Helper');
    await settle();
    // The second hasn't touched anything yet.
    expect(w.trail).toEqual(ONE_RENAME.slice(0, STOPS_AFTER['update-app']));
    gate.resolve();

    expect(await one).toEqual({ status: 200, body: { botName: NEW_NAME } });
    expect(await two).toEqual({ status: 200, body: { botName: 'Quill Helper' } });
    expect(w.trail).toEqual([...ONE_RENAME, ...ONE_RENAME]);
    expect(w.trail.filter((t) => t === 'slack:updateApp' || t === 'store:setBotName')).toEqual([
      'slack:updateApp',
      'store:setBotName',
      'slack:updateApp',
      'store:setBotName',
    ]);
    // Each rotate spends the token the one before it saved.
    expect(w.slack.calls.filter((c) => c.method === 'rotateConfigToken').map((c) => c.args[0])).toEqual([
      GRACE_STORED,
      mintedRefresh(1),
    ]);
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(2));
    expect(supportRow(w).botName).toBe('Quill Helper');

    // Another step holding the app lock (a Connect, a request, a Disconnect):
    // a rename and a picture touch nothing until it lets go.
    const lock = createMutex();
    const waiting = await seeded({ lock });
    const other = await holdLock(lock);
    const renaming = waiting.rename(NEW_NAME);
    const picturing = waiting.setPicture();
    await settle();
    expect(waiting.trail).toEqual([]);
    other.free();
    await other.done;
    expect(await renaming).toEqual({ status: 200, body: { botName: NEW_NAME } });
    expect(await picturing).toEqual({ status: 200, body: {} });
    expect(waiting.trail).toEqual([...ONE_RENAME, ...ONE_PICTURE]);
  });

  it("R10 the bot's row gone while Slack refused the update AFTER the successor was saved → 409 not-live; that token goes, unless something still names the approver", async () => {
    for (const code of ['ratelimited', 'no_permission']) {
      // A reset removes every row while Slack is renaming the bot, and then Slack refuses.
      const w = await seeded();
      w.slack.on.updateApp = async () => {
        await w.memory.store.removeAll();
        throw new SlackApiError('apps.manifest.update', code);
      };

      expect(await w.rename(NEW_NAME), code).toEqual({ status: 409, body: { error: 'not-live' } });

      // The refusal re-read the row, found it gone, asked whether anything
      // still names Grace, and read her token: only one still stored is deleted.
      expect(w.trail.slice(-4), code).toEqual([
        'store:get',
        'store:personHasApps',
        'vault:get config-refresh-token',
        'vault:delete config-refresh-token',
      ]);
      // Nothing does, so the successor saved after the reset's sweep goes too.
      expect(w.vault.has(configTokenRef(GRACE)), code).toBe(false);
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', fields: { installId: SUPPORT_BOT, stage: 'update-app', code } },
      ]);

      // An app of Grace's is left over: it names her, so her token stays, for it.
      const kept = await seeded();
      await kept.memory.store.rememberLeftoverApp({
        installId: LEFTOVER,
        appId: 'A07LEFTOVER1',
        botName: 'Old Helper',
        connectedByUserId: GRACE,
      });
      forget(kept);
      kept.slack.on.updateApp = async () => {
        await kept.memory.store.removeAll();
        throw new SlackApiError('apps.manifest.update', code);
      };
      expect(await kept.rename(NEW_NAME), code).toEqual({ status: 409, body: { error: 'not-live' } });
      expect(kept.trail.at(-1), code).toBe('store:personHasApps');
      expect(kept.vault.get(configTokenRef(GRACE)), code).toBe(mintedRefresh(1));

      // Our own store failing at that re-read is no reset: it rejects (the
      // route's 500), nothing asks whether anything names Grace, and her
      // successor stays.
      const broken = await seeded();
      broken.memory.failures.set('get', connectionReset());
      failUpdate(broken, code);
      expect(logCode(await rejection(broken.rename(NEW_NAME))), code).toBe('ECONNRESET');
      expect(broken.trail.at(-1), code).toBe('store:get');
      expect(broken.trail, code).not.toContain('store:personHasApps');
      expect(broken.vault.get(configTokenRef(GRACE)), code).toBe(mintedRefresh(1));
      expect(supportRow(broken).botName, code).toBe(OLD_NAME);
    }
  });

  it("R11 a whole reset during the rotate → 409 not-live; a token nothing saved after the wipe is left alone (no tombstone row), one saved after it goes", async () => {
    // Slack refuses the rotate: nothing was saved after the wipe.
    const w = await seeded();
    resetDuringRotate(w, 'refuse');

    expect(await w.rename(NEW_NAME)).toEqual({ status: 409, body: { error: 'not-live' } });

    // The row re-read, found gone, nothing names Grace; her token is read
    // and, not being there, never deleted: the vault deletes by writing an
    // empty row, and a reset leaves no credential rows behind.
    expect(w.trail.slice(-3)).toEqual(['store:get', 'store:personHasApps', 'vault:get config-refresh-token']);
    expect(w.trail).not.toContain('vault:delete config-refresh-token');
    expect(w.vault.size).toBe(0);
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_bot_failed',
        fields: { installId: SUPPORT_BOT, stage: 'rotate', code: 'invalid_refresh_token' },
      },
    ]);

    // The rotate goes through, its successor saved after the wipe, then Slack
    // refuses the update: that successor goes.
    const minted = await seeded();
    resetDuringRotate(minted, 'mint');
    failUpdate(minted, 'ratelimited');

    expect(await minted.rename(NEW_NAME)).toEqual({ status: 409, body: { error: 'not-live' } });

    expect(minted.trail.slice(-4)).toEqual([
      'store:get',
      'store:personHasApps',
      'vault:get config-refresh-token',
      'vault:delete config-refresh-token',
    ]);
    expect(minted.vault.size).toBe(0);
  });
});

// ── setPicture ──────────────────────────────────────────────────────────────

describe('setPicture', () => {
  it('P1 setPicture: rotate, save, then apps.icon.set with exactly the PNG; no manifest, no row write', async () => {
    const w = await seeded();
    const before = structuredClone(supportRow(w));

    expect(await w.setPicture(pngHeader(512, 512))).toEqual({ status: 200, body: {} });

    expect(w.trail).toEqual(ONE_PICTURE);
    // Grace's token, rotated; the picture, sent with the access token that minted.
    expect(w.slack.calls[0]).toEqual({ method: 'rotateConfigToken', args: [GRACE_STORED] });
    const icon = w.slack.calls.find((c) => c.method === 'setAppIcon')!;
    expect(icon.args).toEqual([MINTED_ACCESS, SUPPORT_APP, pngHeader(512, 512)]);
    expect(Buffer.from(icon.args[2] as Uint8Array).equals(pngHeader(512, 512))).toBe(true);
    // No manifest, and the row as it was.
    expect(methods(w)).toEqual(['rotateConfigToken', 'setAppIcon']);
    expect(w.memory.calls.map((c) => c.method)).toEqual(['botForAgent', 'get']);
    expect(supportRow(w)).toEqual(before);
    // Grace's token is the rotate's successor; Ada's own is never named.
    expect(w.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
    expect(w.vaultCalls.map((c) => c.ref)).not.toContain(configTokenRef(ADA));
    expect(w.lines).toEqual([{ level: 'info', msg: 'slack_bot_picture_changed', fields: { installId: SUPPORT_BOT } }]);
  });

  it("P2 setPicture refusals: no_permission → 502 slack-config-token; app_not_found → 502 slack-app-gone; error_bad_format → 502 slack-error; the successor won't save → 500; a pending bot → 409 not-live; a vault fault reading the token rejects (the route's 500) before Slack", async () => {
    const cases: Array<[code: string, error: string]> = [
      ['no_permission', 'slack-config-token'],
      ['app_not_found', 'slack-app-gone'],
      ['error_bad_format', 'slack-error'],
    ];
    for (const [code, error] of cases) {
      const w = await seeded();
      const before = structuredClone(supportRow(w));
      w.slack.on.setAppIcon = async () => {
        throw new SlackApiError('apps.icon.set', code);
      };

      expect(await w.setPicture(), code).toEqual({ status: 502, body: { error } });

      // The row read again (still there), to see a reset meanwhile.
      expect(w.trail, code).toEqual(ONE_PICTURE);
      expect(supportRow(w), code).toEqual(before);
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', fields: { installId: SUPPORT_BOT, stage: 'icon', code } },
      ]);
    }

    // The successor won't save: nothing is sent, and the stored token stays.
    const unsaved = await seeded();
    unsaved.vaultFailures.set(`credentials:set ${configTokenRef(GRACE)}`, connectionReset());
    expect(await unsaved.setPicture()).toEqual({ status: 500, body: { error: 'internal' } });
    expect(methods(unsaved)).toEqual(['rotateConfigToken']);
    expect(unsaved.vault.get(configTokenRef(GRACE))).toBe(GRACE_STORED);

    // A bot still waiting for its Allow.
    const pending = await seeded({ support: 'pending' });
    expect(await pending.setPicture()).toEqual({ status: 409, body: { error: 'not-live' } });
    expect(reached(pending)).toEqual([]);

    // The vault failing on Grace's token: Slack is never asked anything.
    const faulty = await seeded();
    faulty.vaultFailures.set(`credentials:get ${configTokenRef(GRACE)}`, connectionReset());
    expect(logCode(await rejection(faulty.setPicture()))).toBe('ECONNRESET');
    expect(faulty.slack.calls).toEqual([]);
  });

  it('P3 setPicture: the row gone after Slack took it → release, 409 not-live', async () => {
    // A reset removes the bot's row while Slack is taking its picture.
    const w = await seeded();
    w.slack.on.setAppIcon = async () => {
      w.memory.rows.delete(SUPPORT_BOT);
    };

    expect(await w.setPicture()).toEqual({ status: 409, body: { error: 'not-live' } });

    // Nothing else names Grace, so the token just saved goes.
    expect(w.trail.slice(ONE_PICTURE.length - 1)).toEqual([
      'store:get',
      'store:personHasApps',
      'vault:get config-refresh-token',
      'vault:delete config-refresh-token',
    ]);
    expect(w.vault.has(configTokenRef(GRACE))).toBe(false);
    expect(w.lines).toEqual([]);

    // A leftover app still names her: kept.
    const kept = await seeded();
    await kept.memory.store.rememberLeftoverApp({
      installId: LEFTOVER,
      appId: 'A07LEFTOVER1',
      botName: 'Old Helper',
      connectedByUserId: GRACE,
    });
    kept.slack.on.setAppIcon = async () => {
      kept.memory.rows.delete(SUPPORT_BOT);
    };
    expect(await kept.setPicture()).toEqual({ status: 409, body: { error: 'not-live' } });
    expect(kept.vault.get(configTokenRef(GRACE))).toBe(mintedRefresh(1));
  });

  it('P4 setPicture: the row gone while Slack refused the picture AFTER the successor was saved → release, 409 not-live', async () => {
    for (const code of ['ratelimited', 'no_permission']) {
      // A reset removes the bot's row while Slack is taking its picture, and then Slack refuses.
      const w = await seeded();
      w.slack.on.setAppIcon = async () => {
        w.memory.rows.delete(SUPPORT_BOT);
        throw new SlackApiError('apps.icon.set', code);
      };

      expect(await w.setPicture(), code).toEqual({ status: 409, body: { error: 'not-live' } });

      // Nothing else names Grace, so the token just saved goes.
      expect(w.trail.slice(ONE_PICTURE.length - 1), code).toEqual([
        'store:get',
        'store:personHasApps',
        'vault:get config-refresh-token',
        'vault:delete config-refresh-token',
      ]);
      expect(w.vault.has(configTokenRef(GRACE)), code).toBe(false);
      expect(w.lines, code).toEqual([
        { level: 'warn', msg: 'slack_bot_failed', fields: { installId: SUPPORT_BOT, stage: 'icon', code } },
      ]);

      // A leftover app still names her: kept.
      const kept = await seeded();
      await kept.memory.store.rememberLeftoverApp({
        installId: LEFTOVER,
        appId: 'A07LEFTOVER1',
        botName: 'Old Helper',
        connectedByUserId: GRACE,
      });
      kept.slack.on.setAppIcon = async () => {
        kept.memory.rows.delete(SUPPORT_BOT);
        throw new SlackApiError('apps.icon.set', code);
      };
      expect(await kept.setPicture(), code).toEqual({ status: 409, body: { error: 'not-live' } });
      expect(kept.vault.get(configTokenRef(GRACE)), code).toBe(mintedRefresh(1));

      // Our own store failing at that re-read is no reset: it rejects (the
      // route's 500), nothing asks whether anything names Grace, and her
      // successor stays.
      const broken = await seeded();
      broken.memory.failures.set('get', connectionReset());
      broken.slack.on.setAppIcon = async () => {
        throw new SlackApiError('apps.icon.set', code);
      };
      expect(logCode(await rejection(broken.setPicture())), code).toBe('ECONNRESET');
      expect(broken.trail.at(-1), code).toBe('store:get');
      expect(broken.trail, code).not.toContain('store:personHasApps');
      expect(broken.vault.get(configTokenRef(GRACE)), code).toBe(mintedRefresh(1));
    }
  });

  it('P5 setPicture: a whole reset during the rotate → 409 not-live; a token nothing saved after the wipe is left alone (no tombstone row), one saved after it goes', async () => {
    // Slack refuses the rotate: nothing was saved after the wipe.
    const w = await seeded();
    resetDuringRotate(w, 'refuse');

    expect(await w.setPicture()).toEqual({ status: 409, body: { error: 'not-live' } });

    expect(w.trail.slice(-3)).toEqual(['store:get', 'store:personHasApps', 'vault:get config-refresh-token']);
    expect(w.trail).not.toContain('vault:delete config-refresh-token');
    expect(w.vault.size).toBe(0);
    expect(methods(w)).toEqual(['rotateConfigToken']);

    // The rotate goes through, its successor saved after the wipe, then Slack
    // refuses the picture: that successor goes.
    const minted = await seeded();
    resetDuringRotate(minted, 'mint');
    minted.slack.on.setAppIcon = async () => {
      throw new SlackApiError('apps.icon.set', 'ratelimited');
    };

    expect(await minted.setPicture()).toEqual({ status: 409, body: { error: 'not-live' } });

    expect(minted.trail.slice(-4)).toEqual([
      'store:get',
      'store:personHasApps',
      'vault:get config-refresh-token',
      'vault:delete config-refresh-token',
    ]);
    expect(minted.vault.size).toBe(0);
  });
});

// ── What leaves the domain ──────────────────────────────────────────────────

describe('answers and logs', () => {
  it("L1 no reply or log line carries a token, a person id, the agent id, a bot name or handle, the app id, or a failure's text", async () => {
    const worlds: World[] = [];
    const add = async (breakIt: (w: World) => void = () => {}): Promise<World> => {
      const w = await seeded();
      breakIt(w);
      worlds.push(w);
      return w;
    };

    // R1, then P1: everything going well.
    const fine = await add();
    await fine.rename(NEW_NAME);
    await fine.setPicture();
    // A handle Slack changed.
    const changed = await add((w) => {
      w.slack.on.usersInfo = answer({ name: 'quilldesk' });
    });
    await changed.rename(NEW_NAME);

    // R2's failures, each in its own world.
    const handleFailures: Array<(w: World) => void> = [
      (w) => {
        w.slack.on.usersInfo = answer({ name: 'channel' });
      },
      (w) => {
        w.slack.on.usersInfo = answer({ id: 'U07SOMEONE1' });
      },
      (w) => {
        w.slack.on.usersInfo = async () => {
          throw new SlackApiError('users.info', 'ratelimited');
        };
      },
      (w) => {
        w.vault.delete(secretRef(SUPPORT_BOT, 'bot-token'));
      },
      (w) => {
        w.vaultFailures.set('credentials:get bot-token', connectionReset());
      },
      (w) => {
        w.slack.on.usersInfo = answer({ name: 'quilldesk' });
        w.memory.failures.set('setBotHandle', connectionReset());
      },
    ];
    for (const breakIt of handleFailures) await (await add(breakIt)).rename(NEW_NAME);

    // R5: Grace's token dead, refused at the update, or missing.
    await (await add((w) => failRotate(w, 'invalid_refresh_token'))).rename(NEW_NAME);
    await (await add((w) => failUpdate(w, 'no_permission'))).rename(NEW_NAME);
    const missing = await add((w) => {
      w.vault.delete(configTokenRef(GRACE));
    });
    await missing.rename(NEW_NAME);
    // R7: the successor won't save, for a rename and for a picture.
    const unsaved = await add((w) => {
      w.vaultFailures.set(`credentials:set ${configTokenRef(GRACE)}`, connectionReset());
    });
    await unsaved.rename(NEW_NAME);
    await unsaved.setPicture();
    // P2: Slack refusing a picture.
    await (
      await add((w) => {
        w.slack.on.setAppIcon = async () => {
          throw new SlackApiError('apps.icon.set', 'error_bad_format');
        };
      })
    ).setPicture();

    // Every world said something, so the scan below reads real output.
    for (const x of worlds) {
      expect(x.replies.length).toBeGreaterThan(0);
      expect(x.lines.length).toBeGreaterThan(0);
    }
    const tokens = [CONFIG_ACCESS_PREFIX, CONFIG_REFRESH_PREFIX, BOT_PREFIX];
    const people = [ADA, GRACE, SAM, 'usr_'];
    const agents = [SUPPORT, SALES, 'agt_'];
    const handles = [OLD_HANDLE, 'quilldesk', 'deskbot'];
    const slackIds = [SUPPORT_APP, SALES_APP, SHARED_APP, GRANT.botUserId, 'U07SOMEONE1', TEAM_ID];
    const neverAnywhere = [...tokens, ...people, ...agents, ...handles, ...slackIds, FAILURE_CANARY];
    for (const x of worlds) {
      // A rename's answer is its new name, by design; nothing else of the bot's.
      const replies = JSON.stringify(x.replies);
      for (const text of neverAnywhere) expect(replies, text).not.toContain(text);
      // Log lines are code-only: an install id, a stage, a code. Not a name either.
      const logged = JSON.stringify(x.lines);
      for (const text of [...neverAnywhere, OLD_NAME, NEW_NAME, 'Sales Desk', 'canopy-works']) {
        expect(logged, text).not.toContain(text);
      }
    }
  });
});
