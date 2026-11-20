import { HookBus, PluginError, makeAgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { isTemporarySlackCode } from '../admission.js';
import { createBotRequestDms } from '../bot-request-dms.js';
import { agentSeenBy } from '../bot-requests.js';
import { createLifetime } from '../lifetime.js';
import {
  BOT_REQUEST_DMS_MAX,
  BOT_REQUEST_DM_RECORDS_MAX,
  BOT_REQUEST_DM_TTL_MS,
  BOT_REQUEST_FANOUTS_MAX,
  BOT_REQUEST_FANOUT_WINDOW_MS,
} from '../limits.js';
import type { SecretName, SecretStore } from '../secrets.js';
import { SlackApiError, type SlackApi } from '../slack-api.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { memoryStore } from './memory-install-store.js';

/*
  A bot request's Slack DMs (bot-request-dms.ts, TASK-1170), over auth's and
  @ax/agents' answers on the bus, the in-memory install and channel stores, a
  fake vault read, a recording fake Slack, the plugin's real lifetime and a
  clock the test moves.

  What is pinned here: an AX admin is DMed only when Slack finds a full
  member of the shared workspace by their address AND that member's
  confirmed email maps back to the same AX account, and the requester never
  is; at most BOT_REQUEST_DMS_MAX of them, in auth's order, and at most
  BOT_REQUEST_FANOUTS_MAX fan-outs per requester per window; a fan-out stops
  at Slack's first temporary failure and goes on past any other; a close
  redraws every DM it can exactly once, whichever way it races the fan-out,
  and no DM goes out once it's known; no method ever rejects; and no log line
  carries an email, a name, an id other than the request's or the install's,
  a ts or a token.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The web app's origin, as configured: a trailing slash never doubles in the link. */
const ORIGIN = 'https://ax.example/';
const APPROVE_URL = 'https://ax.example/?admin=slack';
const NOW_MS = Date.parse('2026-11-20T12:00:00.000Z');

/** The shared app (Admin › Slack), its workspace, and its bot's token. */
const SHARED_INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const TEAM_ID = 'T07ABCDEF12';
const SHARED_TOKEN = fakeBotToken('SHAREDBOTSECRET');

const CARE_TEAM = 'team_care';
const SUPPORT: FakeAgent = {
  id: 'agt_support',
  displayName: 'Support',
  visibility: 'team',
  ownerType: 'team',
  ownerId: CARE_TEAM,
};

/** Ada's open request for the support agent's bot: our own 22-character id. */
const REQUEST = 'U3VwcG9ydEJvdEFzazAwMQ';
const BOT_NAME = 'Support Helper';
/** A request's own id, by number: 22 characters of base64url, like a real one. */
const requestIdOf = (n: number): string => `Rq${String(n).padStart(20, '0')}`;

/** Someone AX knows. `slackId` is their account in the shared workspace, found by `email`. */
interface Person {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  slackId: string;
}

/** A team admin of the care team: she asks. */
const ADA: Person = {
  id: 'usr_ada',
  email: 'ada@canopyworks.example',
  displayName: 'Ada Lovelace',
  isAdmin: false,
  slackId: 'U07ADA00001',
};
/** Another team admin of the care team. */
const SAM: Person = {
  id: 'usr_sam',
  email: 'sam@canopyworks.example',
  displayName: 'Sam Sales',
  isAdmin: false,
  slackId: 'U07SAM00001',
};
/** AX admins, each a full member of the shared workspace with the same confirmed address. */
const GRACE: Person = {
  id: 'usr_grace',
  email: 'grace@canopyworks.example',
  displayName: 'Grace Hopper',
  isAdmin: true,
  slackId: 'U07GRACE001',
};
const KAY: Person = {
  id: 'usr_kay',
  email: 'kay@canopyworks.example',
  displayName: 'Kay McNulty',
  isAdmin: true,
  slackId: 'U07KAY00001',
};
const LIN: Person = {
  id: 'usr_lin',
  email: 'lin@canopyworks.example',
  displayName: 'Lin Chen',
  isAdmin: true,
  slackId: 'U07LIN00001',
};
const EVERYONE: readonly Person[] = [ADA, SAM, GRACE, KAY, LIN];

/** One more AX admin, by first name: `<name>@canopyworks.example`. */
function admin(name: string, slackId: string): Person {
  return {
    id: `usr_${name}`,
    email: `${name}@canopyworks.example`,
    displayName: `${name[0]!.toUpperCase()}${name.slice(1)} Admin`,
    isAdmin: true,
    slackId,
  };
}

/** auth:list-admins' `admins`, for these people, in this order. */
const listed = (...people: Person[]) => people.map((p) => ({ userId: p.id, email: p.email }));

/** The IM Slack answers a DM to `slackId` with (the fake's rule): `D…`, never the user id. */
const dmOf = (slackId: string): string => `D${slackId.slice(1)}`;
/** The fake's ts for its nth post, counting from 1. */
const tsOf = (n: number): string => `1763640000.${String(n).padStart(6, '0')}`;

/** Text a failure's message carries, which no log line may repeat. */
const FAILURE_CANARY = 'failure-text-canary-7c2e';
/** A database or vault fault, as pg throws one: an errno code (logged) and a message (never logged). */
const connectionReset = (): Error =>
  Object.assign(new Error(`connection reset ${FAILURE_CANARY}`), { code: 'ECONNRESET' });
const authDown = (): PluginError =>
  new PluginError({ code: 'store-unavailable', plugin: '@ax/auth-better', message: `down ${FAILURE_CANARY}` });

/** A race test parks calls on purpose: one whose call never comes should fail fast, not at the 60 s default. */
const RACE_TIMEOUT_MS = 10_000;

// Built from code points, never typed (source-hygiene.test.ts).
const RLO = String.fromCharCode(0x202e);

const HOW =
  'Approve opens Slack settings in the web app, where you add the bot with your own configuration token. ' +
  'Nothing secret goes through Slack.';
const SUBJECT = 'Ada Lovelace wants to add @Support Helper (Support agent).';

/** An admin's DM about `requestId`, as Slack should get it: the subject, Approve and Decline, how Approve works. */
function asked(subject = SUBJECT, requestId = REQUEST) {
  return {
    text: 'A team asked for its own Slack bot.',
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: subject, emoji: false } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve', emoji: false },
            style: 'primary',
            url: APPROVE_URL,
            action_id: 'ax_bot_request_approve',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Decline', emoji: false },
            action_id: 'ax_bot_request_decline',
            value: requestId,
          },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: HOW }] },
    ],
  };
}

/** The same DM once answered: the subject, then `line` where the buttons were. */
function answered(line: string, subject = SUBJECT) {
  return {
    text: line,
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: subject, emoji: false } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
    ],
  };
}

const sentLine = (sent: number, skipped: number, requestId = REQUEST) => ({
  level: 'info',
  msg: 'slack_bot_request_dms_sent',
  fields: { requestId, sent, skipped },
});
const failedLine = (stage: string, code: string, key: Record<string, string> = { requestId: REQUEST }) => ({
  level: 'warn',
  msg: 'slack_bot_request_dm_failed',
  fields: { ...key, stage, code },
});

// ── The fakes ───────────────────────────────────────────────────────────────

/** A call that waits until `release()`: `reached` settles once it is waiting. */
interface Hold {
  reached: Promise<void>;
  release: () => void;
}

type Gates = Map<string, { gate: Promise<void>; arrived: () => void }>;

function holdOn(gates: Gates, key: string): Hold {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  gates.set(key, { gate, arrived });
  return { reached, release };
}

/** If `key` is held, wait for its release (once). */
async function pass(gates: Gates, key: string): Promise<void> {
  const held = gates.get(key);
  if (held === undefined) return;
  gates.delete(key);
  held.arrived();
  await held.gate;
}

/**
 * auth's three hooks, as @ax/auth-better answers them, over people the test
 * adds: `auth:list-admins` (`admins`, or `listAnswer` as given),
 * `auth:get-user` by id, and `auth:find-user-by-email` by the address exactly
 * as given (`accounts`; null when nobody has it). `faults` makes a hook (or
 * one hook for one argument, `<hook> <arg>`) throw; `hold` parks one call.
 */
function fakeAuth(bus: HookBus) {
  const users = new Map<string, { id: string; email: string | null; displayName: string | null; isAdmin: boolean }>();
  const accounts = new Map<string, string | null>();
  const gates: Gates = new Map();
  const auth = {
    users,
    accounts,
    admins: [] as Array<{ userId: string; email: string }>,
    listAnswer: undefined as unknown,
    faults: new Map<string, unknown>(),
    /** Every call, in order, as `<hook> <arg>`. */
    asked: [] as string[],
    add(p: Person): void {
      users.set(p.id, { id: p.id, email: p.email, displayName: p.displayName, isAdmin: p.isAdmin });
      accounts.set(p.email, p.id);
    },
    hold: (hook: string, arg: string): Hold => holdOn(gates, `${hook} ${arg}`),
  };
  const enter = async (hook: string, arg: string): Promise<void> => {
    const key = arg === '' ? hook : `${hook} ${arg}`;
    auth.asked.push(key);
    await pass(gates, key);
    const fault = auth.faults.get(key) ?? auth.faults.get(hook);
    if (fault !== undefined) throw fault;
  };
  bus.registerService('auth:list-admins', '@ax/auth-better', async () => {
    await enter('auth:list-admins', '');
    return auth.listAnswer !== undefined ? auth.listAnswer : { admins: auth.admins.map((a) => ({ ...a })) };
  });
  bus.registerService('auth:get-user', '@ax/auth-better', async (_ctx, raw) => {
    const { userId } = raw as { userId: string };
    await enter('auth:get-user', userId);
    const user = users.get(userId);
    return user === undefined ? null : { ...user };
  });
  bus.registerService('auth:find-user-by-email', '@ax/auth-better', async (_ctx, raw) => {
    const { email } = raw as { email: string };
    await enter('auth:find-user-by-email', email);
    const userId = accounts.get(email);
    return typeof userId === 'string' ? { userId } : null;
  });
  return auth;
}

type Method = keyof SlackApi;
interface SlackCall {
  method: Method;
  token: string;
  args: Record<string, unknown>;
}

/** A users.info `user`, as Slack answers it for a full member with a confirmed email. */
function slackUser(id: string, email: string, over: Record<string, unknown> = {}) {
  return {
    id,
    team_id: TEAM_ID,
    name: id.toLowerCase(),
    deleted: false,
    real_name: `Slack Name ${id}`,
    is_admin: false,
    is_owner: false,
    is_bot: false,
    is_app_user: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_email_confirmed: true,
    profile: { email, real_name: `Slack Name ${id}`, display_name: `slack-display-${id}` },
    ...over,
  };
}

/**
 * A Slack that records every call: `users.lookupByEmail` from `byEmail` (a
 * user id, or an Error thrown; anyone else is `users_not_found`), `users.info`
 * from `users` (anyone else is `user_not_found`), a DM post that answers the
 * IM (`dmOf`) and the next ts (`tsOf`), and `chat.update`. Any other method
 * throws: the DMs never call it.
 */
function fakeSlack() {
  const calls: SlackCall[] = [];
  const byEmail = new Map<string, string | Error>();
  const users = new Map<string, unknown>();
  /** Posts that fail, by the user posted to; redraws that fail, by IM. */
  const postFailures = new Map<string, Error>();
  const updateFailures = new Map<string, Error>();
  const gates: Gates = new Map();
  let posts = 0;
  const enter = async (method: Method, token: string, args: Record<string, unknown>, key: string): Promise<void> => {
    calls.push({ method, token, args: structuredClone(args) });
    await pass(gates, `${method} ${key}`);
  };
  const notHere =
    (method: Method) =>
    async (): Promise<never> => {
      calls.push({ method, token: '', args: {} });
      throw new Error(`a bot request's DMs never call ${method}`);
    };
  const api: SlackApi = {
    rotateConfigToken: notHere('rotateConfigToken'),
    createApp: notHere('createApp'),
    updateApp: notHere('updateApp'),
    deleteApp: notHere('deleteApp'),
    setAppIcon: notHere('setAppIcon'),
    oauthAccess: notHere('oauthAccess'),
    async usersInfo(token, user) {
      await enter('usersInfo', token, { user }, user);
      const answer = users.get(user);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new SlackApiError('users.info', 'user_not_found');
      return structuredClone(answer);
    },
    async usersLookupByEmail(token, email) {
      await enter('usersLookupByEmail', token, { email }, email);
      const answer = byEmail.get(email);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new SlackApiError('users.lookupByEmail', 'users_not_found');
      return answer;
    },
    postMessage: notHere('postMessage'),
    postBlocks: notHere('postBlocks'),
    async postDirect(token, a) {
      await enter('postDirect', token, { ...a }, a.user);
      const failure = postFailures.get(a.user);
      if (failure !== undefined) throw failure;
      posts += 1;
      return { channel: dmOf(a.user), ts: tsOf(posts) };
    },
    async updateMessage(token, a) {
      await enter('updateMessage', token, { ...a }, a.channel);
      const failure = updateFailures.get(a.channel);
      if (failure !== undefined) throw failure;
    },
    postEphemeral: notHere('postEphemeral'),
    startStream: notHere('startStream'),
    appendStream: notHere('appendStream'),
    stopStream: notHere('stopStream'),
    addReaction: notHere('addReaction'),
    removeReaction: notHere('removeReaction'),
    conversationsInfo: notHere('conversationsInfo'),
    conversationsList: notHere('conversationsList'),
    conversationsJoin: notHere('conversationsJoin'),
  };
  return {
    api,
    calls,
    byEmail,
    users,
    postFailures,
    updateFailures,
    /** `p` as a full member Slack finds by their AX address, confirming `email` (theirs unless told). */
    add(p: Person, over: Record<string, unknown> = {}, email = p.email): void {
      byEmail.set(p.email, p.slackId);
      users.set(p.slackId, slackUser(p.slackId, email, over));
    },
    /** The next call of `method` about `key` (an email, a user id or an IM) waits. */
    hold: (method: Method, key: string): Hold => holdOn(gates, `${method} ${key}`),
    of: (method: Method): SlackCall[] => calls.filter((c) => c.method === method),
  };
}

// ── The world ───────────────────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

async function world(o: { shared?: 'active' | 'pending' | 'none'; logger?: 'throws' } = {}) {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    if (o.logger === 'throws') throw new Error(`logger down ${FAILURE_CANARY}`);
    lines.push({ level, msg, fields: { ...fields } });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  // The bus never reports a stall of its own: a held fake is a test's point.
  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const auth = fakeAuth(bus);
  for (const p of EVERYONE) auth.add(p);
  const agents = fakeAgents(bus);
  agents.addAgent(SUPPORT);
  agents.setRole(CARE_TEAM, ADA.id, 'admin');
  agents.setRole(CARE_TEAM, SAM.id, 'admin');

  const slack = fakeSlack();
  for (const p of EVERYONE) slack.add(p);

  const clock = { ms: NOW_MS };
  const memory = memoryStore(() => clock.ms, []);
  if (o.shared !== 'none') {
    await memory.store.insertPending({
      installId: SHARED_INSTALL,
      appId: 'A07SHAREDAPP',
      clientId: '7512345678901.7500000000001',
      botName: 'canopy-works',
      connectedByUserId: KAY.id,
    });
    if (o.shared !== 'pending') {
      await memory.store.activate(SHARED_INSTALL, {
        teamId: TEAM_ID,
        teamName: 'Canopy Works',
        botUserId: 'U07BOTUSER1',
        installedAt: new Date(NOW_MS),
      });
    }
  }
  /** Each install's bot token in the vault: a token, none (null), or a fault. */
  const tokens = new Map<string, string | null | Error>([[SHARED_INSTALL, SHARED_TOKEN]]);
  const vaultReads: Array<{ installId: string; name: SecretName }> = [];
  const secrets: Pick<SecretStore, 'get'> = {
    async get(install, name) {
      vaultReads.push({ installId: install.installId, name });
      const token = tokens.get(install.installId);
      if (token instanceof Error) throw token;
      return name === 'bot-token' ? (token ?? null) : null;
    },
  };

  const lifetime = createLifetime();
  const dms = createBotRequestDms({
    bus,
    api: slack.api,
    installs: memory.store,
    secrets,
    lifetime,
    publicOrigin: ORIGIN,
    logger,
    now: () => clock.ms,
  });

  return {
    bus,
    auth,
    agents,
    slack,
    clock,
    memory,
    tokens,
    vaultReads,
    lifetime,
    lines,
    dms,
    /** Ada asks for the support agent's bot, as REQUEST, unless told otherwise. */
    open: (over: Partial<{ requestId: string; agentId: string; requesterUserId: string; botName: string }> = {}) =>
      dms.opened({ requestId: REQUEST, agentId: SUPPORT.id, requesterUserId: ADA.id, botName: BOT_NAME, ...over }),
    /** REQUEST is approved by Grace, unless told otherwise. */
    close: (
      over: Partial<{
        requestId: string;
        requesterUserId: string;
        botName: string;
        outcome: 'approved' | 'declined';
        byUserId: string;
      }> = {},
    ) =>
      dms.closed({
        requestId: REQUEST,
        requesterUserId: ADA.id,
        botName: BOT_NAME,
        outcome: 'approved',
        byUserId: GRACE.id,
        ...over,
      }),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Start watching from here: what came before was the test's own setting up. */
function forget(w: World): void {
  w.slack.calls.length = 0;
  w.auth.asked.length = 0;
  w.agents.calls.length = 0;
  w.vaultReads.length = 0;
  w.lines.length = 0;
}

/** Every redraw Slack was asked for, in order. */
const updates = (w: World) => w.slack.of('updateMessage').map((c) => c.args);
/** Whom each DM went to, in order. */
const dmedSlackIds = (w: World) => w.slack.of('postDirect').map((c) => c.args['user']);
const lookedUp = (w: World) => w.slack.of('usersLookupByEmail').map((c) => c.args['email']);
/** The subject an admin's DM was drawn with. */
function subjectOf(w: World, n = 0): unknown {
  const blocks = w.slack.of('postDirect')[n]?.args['blocks'] as Array<{ text?: { text?: unknown } }> | undefined;
  return blocks?.[0]?.text?.text;
}

/** No line may carry any of `words`: each email, name, id, Slack id, IM, ts or token the world handed out. */
function expectNoLeak(lines: readonly Line[], people: readonly Person[]): void {
  const words = [
    SHARED_TOKEN,
    TEAM_ID,
    SUPPORT.id,
    SUPPORT.displayName,
    BOT_NAME,
    '1763640000',
    FAILURE_CANARY,
    ...people.flatMap((p) => [p.id, p.email, p.displayName ?? p.id, p.slackId, dmOf(p.slackId)]),
  ];
  for (const line of lines) {
    const text = JSON.stringify(line);
    for (const word of words) expect(text, `${line.msg} names ${word}`).not.toContain(word);
  }
}

// ── opened ──────────────────────────────────────────────────────────────────

describe('opened', () => {
  it('DMs every AX admin who is a full member and whose confirmed email maps back to them', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE, KAY);

    await w.open();

    expect(w.slack.calls).toEqual([
      { method: 'usersLookupByEmail', token: SHARED_TOKEN, args: { email: GRACE.email } },
      { method: 'usersInfo', token: SHARED_TOKEN, args: { user: GRACE.slackId } },
      { method: 'postDirect', token: SHARED_TOKEN, args: { user: GRACE.slackId, ...asked() } },
      { method: 'usersLookupByEmail', token: SHARED_TOKEN, args: { email: KAY.email } },
      { method: 'usersInfo', token: SHARED_TOKEN, args: { user: KAY.slackId } },
      { method: 'postDirect', token: SHARED_TOKEN, args: { user: KAY.slackId, ...asked() } },
    ]);
    // Each email Slack confirmed, exactly as users.info gave it, maps back to that admin.
    expect(w.auth.asked.filter((a) => a.startsWith('auth:find-user-by-email'))).toEqual([
      `auth:find-user-by-email ${GRACE.email}`,
      `auth:find-user-by-email ${KAY.email}`,
    ]);
    // The agent as its requester sees it; the token is the shared install's own.
    expect(w.agents.inputs('agents:resolve')).toEqual([{ agentId: SUPPORT.id, userId: ADA.id }]);
    expect(w.vaultReads).toEqual([{ installId: SHARED_INSTALL, name: 'bot-token' }]);
    expect(w.lines).toEqual([sentLine(2, 0)]);
  });

  it("skips the requester, an admin Slack doesn't know, a guest, a deactivated or unconfirmed member, and one whose Slack email maps to another account or to none", async () => {
    const w = await world();
    const ULLA = admin('ulla', 'U07ULLA0001');
    const GUS = admin('gus', 'U07GUS00001');
    const DEE = admin('dee', 'U07DEE00001');
    const UNA = admin('una', 'U07UNA00001');
    const ELI = admin('eli', 'U07ELI00001');
    const NIA = admin('nia', 'U07NIA00001');
    for (const p of [ULLA, GUS, DEE, UNA, ELI, NIA]) w.auth.add(p);
    // Slack doesn't know Ulla's address. Gus is a guest, Dee was deactivated, Una never confirmed her email.
    w.slack.add(GUS, { is_restricted: true });
    w.slack.add(DEE, { deleted: true });
    w.slack.add(UNA, { is_email_confirmed: false });
    // Eli's Slack account confirms an address that is someone else's in AX; Nia's, one nobody's is.
    w.slack.add(ELI, {}, 'eli.personal@canopyworks.example');
    w.auth.accounts.set('eli.personal@canopyworks.example', 'usr_someone_else');
    w.slack.add(NIA, {}, 'nia@old-canopy.example');
    // Ada is an AX admin too, and the one who asked.
    w.auth.admins = listed(ADA, ULLA, GUS, DEE, UNA, ELI, NIA, GRACE);

    await w.open();

    expect(dmedSlackIds(w)).toEqual([GRACE.slackId]);
    // Ada is never looked up: she isn't asked about her own request.
    expect(lookedUp(w)).toEqual([ULLA.email, GUS.email, DEE.email, UNA.email, ELI.email, NIA.email, GRACE.email]);
    // Only an account Slack admitted is mapped back, and by the email Slack confirmed.
    expect(w.auth.asked.filter((a) => a.startsWith('auth:find-user-by-email'))).toEqual([
      'auth:find-user-by-email eli.personal@canopyworks.example',
      'auth:find-user-by-email nia@old-canopy.example',
      `auth:find-user-by-email ${GRACE.email}`,
    ]);
    expect(w.lines).toEqual([
      // admission.ts's own line for an address nobody has (Nia's): the install alone.
      { level: 'info', msg: 'slack_sender_not_mapped', fields: { installId: SHARED_INSTALL } },
      sentLine(1, 6),
    ]);
    expectNoLeak(w.lines, [ADA, ULLA, GUS, DEE, UNA, ELI, NIA, GRACE]);
  });

  it('no shared install, an inactive one, no bot token, or an auth:list-admins fault sends nothing, logged code-only; it never rejects', async () => {
    const cases: Array<{ name: string; shared?: 'pending' | 'none'; set?: (w: World) => void | Promise<void>; line: Line }> = [
      { name: 'no shared install', shared: 'none', line: failedLine('workspace', 'missing') },
      { name: 'a pending one', shared: 'pending', line: failedLine('workspace', 'inactive') },
      {
        name: 'the store failing',
        set: (w) => void w.memory.failures.set('current', connectionReset()),
        line: failedLine('workspace', 'ECONNRESET'),
      },
      { name: 'no bot token', set: (w) => void w.tokens.set(SHARED_INSTALL, null), line: failedLine('bot-token', 'missing') },
      {
        name: 'the vault failing',
        set: (w) => void w.tokens.set(SHARED_INSTALL, connectionReset()),
        line: failedLine('bot-token', 'ECONNRESET'),
      },
      {
        name: 'auth failing to list the admins',
        set: (w) => void w.auth.faults.set('auth:list-admins', authDown()),
        line: failedLine('admins', 'store-unavailable'),
      },
      ...[null, {}, { admins: 'everyone' }, [listed(GRACE)], { admins: null }].map((answer) => ({
        name: `auth answering ${JSON.stringify(answer)}`,
        set: (w: World) => {
          w.auth.listAnswer = answer;
        },
        line: failedLine('admins', 'bad-answer'),
      })),
      { name: 'a plugin shutting down', set: (w) => w.lifetime.drain(), line: failedLine('fan-out', 'shutting-down') },
    ];
    for (const c of cases) {
      const w = await world(c.shared !== undefined ? { shared: c.shared } : {});
      w.auth.admins = listed(GRACE, KAY);
      await c.set?.(w);

      await expect(w.open(), c.name).resolves.toBeUndefined();

      expect(w.slack.calls, c.name).toEqual([]);
      expect(w.lines, c.name).toEqual([c.line]);
    }

    // A logger that throws changes nothing either: the DMs still go, and nothing rejects.
    const loud = await world({ logger: 'throws' });
    loud.auth.admins = listed(GRACE);
    await expect(loud.open()).resolves.toBeUndefined();
    expect(dmedSlackIds(loud)).toEqual([GRACE.slackId]);
    await expect(loud.close()).resolves.toBeUndefined();
    expect(updates(loud)).toHaveLength(1);
  });

  it('stops at the first temporary Slack failure (ratelimited on lookup; timeout on post): no further Slack call', async () => {
    // Rate limited looking Grace up: nobody after her is looked up.
    const lookup = await world();
    lookup.auth.admins = listed(GRACE, KAY);
    lookup.slack.byEmail.set(GRACE.email, new SlackApiError('users.lookupByEmail', 'ratelimited', 30_000));
    await lookup.open();
    expect(lookup.slack.calls.map((c) => c.method)).toEqual(['usersLookupByEmail']);
    expect(lookup.lines).toEqual([failedLine('lookup', 'ratelimited'), sentLine(0, 2)]);

    // Slack's own 5xx on users.info stops it too.
    const info = await world();
    info.auth.admins = listed(GRACE, KAY);
    info.slack.users.set(GRACE.slackId, new SlackApiError('users.info', 'http-503'));
    await info.open();
    expect(info.slack.calls.map((c) => c.method)).toEqual(['usersLookupByEmail', 'usersInfo']);
    expect(info.lines).toEqual([failedLine('admission', 'http-503'), sentLine(0, 2)]);

    // Grace was DMed; Kay's DM timed out; Lin is never looked up.
    const post = await world();
    post.auth.admins = listed(GRACE, KAY, LIN);
    post.slack.postFailures.set(KAY.slackId, new SlackApiError('chat.postMessage', 'timeout'));
    await post.open();
    expect(post.slack.calls.map((c) => c.method)).toEqual([
      'usersLookupByEmail',
      'usersInfo',
      'postDirect',
      'usersLookupByEmail',
      'usersInfo',
      'postDirect',
    ]);
    expect(dmedSlackIds(post)).toEqual([GRACE.slackId, KAY.slackId]);
    expect(post.lines).toEqual([failedLine('post', 'timeout'), sentLine(1, 2)]);
  });

  it("one admin's failed post doesn't stop the others; the summary line counts sent and skipped", async () => {
    const w = await world();
    const MAX = admin('max', 'U07MAX00001');
    const NED = admin('ned', 'U07NED00001');
    for (const p of [MAX, NED]) {
      w.auth.add(p);
      w.slack.add(p);
    }
    // Slack refuses Grace's DM, won't look Lin's address up, can't read Max's account; auth fails mapping Ned.
    w.slack.postFailures.set(GRACE.slackId, new SlackApiError('chat.postMessage', 'channel_not_found'));
    w.slack.byEmail.set(LIN.email, new SlackApiError('users.lookupByEmail', 'enterprise_is_restricted'));
    w.slack.users.set(MAX.slackId, new SlackApiError('users.info', 'user_not_found'));
    w.auth.faults.set(`auth:find-user-by-email ${NED.email}`, authDown());
    w.auth.admins = listed(GRACE, LIN, MAX, NED, KAY);

    await w.open();

    expect(dmedSlackIds(w)).toEqual([GRACE.slackId, KAY.slackId]);
    expect(w.lines).toEqual([
      failedLine('post', 'channel_not_found'),
      failedLine('lookup', 'enterprise_is_restricted'),
      failedLine('admission', 'user_not_found'),
      failedLine('find-user', 'store-unavailable'),
      sentLine(1, 4),
    ]);
    expectNoLeak(w.lines, [GRACE, LIN, MAX, NED, KAY]);
  });

  it(`DMs at most BOT_REQUEST_DMS_MAX (${BOT_REQUEST_DMS_MAX}) admins, in the order auth listed them`, async () => {
    const w = await world();
    const many = Array.from({ length: BOT_REQUEST_DMS_MAX + 5 }, (_, n) =>
      admin(`admin${String(n).padStart(2, '0')}`, `U07ADM${String(n).padStart(5, '0')}`),
    );
    for (const p of many) {
      w.auth.add(p);
      w.slack.add(p);
    }
    // The requester, and an admin listed twice, take no place of anyone's.
    w.auth.admins = listed(ADA, many[0]!, many[0]!, ...many.slice(1));

    await w.open();

    expect(dmedSlackIds(w)).toEqual(many.slice(0, BOT_REQUEST_DMS_MAX).map((p) => p.slackId));
    expect(lookedUp(w)).toEqual(many.slice(0, BOT_REQUEST_DMS_MAX).map((p) => p.email));
    expect(w.lines).toEqual([sentLine(BOT_REQUEST_DMS_MAX, 0)]);
  });

  it("a requester's fourth ask inside the window DMs nobody, logged too-many-asks; one window later it DMs again", async () => {
    const w = await world();
    w.auth.admins = listed(GRACE);
    for (let n = 0; n < BOT_REQUEST_FANOUTS_MAX; n += 1) await w.open({ requestId: requestIdOf(n) });
    expect(dmedSlackIds(w)).toHaveLength(BOT_REQUEST_FANOUTS_MAX);
    forget(w);

    // One more inside the window: nobody is asked anything.
    w.clock.ms = NOW_MS + BOT_REQUEST_FANOUT_WINDOW_MS - 1;
    const fourth = requestIdOf(BOT_REQUEST_FANOUTS_MAX);
    await w.open({ requestId: fourth });
    expect(w.slack.calls).toEqual([]);
    expect(w.auth.asked).toEqual([]);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_bot_request_dms_skipped', fields: { requestId: fourth, reason: 'too-many-asks' } },
    ]);

    // Sam's ask isn't held back by hers.
    forget(w);
    await w.open({ requestId: requestIdOf(50), requesterUserId: SAM.id });
    expect(dmedSlackIds(w)).toEqual([GRACE.slackId]);

    // One window after her first: she can ask again.
    forget(w);
    w.clock.ms = NOW_MS + BOT_REQUEST_FANOUT_WINDOW_MS;
    await w.open({ requestId: requestIdOf(60) });
    expect(dmedSlackIds(w)).toEqual([GRACE.slackId]);
    expect(w.lines).toEqual([sentLine(1, 0, requestIdOf(60))]);
  });

  it(`the requester shows by display name, never email; with none, "A team admin"; an agent the requester can't see leaves the agent out of the subject`, async () => {
    // No display name: her email would go to Slack, which keeps a copy. The fallback goes instead.
    const unnamed = await world();
    unnamed.auth.admins = listed(GRACE);
    unnamed.auth.users.get(ADA.id)!.displayName = null;
    await unnamed.open();
    expect(subjectOf(unnamed)).toBe('A team admin wants to add @Support Helper (Support agent).');
    expect(unnamed.lines).toEqual([sentLine(1, 0)]);

    // Auth failing to say who she is: the same, logged code-only.
    const down = await world();
    down.auth.admins = listed(GRACE);
    down.auth.faults.set(`auth:get-user ${ADA.id}`, connectionReset());
    await down.open();
    expect(subjectOf(down)).toBe('A team admin wants to add @Support Helper (Support agent).');
    expect(down.lines).toEqual([failedLine('requester', 'ECONNRESET'), sentLine(1, 0)]);

    // She left the team: as she'd see it, the agent has no name to give.
    const left = await world();
    left.auth.admins = listed(GRACE);
    left.agents.setRole(CARE_TEAM, ADA.id, null);
    await left.open();
    expect(subjectOf(left)).toBe('Ada Lovelace wants to add @Support Helper for a team agent.');
    expect(left.lines).toEqual([sentLine(1, 0)]);

    // @ax/agents failing: the same subject, logged code-only.
    const agentsDown = await world();
    agentsDown.auth.admins = listed(GRACE);
    agentsDown.agents.faults.set('agents:resolve', connectionReset());
    await agentsDown.open();
    expect(subjectOf(agentsDown)).toBe('Ada Lovelace wants to add @Support Helper for a team agent.');
    expect(agentsDown.lines).toEqual([failedLine('agent', 'ECONNRESET'), sentLine(1, 0)]);
  });
});

// ── closed ──────────────────────────────────────────────────────────────────

describe('closed', () => {
  it('approved: every DM the fan-out posted is redrawn: the same subject, "<name> approved this." where the buttons were', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE, KAY);
    await w.open();
    forget(w);

    await w.close({ outcome: 'approved', byUserId: GRACE.id });

    expect(w.slack.calls).toEqual([
      {
        method: 'updateMessage',
        token: SHARED_TOKEN,
        args: { channel: dmOf(GRACE.slackId), ts: tsOf(1), ...answered('Grace Hopper approved this.') },
      },
      {
        method: 'updateMessage',
        token: SHARED_TOKEN,
        args: { channel: dmOf(KAY.slackId), ts: tsOf(2), ...answered('Grace Hopper approved this.') },
      },
    ]);
    // The token is read again for the redraw, from the install the DMs went through.
    expect(w.vaultReads).toEqual([{ installId: SHARED_INSTALL, name: 'bot-token' }]);
    expect(w.lines).toEqual([]);
  });

  it('declined: the same, "<name> declined this."; with no display name, "An admin"', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE, KAY);
    await w.open();
    forget(w);

    await w.close({ outcome: 'declined', byUserId: KAY.id });

    expect(updates(w)).toEqual([
      { channel: dmOf(GRACE.slackId), ts: tsOf(1), ...answered('Kay McNulty declined this.') },
      { channel: dmOf(KAY.slackId), ts: tsOf(2), ...answered('Kay McNulty declined this.') },
    ]);

    // Auth has no display name for whoever declined: never their email.
    const unnamed = await world();
    unnamed.auth.admins = listed(GRACE);
    unnamed.auth.users.get(KAY.id)!.displayName = null;
    await unnamed.open();
    forget(unnamed);
    await unnamed.close({ outcome: 'declined', byUserId: KAY.id });
    expect(updates(unnamed)).toEqual([
      { channel: dmOf(GRACE.slackId), ts: tsOf(1), ...answered('An admin declined this.') },
    ]);

    // Auth failing to say who it was: the same, logged code-only.
    const down = await world();
    down.auth.admins = listed(GRACE);
    await down.open();
    forget(down);
    down.auth.faults.set(`auth:get-user ${KAY.id}`, connectionReset());
    await down.close({ outcome: 'declined', byUserId: KAY.id });
    expect(updates(down)).toEqual([
      { channel: dmOf(GRACE.slackId), ts: tsOf(1), ...answered('An admin declined this.') },
    ]);
    expect(down.lines).toEqual([failedLine('closed-by', 'ECONNRESET')]);
  });

  it('a close during the fan-out: no DM goes out once it is known, and nobody else is looked up', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE, KAY, LIN);
    // Kay is being looked up when Grace approves.
    const kay = w.slack.hold('usersInfo', KAY.slackId);
    const opening = w.open();
    await kay.reached;
    const closing = w.close({ outcome: 'approved', byUserId: GRACE.id });
    kay.release();
    await Promise.all([opening, closing]);

    expect(dmedSlackIds(w)).toEqual([GRACE.slackId]);
    expect(lookedUp(w)).toEqual([GRACE.email, KAY.email]);
    expect(updates(w)).toEqual([
      { channel: dmOf(GRACE.slackId), ts: tsOf(1), ...answered('Grace Hopper approved this.') },
    ]);
    expect(w.lines).toEqual([sentLine(1, 2)]);
  }, RACE_TIMEOUT_MS);

  it('a close during the fan-out: a DM posted while the close looked up the name is redrawn once, by the close', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE, KAY);
    const post = w.slack.hold('postDirect', GRACE.slackId);
    const name = w.auth.hold('auth:get-user', GRACE.id);
    const opening = w.open();
    await post.reached;
    const closing = w.close({ outcome: 'approved', byUserId: GRACE.id });
    await name.reached;
    // Grace's DM lands while the close is still finding out what to call her.
    post.release();
    await opening;
    expect(updates(w)).toEqual([]);
    name.release();
    await closing;

    expect(dmedSlackIds(w)).toEqual([GRACE.slackId]);
    expect(lookedUp(w)).toEqual([GRACE.email]);
    expect(updates(w)).toEqual([
      { channel: dmOf(GRACE.slackId), ts: tsOf(1), ...answered('Grace Hopper approved this.') },
    ]);
    expect(w.lines).toEqual([sentLine(1, 1)]);
  }, RACE_TIMEOUT_MS);

  it('a close during the fan-out: a DM that lands after the close is redrawn once, by the fan-out', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE, KAY);
    const post = w.slack.hold('postDirect', GRACE.slackId);
    const opening = w.open();
    await post.reached;
    // The approve, and its redraw of every DM posted so far (none), are done first.
    await w.close({ outcome: 'approved', byUserId: GRACE.id });
    expect(updates(w)).toEqual([]);
    post.release();
    await opening;

    expect(dmedSlackIds(w)).toEqual([GRACE.slackId]);
    expect(lookedUp(w)).toEqual([GRACE.email]);
    expect(updates(w)).toEqual([
      { channel: dmOf(GRACE.slackId), ts: tsOf(1), ...answered('Grace Hopper approved this.') },
    ]);
    expect(w.lines).toEqual([sentLine(1, 1)]);
  }, RACE_TIMEOUT_MS);

  it('a request with no record (skipped, forgotten) redraws nothing and never rejects', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE);
    // Skipped: past the requester's asks for the window, so nothing was kept.
    for (let n = 0; n < BOT_REQUEST_FANOUTS_MAX; n += 1) await w.open({ requestId: requestIdOf(n) });
    const skipped = requestIdOf(BOT_REQUEST_FANOUTS_MAX);
    await w.open({ requestId: skipped });
    forget(w);

    await expect(w.close({ requestId: skipped })).resolves.toBeUndefined();
    // Forgotten: never opened since the plugin started.
    await expect(w.close({ requestId: requestIdOf(99) })).resolves.toBeUndefined();

    expect(w.slack.calls).toEqual([]);
    // Nobody's name is looked up for nothing to redraw.
    expect(w.auth.asked).toEqual([]);
    expect(w.lines).toEqual([]);

    // A plugin shutting down: nothing, logged, never a rejection.
    const down = await world();
    down.auth.admins = listed(GRACE);
    await down.open();
    forget(down);
    await down.lifetime.drain();
    await expect(down.close()).resolves.toBeUndefined();
    expect(down.slack.calls).toEqual([]);
    expect(down.lines).toEqual([failedLine('close', 'shutting-down')]);
  });

  it('a failed redraw is logged and the others are still redrawn', async () => {
    const w = await world();
    w.auth.admins = listed(GRACE, KAY);
    await w.open();
    forget(w);
    w.slack.updateFailures.set(dmOf(GRACE.slackId), new SlackApiError('chat.update', 'message_not_found'));

    await w.close();

    expect(updates(w).map((u) => u['channel'])).toEqual([dmOf(GRACE.slackId), dmOf(KAY.slackId)]);
    expect(w.lines).toEqual([failedLine('update', 'message_not_found')]);

    // The shared app is gone since (a reset): nothing can be redrawn, and that is logged.
    const gone = await world();
    gone.auth.admins = listed(GRACE);
    await gone.open();
    await gone.memory.store.remove(SHARED_INSTALL);
    forget(gone);
    await gone.close();
    expect(gone.slack.calls).toEqual([]);
    expect(gone.lines).toEqual([failedLine('workspace', 'missing')]);
  });

  it(`records are bounded: past BOT_REQUEST_DM_RECORDS_MAX (${BOT_REQUEST_DM_RECORDS_MAX}) the oldest is forgotten, and past the TTL too`, async () => {
    const w = await world();
    w.auth.admins = listed(GRACE);
    // Each from a requester of its own, so the limit on asks never gets in the way.
    for (let n = 0; n <= BOT_REQUEST_DM_RECORDS_MAX; n += 1) {
      await w.open({ requestId: requestIdOf(n), requesterUserId: `usr_requester_${n}` });
    }
    forget(w);
    await w.close({ requestId: requestIdOf(0) });
    expect(w.slack.calls).toEqual([]);
    await w.close({ requestId: requestIdOf(1) });
    expect(updates(w).map((u) => [u['channel'], u['ts']])).toEqual([[dmOf(GRACE.slackId), tsOf(2)]]);

    // Just inside the TTL, a DM is still redrawn; at it, forgotten.
    const old = await world();
    old.auth.admins = listed(GRACE);
    await old.open({ requestId: requestIdOf(0) });
    await old.open({ requestId: requestIdOf(1) });
    forget(old);
    old.clock.ms = NOW_MS + BOT_REQUEST_DM_TTL_MS - 1;
    await old.close({ requestId: requestIdOf(0) });
    expect(updates(old).map((u) => u['ts'])).toEqual([tsOf(1)]);
    old.clock.ms = NOW_MS + BOT_REQUEST_DM_TTL_MS;
    await old.close({ requestId: requestIdOf(1) });
    expect(updates(old).map((u) => u['ts'])).toEqual([tsOf(1)]);
  });
});

// ── The pieces it shares ────────────────────────────────────────────────────

describe('agentSeenBy', () => {
  it("names a team agent as its requester sees it; one they can't see, one that's gone, or a fault (handed on) has no name", async () => {
    const lines: Line[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (msg, fields) => lines.push({ level: 'info', msg, fields: { ...fields } }),
      warn: (msg, fields) => lines.push({ level: 'warn', msg, fields: { ...fields } }),
      error: (msg, fields) => lines.push({ level: 'error', msg, fields: { ...fields } }),
      child: () => logger,
    };
    const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    const agents = fakeAgents(bus);
    agents.addAgent(SUPPORT);
    agents.addAgent({ ...SUPPORT, id: 'agt_blank', displayName: `${RLO} ` });
    agents.addAgent({ id: 'agt_ada_own', displayName: 'Ada Own', visibility: 'personal', ownerType: 'user', ownerId: ADA.id });
    agents.setRole(CARE_TEAM, ADA.id, 'admin');
    const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: ADA.id, logger });
    const faults: unknown[] = [];
    const seen = (agentId: string, requestedByUserId = ADA.id) =>
      agentSeenBy(bus, ctx, { agentId, requestedByUserId }, (err) => faults.push(err));

    expect(await seen(SUPPORT.id)).toEqual({ name: 'Support', teamId: CARE_TEAM });
    // Someone not on its team, an agent that's gone, a personal agent: no name, quietly.
    expect(await seen(SUPPORT.id, SAM.id)).toEqual({ name: null, teamId: null });
    expect(await seen('agt_gone')).toEqual({ name: null, teamId: null });
    expect(await seen('agt_ada_own')).toEqual({ name: null, teamId: null });
    // A team agent whose name has nothing printable: no name, but its team.
    expect(await seen('agt_blank')).toEqual({ name: null, teamId: CARE_TEAM });
    expect(faults).toEqual([]);

    const fault = connectionReset();
    agents.faults.set('agents:resolve', fault);
    expect(await seen(SUPPORT.id)).toEqual({ name: null, teamId: null });
    expect(faults).toHaveLength(1);
    expect((faults[0] as PluginError).cause).toBe(fault);
    expect(lines).toEqual([]);
  });
});

describe('isTemporarySlackCode', () => {
  it('is true only for a code that says Slack, or the way to it, was briefly not there', () => {
    for (const code of [
      'ratelimited',
      'timeout',
      'network',
      'http-500',
      'http-503',
      'http-599',
      'internal_error',
      'fatal_error',
      'service_unavailable',
      'request_timeout',
    ]) {
      expect(isTemporarySlackCode(code), code).toBe(true);
    }
    for (const code of [
      undefined,
      '',
      'users_not_found',
      'token_revoked',
      'user-mismatch',
      'http-404',
      'http-5000',
      'xratelimited',
      'ratelimited_x',
    ]) {
      expect(isTemporarySlackCode(code), String(code)).toBe(false);
    }
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it("no line carries an email, a name, a person's or agent's id, a Slack id, an IM, a ts or a token", async () => {
    const w = await world();
    const GUS = admin('gus', 'U07GUS00001');
    const ELI = admin('eli', 'U07ELI00001');
    for (const p of [GUS, ELI]) w.auth.add(p);
    w.slack.add(GUS, { is_restricted: true });
    w.slack.add(ELI, {}, 'eli.personal@canopyworks.example');
    w.slack.postFailures.set(KAY.slackId, new SlackApiError('chat.postMessage', 'channel_not_found'));
    w.slack.updateFailures.set(dmOf(GRACE.slackId), new SlackApiError('chat.update', 'message_not_found'));
    w.auth.faults.set(`auth:get-user ${ADA.id}`, authDown());
    w.auth.admins = listed(ADA, GUS, ELI, GRACE, KAY, LIN);

    await w.open();
    await w.close({ outcome: 'declined', byUserId: KAY.id });

    expect(w.lines.length).toBeGreaterThan(0);
    expectNoLeak(w.lines, [ADA, SAM, GUS, ELI, GRACE, KAY, LIN]);
  });
});
