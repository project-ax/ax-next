import { createHmac } from 'node:crypto';
import { HookBus, PluginError, type Logger } from '@ax/core';
import { describe, expect, it, vi } from 'vitest';
import { COMMANDS_ROUTE_PATH, createCommandsHandler, normalizeName } from '../commands.js';
import { COPY } from '../copy.js';
import { createEventsHandler, createSeenEvents } from '../events.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { createLifetime } from '../lifetime.js';
import {
  AGENT_NAME_ARG_MAX,
  COMMANDS_MAX_BODY_BYTES,
  EVENT_DEDUPE_MAX,
  EVENT_DEDUPE_TTL_MS,
  SLASH_REPLY_DEADLINE_MS,
  SLASH_TEXT_MAX,
} from '../limits.js';
import { SLASH_COMMAND, slackUrls } from '../manifest.js';
import type { SecretName } from '../secrets.js';
import { SlackApiError, type SlackApi, type SlackChannel } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  `/ax`, through its route handler. The rules pinned here: the route checks
  what the events route checks (the same 404, 401 and 413); the invoker is
  the signed `user_id`, admitted through users.info and mapped through auth,
  never anyone the text or `user_name` names; a refused invoker gets an
  empty 200 and AX is asked nothing about them; `connect` reaches only a
  team agent the invoker manages; `disconnect` needs the same rights, except
  for a binding whose agent is gone; and a slow answer is "working on it"
  now and the result once, privately, later.
*/

// ── Fixtures, shaped like what Slack really sends ───────────────────────────

const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const ORIGIN = 'https://ax.example';
const SIGNING_SECRET = 'test-signing-secret-not-real-01';
const BOT_TOKEN = fakeBotToken('COMMANDSTESTSECRET');
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const PENDING_ID = 'Zx8_n2-QpL4mVb7cRt1sYw';
const NO_SECRET_ID = 'Mm0rT7qWc3Yb9Vn2Ls5KdA';
const UNKNOWN_ID = 'Pk4wQ9eRt2Yu7Io1Lp6AsQ';
const APP_ID = 'A07QF9ZK2MN';
const TEAM_ID = 'T07ABCDEF12';
const STAMP = new Date('2026-10-01T00:00:00.000Z');

const ACTIVE: InstallRow = {
  installId: INSTALL_ID,
  status: 'active',
  appId: APP_ID,
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: TEAM_ID,
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_installer',
  createdAt: new Date('2026-11-13T11:00:00.000Z'),
  installedAt: new Date('2026-11-13T11:05:00.000Z'),
};
const PENDING: InstallRow = {
  ...ACTIVE,
  installId: PENDING_ID,
  status: 'pending',
  teamId: null,
  teamName: null,
  botUserId: null,
  installedAt: null,
};
const NO_SECRET: InstallRow = { ...ACTIVE, installId: NO_SECRET_ID };
/** A second active install, made before ACTIVE: the row `current()` answers with. */
const OLDER_ID = 'Hn5bV1cX8zLk3Jq7Wd2PfA';
const OLDER_BOT_TOKEN = fakeBotToken('OLDERINSTALLSECRET');
const OLDER: InstallRow = {
  ...ACTIVE,
  installId: OLDER_ID,
  appId: 'A07OLDAPP01',
  botUserId: 'U07OLDBOT01',
  createdAt: new Date('2026-11-12T11:00:00.000Z'),
  installedAt: new Date('2026-11-12T11:05:00.000Z'),
};

/** Someone in the install's Slack workspace, and their AX account (null: none). */
interface Person {
  slack: string;
  ax: string | null;
  email: string;
  name: string;
}
const ADA: Person = { slack: 'U07ADA00001', ax: 'usr_ada', email: 'ada@canopyworks.example', name: 'Ada Admin' };
const GRACE: Person = { slack: 'U07GRACE001', ax: 'usr_grace', email: 'grace@canopyworks.example', name: 'Grace Hopper' };
const MEL: Person = { slack: 'U07MEL00001', ax: 'usr_mel', email: 'mel@canopyworks.example', name: 'Mel Member' };
const OTTO: Person = { slack: 'U07OTTO0001', ax: 'usr_otto', email: 'otto@canopyworks.example', name: 'Otto Outsider' };
const CAROL: Person = { slack: 'U07CAROL001', ax: null, email: 'carol@canopyworks.example', name: 'Carol Newhire' };
const PEOPLE = [ADA, GRACE, MEL, OTTO, CAROL];
// Ada and Grace: team admins of the support team. Mel: a plain member of it.
// Otto: an AX user in no team, who owns a personal agent named "Support".
// Carol: a full member of the Slack workspace with no AX account.

const GUEST = 'U07GUEST001';
const BOT = 'U07BOTBOB01';
const STRANGER = 'U07STRANGE1';
const DEACTIVATED = 'U07GONE0001';
const FLAKY = 'U07FLAKY001'; // users.info is rate limited
const REVOKED = 'U07REVOKED1'; // users.info says the token is revoked

function slackUser(id: string, email: string, realName: string, over: Record<string, unknown> = {}) {
  return {
    id,
    team_id: TEAM_ID,
    name: realName.toLowerCase().replace(/\s+/g, '.'),
    deleted: false,
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_email_confirmed: true,
    profile: { email, real_name: realName, display_name: '' },
    ...over,
  };
}

const SLACK_USERS: Record<string, unknown> = {
  ...Object.fromEntries(PEOPLE.map((p) => [p.slack, slackUser(p.slack, p.email, p.name)])),
  [GUEST]: slackUser(GUEST, 'guest@partner.example', 'Gus Guest', { is_restricted: true }),
  [BOT]: slackUser(BOT, 'bot@canopyworks.example', 'Bob Bot', { is_bot: true }),
  [STRANGER]: slackUser(STRANGER, 'eve@elsewhere.example', 'Eve', { is_stranger: true, team_id: 'T07ELSEWHER' }),
  [DEACTIVATED]: slackUser(DEACTIVATED, 'gone@canopyworks.example', 'Gone', { deleted: true }),
  [FLAKY]: new SlackApiError('users.info', 'ratelimited', 1000),
  [REVOKED]: new SlackApiError('users.info', 'token_revoked'),
};

const SUPPORT_TEAM = 'team_support';
const SALES_TEAM = 'team_sales';
const EU_TEAM = 'team_eu';
const team = (id: string, ownerId: string, displayName: string): FakeAgent => ({
  id,
  displayName,
  visibility: 'team',
  ownerType: 'team',
  ownerId,
});
const SUPPORT = team('agt_support', SUPPORT_TEAM, 'Support');
const RND = team('agt_rnd', SUPPORT_TEAM, '<b>R&D</b>');
const SUPPORT_EU = team('agt_support_eu', EU_TEAM, 'SUPPORT');
const SALES = team('agt_sales', SALES_TEAM, 'Sales');
const OTTOS: FakeAgent = {
  id: 'agt_otto',
  displayName: 'Support',
  visibility: 'personal',
  ownerType: 'user',
  ownerId: 'usr_otto',
};

const SUPPORT_CH = 'C07SUPPORT1';
const ARCHIVED_CH = 'C07ARCHIVE1';
const SHARED_CH = 'C07SHARED01';
const PENDING_CH = 'C07PENDING1';
const PRIVATE_CH = 'C07PRIVATE1';
const DM_CH = 'D07DMADA001';

function channel(id: string, name: string, over: Partial<SlackChannel> = {}): SlackChannel {
  return {
    id,
    name,
    isChannel: true,
    isPrivate: false,
    isArchived: false,
    isExtShared: false,
    isPendingExtShared: false,
    isMember: false,
    ...over,
  };
}

// ── A fake Slack Web API ────────────────────────────────────────────────────

interface Ephemeral {
  token: string;
  channel: string;
  user: string;
  text: string;
  threadTs?: string;
}

function fakeSlack() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const channels = new Map<string, SlackChannel>([
    [SUPPORT_CH, channel(SUPPORT_CH, 'support-desk')],
    [ARCHIVED_CH, channel(ARCHIVED_CH, 'old-news', { isArchived: true })],
    [SHARED_CH, channel(SHARED_CH, 'partner-room', { isExtShared: true })],
    [PENDING_CH, channel(PENDING_CH, 'soon-partners', { isPendingExtShared: true })],
    [PRIVATE_CH, channel(PRIVATE_CH, 'secret-plans', { isChannel: false, isPrivate: true })],
  ]);
  /** conversations.info refusals, by channel id. */
  const infoRefusals = new Map<string, string>([[DM_CH, 'missing_scope']]);
  const ephemerals: Ephemeral[] = [];
  const on = {
    usersInfo: async (id: string): Promise<unknown> => {
      const found = SLACK_USERS[id];
      if (found instanceof Error) throw found;
      if (found === undefined) throw new SlackApiError('users.info', 'user_not_found');
      return JSON.parse(JSON.stringify(found)) as unknown;
    },
    join: async (_id: string): Promise<void> => {},
    postEphemeral: async (_a: Ephemeral): Promise<void> => {},
  };
  const notHere = async (): Promise<never> => {
    throw new Error('the /ax route never makes this call');
  };
  const api: SlackApi = {
    usersInfo: async (token, id) => {
      calls.push({ method: 'users.info', args: [token, id] });
      return on.usersInfo(id);
    },
    conversationsInfo: async (token, id) => {
      calls.push({ method: 'conversations.info', args: [token, id] });
      const refusal = infoRefusals.get(id);
      if (refusal !== undefined) throw new SlackApiError('conversations.info', refusal);
      const found = channels.get(id);
      if (found === undefined) throw new SlackApiError('conversations.info', 'channel_not_found');
      return { ...found };
    },
    conversationsJoin: async (token, id) => {
      calls.push({ method: 'conversations.join', args: [token, id] });
      return on.join(id);
    },
    postEphemeral: async (token, a) => {
      calls.push({ method: 'chat.postEphemeral', args: [token, { ...a }] });
      const sent: Ephemeral = { token, ...a };
      ephemerals.push(sent);
      return on.postEphemeral(sent);
    },
    conversationsList: notHere,
    rotateConfigToken: notHere,
    createApp: notHere,
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    postMessage: notHere,
    startStream: notHere,
    appendStream: notHere,
    stopStream: notHere,
    addReaction: notHere,
    removeReaction: notHere,
  };
  return {
    api,
    calls,
    channels,
    infoRefusals,
    ephemerals,
    on,
    methods: (): string[] => calls.map((c) => c.method),
    /** The Slack user ids users.info was asked about, in order. */
    lookedUp: (): unknown[] => calls.filter((c) => c.method === 'users.info').map((c) => c.args[1]),
  };
}

// ── A fake request and response, shaped like @ax/http-server's ─────────────

interface Answered {
  status: number;
  how: 'json' | 'text' | 'end' | 'redirect' | null;
  body: unknown;
  headers: Record<string, string>;
}

function fakeResponse(): { res: RouteResponse; answer: Answered } {
  const answer: Answered = { status: 200, how: null, body: undefined, headers: {} };
  const finish = (how: NonNullable<Answered['how']>, body?: unknown): void => {
    // Like the real adapter: a response finishes once.
    if (answer.how !== null) throw new Error('response already finished');
    answer.how = how;
    answer.body = body;
  };
  const res: RouteResponse = {
    status(n) {
      answer.status = n;
      return res;
    },
    header(name, value) {
      answer.headers[name.toLowerCase()] = value;
      return res;
    },
    json: (v) => finish('json', v),
    text: (s) => finish('text', s),
    end: () => finish('end'),
    redirect: () => finish('redirect'),
  };
  return { res, answer };
}

/** A slash command's fields, as Slack posts them (docs.slack.dev, slash commands). */
function fields(
  o: {
    user?: string;
    userName?: string;
    text?: string;
    channel?: string;
    command?: string;
    teamId?: string;
    appId?: string;
  } = {},
): Record<string, string> {
  return {
    token: 'gIkuvaNzQIHg97ATvDxqgjtO',
    team_id: o.teamId ?? TEAM_ID,
    team_domain: 'canopyworks',
    channel_id: o.channel ?? SUPPORT_CH,
    channel_name: 'support-desk',
    user_id: o.user ?? ADA.slack,
    user_name: o.userName ?? 'ada.admin',
    command: o.command ?? SLASH_COMMAND,
    text: o.text ?? '',
    api_app_id: o.appId ?? APP_ID,
    is_enterprise_install: 'false',
    response_url: 'https://hooks.slack.com/commands/T07ABCDEF12/7712345678901/7RxQYH2mRuSampleOnly',
    trigger_id: '7712345678901.7512345678901.3a1d8c2f0e9b4c6a8d7e5f4b3c2a1908',
  };
}

const formBody = (f: Record<string, string>): Buffer => Buffer.from(new URLSearchParams(f).toString());

/** Slack's v0 signature, written out apart from the code under test. */
function signatureHeaders(body: Buffer, o: { ts?: number; secret?: string } = {}): Record<string, string> {
  const ts = String(o.ts ?? NOW_S);
  const digest = createHmac('sha256', o.secret ?? SIGNING_SECRET).update(`v0:${ts}:`).update(body).digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${digest}` };
}

function request(
  route: 'commands' | 'events',
  o: { body: Buffer; headers?: Record<string, string>; installId?: string; rawPath?: string },
): RouteRequest {
  const installId = o.installId ?? INSTALL_ID;
  const path = `/slack/${route}/${installId}`;
  return {
    method: 'POST',
    path,
    rawPath: o.rawPath ?? path,
    params: { installId },
    query: {},
    headers: {
      'content-type': route === 'commands' ? 'application/x-www-form-urlencoded' : 'application/json',
      ...o.headers,
    },
    body: o.body,
  };
}

interface SignOptions {
  ts?: number;
  secret?: string;
  installId?: string;
  rawPath?: string;
  headers?: Record<string, string>;
}

/** A signed request to the commands route with exactly these bytes. */
function signed(body: Buffer, o: SignOptions = {}, route: 'commands' | 'events' = 'commands'): RouteRequest {
  return request(route, {
    body,
    ...(o.installId !== undefined ? { installId: o.installId } : {}),
    ...(o.rawPath !== undefined ? { rawPath: o.rawPath } : {}),
    headers: { ...signatureHeaders(body, o), ...o.headers },
  });
}

/** A signed `/ax` invocation. */
const slash = (f: Parameters<typeof fields>[0] = {}, o: SignOptions = {}): RouteRequest =>
  signed(formBody(fields(f)), o);

/** What Slack shows only the invoker: the HTTP answer with this text. */
const said = (text: string): Answered => ({
  status: 200,
  how: 'json',
  body: { response_type: 'ephemeral', text },
  headers: {},
});
/** An empty 200: Slack shows nothing at all. */
const SILENT: Answered = { status: 200, how: 'end', body: undefined, headers: {} };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let queued work run until `check` holds. */
async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 5_000, interval: 1 });
}

// ── The handler's surroundings ──────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(
  o: {
    teams?: boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    seen?: ReturnType<typeof createSeenEvents>;
  } = {},
) {
  const now = o.now ?? (() => NOW_MS);
  const bus = new HookBus();
  const people = fakeAgents(bus);
  for (const agent of [SUPPORT, RND, SUPPORT_EU, SALES, OTTOS]) people.addAgent(agent);
  people.setRole(SUPPORT_TEAM, 'usr_ada', 'admin');
  people.setRole(SUPPORT_TEAM, 'usr_grace', 'admin');
  people.setRole(SUPPORT_TEAM, 'usr_mel', 'member');

  // auth:find-user-by-email: the AX account for a verified email, or null.
  const accounts = new Map(PEOPLE.flatMap((p) => (p.ax === null ? [] : [[p.email, p.ax] as const])));
  const authCalls: Array<Record<string, unknown>> = [];
  const faults = { findUser: undefined as unknown };
  bus.registerService('auth:find-user-by-email', '@ax/auth-better', async (_ctx, raw) => {
    authCalls.push({ ...(raw as Record<string, unknown>) });
    if (faults.findUser !== undefined) throw faults.findUser;
    const userId = accounts.get((raw as { email: string }).email);
    return userId === undefined ? null : { userId };
  });
  const teamCalls: Array<Record<string, unknown>> = [];
  if (o.teams !== false) {
    bus.registerService('teams:list-for-user', '@ax/teams', async (_ctx, raw) => {
      teamCalls.push({ ...(raw as Record<string, unknown>) });
      const { userId } = raw as { userId: string };
      return {
        teams: people.teamsOf(userId).map((id) => ({ id, displayName: id, createdBy: 'usr_founder', createdAt: STAMP })),
      };
    });
  }

  const lines: Line[] = [];
  const at = (level: string) => (msg: string, f?: Record<string, unknown>) => {
    lines.push({ level, msg, fields: f });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const installs = new Map([ACTIVE, PENDING, NO_SECRET, OLDER].map((i) => [i.installId, i]));
  const state = {
    botToken: BOT_TOKEN as string | null,
    vaultFault: undefined as unknown,
    storeFault: undefined as unknown,
    /** What `installs.current()` answers: the oldest row. */
    current: ACTIVE,
  };
  const secretReads: SecretName[] = [];
  const store = {
    async get(installId: string): Promise<InstallRow | null> {
      if (state.storeFault !== undefined) throw state.storeFault;
      const found = installs.get(installId);
      return found === undefined ? null : { ...found };
    },
  };
  const secrets = {
    async get(install: { installId: string }, name: SecretName): Promise<string | null> {
      secretReads.push(name);
      if (name === 'signing-secret') {
        return install.installId === NO_SECRET_ID ? null : SIGNING_SECRET;
      }
      if (state.vaultFault !== undefined) throw state.vaultFault;
      if (name !== 'bot-token') return null;
      return install.installId === OLDER_ID ? OLDER_BOT_TOKEN : state.botToken;
    },
  };

  const memory = memoryChannelStore();
  const slack = fakeSlack();
  const lifetime = createLifetime();
  const handler = createCommandsHandler({
    bus,
    installs: { current: async () => ({ ...state.current }) },
    channels: memory.store,
    secrets,
    api: slack.api,
    logger,
    store,
    lifetime,
    publicOrigin: ORIGIN,
    now,
    // By default the deadline never comes: every answer is the HTTP one.
    sleep: o.sleep ?? (() => new Promise<void>(() => {})),
  });
  /** The events route over the same installs and secrets, to compare answers with. */
  const events = createEventsHandler({
    store,
    secrets,
    lifetime: createLifetime(),
    seen: o.seen ?? createSeenEvents({ ttlMs: EVENT_DEDUPE_TTL_MS, max: EVENT_DEDUPE_MAX }),
    dispatch: async () => {},
    logger,
    now,
  });

  async function send(req: RouteRequest, via = handler): Promise<Answered> {
    const { res, answer } = fakeResponse();
    await via(req, res);
    if (answer.how === null) throw new Error('the route never answered');
    return answer;
  }

  /** Every call AX was asked, of any plugin: auth, agents and teams. */
  const axCalls = (): unknown[] => [...authCalls, ...people.calls, ...teamCalls];

  return {
    bus,
    people,
    accounts,
    authCalls,
    teamCalls,
    faults,
    lines,
    state,
    installs,
    secretReads,
    memory,
    slack,
    lifetime,
    send,
    sendToEvents: (req: RouteRequest) => send(req, events),
    axCalls,
  };
}

const msgs = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg).map((l) => l.fields);

// ── The route ───────────────────────────────────────────────────────────────

describe('the /ax route: what it checks before reading the form', () => {
  it('the commands URL the manifest gives Slack reaches this handler', async () => {
    expect(COMMANDS_ROUTE_PATH).toBe('/slack/commands/:installId');
    const { pathname } = new URL(slackUrls('https://ax.example/', INSTALL_ID).commandsUrl);
    const w = world();
    expect(await w.send(slash({ text: 'help' }, { rawPath: pathname }))).toStrictEqual(said(COPY.slashUsage));
  });

  it('a bad, missing or foreign signature, or a stale or future timestamp → 401 and nothing is asked', async () => {
    const w = world();
    const body = formBody(fields({ text: 'connect Support' }));
    const tampered = formBody(fields({ text: 'connect Support', user: OTTO.slack }));
    const cases: RouteRequest[] = [
      request('commands', { body: tampered, headers: signatureHeaders(body) }),
      request('commands', { body }),
      signed(body, { secret: 'test-signing-secret-not-real-02' }),
      signed(body, { ts: NOW_S - 301 }),
      signed(body, { ts: NOW_S + 301 }),
    ];
    for (const req of cases) {
      expect(await w.send(req)).toStrictEqual({ status: 401, how: 'end', body: undefined, headers: {} });
    }
    expect(w.slack.calls).toEqual([]);
    expect(w.axCalls()).toEqual([]);
    expect(w.lines).toEqual(
      cases.map(() => ({ level: 'warn', msg: 'slack_command_refused', fields: { installId: INSTALL_ID, reason: 'signature' } })),
    );
  });

  it('an unknown, malformed or respelled installId, or one with no signing secret, gets the same 404 as the events route', async () => {
    const w = world();
    const body = formBody(fields());
    const firstHex = INSTALL_ID.charCodeAt(0).toString(16);
    const cases: Array<[string, (route: 'commands' | 'events') => RouteRequest]> = [
      ['unknown install', (r) => signed(body, { installId: UNKNOWN_ID }, r)],
      ['21 characters', (r) => signed(body, { installId: INSTALL_ID.slice(1) }, r)],
      ['a padding character', (r) => signed(body, { installId: `${INSTALL_ID.slice(0, 21)}=` }, r)],
      ['rawPath with %2F', (r) => signed(body, { rawPath: `/slack/${r}/${INSTALL_ID.slice(0, 10)}%2F${INSTALL_ID.slice(11)}` }, r)],
      ['a percent-encoded spelling', (r) => signed(body, { rawPath: `/slack/${r}/%${firstHex}${INSTALL_ID.slice(1)}` }, r)],
      ['a trailing slash', (r) => signed(body, { rawPath: `/slack/${r}/${INSTALL_ID}/` }, r)],
      ['the other route’s path', (r) => signed(body, { rawPath: `/slack/${r === 'commands' ? 'events' : 'commands'}/${INSTALL_ID}` }, r)],
      ['no signing secret', (r) => signed(body, { installId: NO_SECRET_ID }, r)],
    ];
    for (const [name, req] of cases) {
      const answer = await w.send(req('commands'));
      expect(answer, name).toStrictEqual({ status: 404, how: 'json', body: { error: 'not-found' }, headers: {} });
      expect(await w.sendToEvents(req('events')), name).toStrictEqual(answer);
    }
    expect(w.slack.calls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it('a body over 16 KiB → 413 before any lookup', async () => {
    const w = world();
    const huge = Buffer.alloc(17 * 1024, 0x61);
    expect(COMMANDS_MAX_BODY_BYTES).toBe(16_384);
    expect(await w.send(signed(huge))).toStrictEqual({ status: 413, how: 'json', body: { error: 'body-too-large' }, headers: {} });
    expect(w.secretReads).toEqual([]);
    // Right at the cap is read (and is no command we know).
    const full = Buffer.from(new URLSearchParams(fields({ text: 'help' })).toString().padEnd(COMMANDS_MAX_BODY_BYTES, '&'));
    expect(full.length).toBe(COMMANDS_MAX_BODY_BYTES);
    expect(await w.send(signed(full))).toStrictEqual(said(COPY.slashUsage));
  });

  it('a failed install or secret lookup → 503 and a code-only line; after stopAdmission → 503 before any lookup', async () => {
    const w = world();
    w.state.storeFault = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    expect(await w.send(slash())).toMatchObject({ status: 503, how: 'end' });
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_command_failed', fields: { installId: INSTALL_ID, stage: 'install', code: 'ECONNREFUSED' } },
    ]);

    const w2 = world();
    w2.lifetime.stopAdmission();
    expect(await w2.send(slash({ text: 'connect Support' }))).toStrictEqual({ status: 503, how: 'end', body: undefined, headers: {} });
    expect(w2.secretReads).toEqual([]);
    expect(w2.slack.calls).toEqual([]);
  });
});

describe('ingress.ts, which the events route shares', () => {
  it('reads the clock once a request: the events route stamps its replay record with the instant it checked the signature at', async () => {
    // A clock that moves on at every reading, as it does across a store read and a vault read.
    const readings: number[] = [];
    const now = (): number => {
      const at = NOW_MS + readings.length * 60_000;
      readings.push(at);
      return at;
    };
    const stamped: number[] = [];
    const w = world({
      now,
      seen: {
        firstSighting: (_eventId, nowMs) => {
          stamped.push(nowMs);
          return true;
        },
      },
    });
    const mention = Buffer.from(
      JSON.stringify({
        type: 'event_callback',
        team_id: TEAM_ID,
        api_app_id: APP_ID,
        event_id: 'Ev07ONECLOCK',
        event: { type: 'app_mention', user: ADA.slack, channel: SUPPORT_CH, ts: '1763035200.000100', text: 'hello' },
      }),
    );
    expect(await w.sendToEvents(signed(mention, {}, 'events'))).toStrictEqual(SILENT);
    expect(stamped).toEqual([NOW_MS]);
    expect(readings).toEqual([NOW_MS]);
  });
});

describe('the form', () => {
  it('ssl_check → an empty 200, and nothing is asked', async () => {
    const w = world();
    const body = formBody({ ssl_check: '1', token: 'gIkuvaNzQIHg97ATvDxqgjtO' });
    expect(await w.send(signed(body))).toStrictEqual(SILENT);
    expect(w.slack.calls).toEqual([]);
    expect(w.axCalls()).toEqual([]);
  });

  it('a signed form we cannot read → 400, nothing asked', async () => {
    const w = world();
    const without = (key: string): Buffer => {
      const f = fields({ text: 'connect Support' });
      delete f[key];
      return formBody(f);
    };
    // Valid on every other rule: the only text field is the one with the bad byte.
    const invalidUtf8 = Buffer.concat([without('text'), Buffer.from('&text=connect%20'), Buffer.from([0xff])]);
    const bodies: Array<[string, Buffer, Record<string, string>?]> = [
      ['JSON, not a form', Buffer.from(JSON.stringify(fields())), { 'content-type': 'application/json' }],
      ['no content type', formBody(fields()), { 'content-type': '' }],
      ['no user_id', without('user_id')],
      ['no channel_id', without('channel_id')],
      ['no team_id', without('team_id')],
      ['no api_app_id', without('api_app_id')],
      ['no command', without('command')],
      ['a user_id with a space', formBody(fields({ user: 'U07 ADA' }))],
      ['a channel_id over the id cap', formBody(fields({ channel: `C${'7'.repeat(64)}` }))],
      ['text past SLASH_TEXT_MAX', formBody(fields({ text: 'x'.repeat(SLASH_TEXT_MAX + 1) }))],
      ['a user_id sent twice', Buffer.concat([formBody(fields({ user: MEL.slack })), Buffer.from(`&user_id=${ADA.slack}`)])],
      ['invalid UTF-8', invalidUtf8],
    ];
    for (const [name, body, headers] of bodies) {
      expect(await w.send(signed(body, headers === undefined ? {} : { headers })), name).toStrictEqual({
        status: 400,
        how: 'end',
        body: undefined,
        headers: {},
      });
    }
    expect(w.slack.calls).toEqual([]);
    expect(w.axCalls()).toEqual([]);
    expect(msgs(w.lines, 'slack_command_refused')).toEqual(bodies.map(() => ({ installId: INSTALL_ID, reason: 'malformed' })));

    // Text right at the cap is read; a charset parameter on the type is fine.
    expect(
      await w.send(
        signed(formBody(fields({ text: 'x'.repeat(SLASH_TEXT_MAX) })), {
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
        }),
      ),
    ).toStrictEqual(said(COPY.slashUsage));
  });

  it('another app, another workspace, a pending install or another command → an empty 200, ignored', async () => {
    const w = world();
    const cases: Array<[RouteRequest, string, string]> = [
      [slash({ appId: 'A07OTHERAPP', text: 'connect Support' }), INSTALL_ID, 'app'],
      [slash({ teamId: 'T07OTHERTM9', text: 'connect Support' }), INSTALL_ID, 'team'],
      [slash({ text: 'connect Support' }, { installId: PENDING_ID }), PENDING_ID, 'status'],
      [slash({ command: '/other', text: 'connect Support' }), INSTALL_ID, 'command'],
    ];
    for (const [req, installId, reason] of cases) {
      expect(await w.send(req), reason).toStrictEqual(SILENT);
      expect(w.lines.at(-1), reason).toEqual({ level: 'info', msg: 'slack_command_ignored', fields: { installId, reason } });
    }
    expect(w.slack.calls).toEqual([]);
    expect(w.axCalls()).toEqual([]);
  });
});

// ── Who is asking ───────────────────────────────────────────────────────────

describe('the invoker', () => {
  it('a refused invoker (guest, bot, other workspace, deactivated) gets an empty 200, and AX is asked nothing', async () => {
    const w = world();
    for (const [user, reason] of [
      [GUEST, 'guest'],
      [BOT, 'bot'],
      [STRANGER, 'other-workspace'],
      [DEACTIVATED, 'deactivated'],
    ] as const) {
      for (const text of ['connect Support', 'disconnect', 'help']) {
        expect(await w.send(slash({ user, text })), `${reason} ${text}`).toStrictEqual(SILENT);
      }
      expect(msgs(w.lines, 'slack_sender_refused').at(-1)).toEqual({ installId: INSTALL_ID, reason });
    }
    expect(w.axCalls()).toEqual([]);
    expect(new Set(w.slack.methods())).toEqual(new Set(['users.info']));
    expect(w.memory.calls).toEqual([]);
  });

  it('users.info failing because Slack was briefly unavailable → slashFailed; any other failure → silence', async () => {
    const w = world();
    expect(await w.send(slash({ user: FLAKY, text: 'connect Support' }))).toStrictEqual(said(COPY.slashFailed));
    expect(await w.send(slash({ user: REVOKED, text: 'connect Support' }))).toStrictEqual(SILENT);
    expect(await w.send(slash({ user: 'U07NOBODY01', text: 'connect Support' }))).toStrictEqual(SILENT);
    expect(w.axCalls()).toEqual([]);
    expect(msgs(w.lines, 'slack_sender_refused')).toEqual([
      { installId: INSTALL_ID, reason: 'lookup-failed', code: 'ratelimited' },
      { installId: INSTALL_ID, reason: 'lookup-failed', code: 'token_revoked' },
      { installId: INSTALL_ID, reason: 'lookup-failed', code: 'user_not_found' },
    ]);
  });

  it('is the signed user_id: user_name and the text never change who is asking', async () => {
    const w = world();
    // Mel, a plain member, claiming Ada's name: still Mel, so still not a manager.
    expect(await w.send(slash({ user: MEL.slack, userName: 'ada.admin', text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashNotManager),
    );
    // Mel naming Ada in the text, by mention and by email: that is only a name to match.
    expect(await w.send(slash({ user: MEL.slack, text: `connect <@${ADA.slack}>` }))).toStrictEqual(
      said(COPY.slashNoSuchAgent),
    );
    expect(await w.send(slash({ user: MEL.slack, text: `connect ${ADA.email}` }))).toStrictEqual(
      said(COPY.slashNoSuchAgent),
    );
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toBeUndefined();
    expect(w.slack.lookedUp()).toEqual([MEL.slack, MEL.slack, MEL.slack]);
    expect(w.authCalls).toEqual([{ email: MEL.email }, { email: MEL.email }, { email: MEL.email }]);
    expect(w.people.calls.every((c) => JSON.stringify(c.input).includes('usr_mel'))).toBe(true);

    // Ada, claiming Mel's name: Ada connects, as Ada.
    expect(await w.send(slash({ user: ADA.slack, userName: 'mel.member', text: `connect Support <@${MEL.slack}>` }))).toStrictEqual(
      said(COPY.slashNoSuchAgent),
    );
    expect(await w.send(slash({ user: ADA.slack, userName: 'mel.member', text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashConnected('Support', 'support-desk')),
    );
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id, connectedByUserId: 'usr_ada' });
  });

  it('a member with no AX account → slashNotMapped, linking the web app', async () => {
    const w = world();
    expect(await w.send(slash({ user: CAROL.slack, text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashNotMapped(ORIGIN)),
    );
    expect(await w.send(slash({ user: CAROL.slack, text: 'disconnect' }))).toStrictEqual(said(COPY.slashNotMapped(ORIGIN)));
    expect(w.people.calls).toEqual([]);
    expect(msgs(w.lines, 'slack_sender_not_mapped')).toEqual([{ installId: INSTALL_ID }, { installId: INSTALL_ID }]);
  });

  it('no bot token → slashNeedsReconnect (the request is signed by this install) and a line for the operator; a vault fault → slashFailed', async () => {
    const w = world();
    w.state.botToken = null;
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashNeedsReconnect));
    expect(msgs(w.lines, 'slack_bot_token_missing')).toEqual([{ installId: INSTALL_ID }]);

    const w2 = world();
    w2.state.vaultFault = new PluginError({ code: 'timeout', plugin: '@ax/credentials', message: 'vault slow' });
    expect(await w2.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashFailed));
    expect(msgs(w2.lines, 'slack_command_failed')).toEqual([{ installId: INSTALL_ID, stage: 'bot-token', code: 'timeout' }]);
    expect(w.slack.calls).toEqual([]);
    expect(w2.slack.calls).toEqual([]);
  });
});

// ── /ax connect ─────────────────────────────────────────────────────────────

describe('/ax connect', () => {
  it('usage for anything that is not connect with a name, or disconnect on its own', async () => {
    const w = world();
    for (const text of ['', '   ', 'help', 'frobnicate', 'connect', 'connect   ', 'disconnect now', 'connected Support']) {
      expect(await w.send(slash({ text })), JSON.stringify(text)).toStrictEqual(said(COPY.slashUsage));
    }
    expect(w.axCalls()).toEqual([]);
    expect(w.slack.methods().every((m) => m === 'users.info')).toBe(true);
  });

  it('a team admin connects the agent by name, as themselves, in the channel the command came from', async () => {
    const w = world();
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashConnected('Support', 'support-desk')),
    );
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({
      installId: INSTALL_ID,
      channelId: SUPPORT_CH,
      agentId: SUPPORT.id,
      connectedByUserId: 'usr_ada',
      channelName: 'support-desk',
      remember: true,
    });
    expect(w.slack.calls).toEqual([
      { method: 'users.info', args: [BOT_TOKEN, ADA.slack] },
      { method: 'conversations.info', args: [BOT_TOKEN, SUPPORT_CH] },
      { method: 'conversations.join', args: [BOT_TOKEN, SUPPORT_CH] },
    ]);
    expect(w.teamCalls).toEqual([{ userId: 'usr_ada' }]);
    expect(w.people.inputs('agents:list-for-user')).toEqual([{ userId: 'usr_ada', teamIds: [SUPPORT_TEAM] }]);
    // Workspace-admin status never connects a channel: always asked as a non-admin.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: 'usr_ada', isAdmin: false } },
    ]);
  });

  it('connects in the install the command was signed for, with its bot token, even when an older install row exists', async () => {
    // installs.current() answers with the OLDEST row: here, another install.
    const w = world();
    w.state.current = OLDER;
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashConnected('Support', 'support-desk')),
    );
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ installId: INSTALL_ID, agentId: SUPPORT.id });
    expect(w.memory.row(OLDER_ID, SUPPORT_CH)).toBeUndefined();
    expect(w.slack.calls).toEqual([
      { method: 'users.info', args: [BOT_TOKEN, ADA.slack] },
      { method: 'conversations.info', args: [BOT_TOKEN, SUPPORT_CH] },
      { method: 'conversations.join', args: [BOT_TOKEN, SUPPORT_CH] },
    ]);
    expect(msgs(w.lines, 'slack_channel_connected')).toEqual([{ installId: INSTALL_ID, reconnected: false }]);
  });

  it('an install removed while the command runs → slashNeedsReconnect, and nothing is joined or bound', async () => {
    const w = world();
    // Admin › Slack › Disconnect lands after the signature was checked.
    const lookUp = w.slack.on.usersInfo;
    w.slack.on.usersInfo = async (id) => {
      w.installs.delete(INSTALL_ID);
      return lookUp(id);
    };
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashNeedsReconnect));
    expect(w.slack.methods()).toEqual(['users.info']);
    expect(w.memory.rows.size).toBe(0);
  });

  it('a name matches however it is typed: case, spacing, straight quotes, Slack’s escaping', async () => {
    const w = world();
    expect(await w.send(slash({ text: 'CONNECT   "support"  ' }))).toStrictEqual(
      said(COPY.slashConnected('Support', 'support-desk')),
    );
    w.memory.rows.clear();
    const curly = `connect ${String.fromCharCode(0x201c)}Support${String.fromCharCode(0x201d)}`;
    expect(await w.send(slash({ text: curly }))).toStrictEqual(said(COPY.slashConnected('Support', 'support-desk')));
    // Slack sends `<`, `>` and `&` escaped; the reply escapes them again.
    w.memory.rows.clear();
    const reply = await w.send(slash({ text: 'connect &lt;b&gt;R&amp;D&lt;/b&gt;' }));
    expect(reply).toStrictEqual(said(COPY.slashConnected('<b>R&D</b>', 'support-desk')));
    const text = (reply.body as { text: string }).text;
    expect(text).toContain('&lt;b&gt;R&amp;D&lt;/b&gt;');
    expect(text).not.toMatch(/<b>|<!|<@|<#/);
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: RND.id });
  });

  it('normalizeName: NFC, trimmed, single spaces, lowercase, surrounding straight quotes dropped', () => {
    expect(normalizeName('  Support\t  Desk ')).toBe('support desk');
    expect(normalizeName('"Support"')).toBe('support');
    expect(normalizeName("' Support '")).toBe('support');
    expect(normalizeName('"Support')).toBe('"support');
    expect(normalizeName('Pat’s agent')).toBe('pat’s agent');
    // Slack's smart punctuation curls the quotes someone types around a name.
    const [ldq, rdq, lsq, rsq] = [0x201c, 0x201d, 0x2018, 0x2019].map((c) => String.fromCharCode(c));
    expect(normalizeName(`${ldq}Support Desk${rdq}`)).toBe('support desk');
    expect(normalizeName(`${lsq} Support ${rsq}`)).toBe('support');
    // Only a pair is dropped, and only one: an apostrophe inside stays.
    expect(normalizeName(`${ldq}Support`)).toBe(`${ldq}support`);
    expect(normalizeName(`${lsq}Pat${rsq}s agent${rsq}`)).toBe(`pat${rsq}s agent`);
    // An e and a combining acute accent are the same name as the precomposed letter.
    expect(normalizeName(`Caf${String.fromCharCode(0x65, 0x301)}`)).toBe(normalizeName(`Caf${String.fromCharCode(0xe9)}`));
  });

  it(`a name longer than ${AGENT_NAME_ARG_MAX} characters matches nothing`, async () => {
    const w = world();
    const longest = 'n'.repeat(AGENT_NAME_ARG_MAX);
    w.people.addAgent(team('agt_long', SUPPORT_TEAM, longest));
    w.people.addAgent(team('agt_longer', SUPPORT_TEAM, `${longest}x`));
    expect(await w.send(slash({ text: `connect ${longest}x` }))).toStrictEqual(said(COPY.slashNoSuchAgent));
    expect(w.people.inputs('agents:resolve')).toEqual([]);
    expect(await w.send(slash({ text: `connect ${longest}` }))).toStrictEqual(
      said(COPY.slashConnected(longest, 'support-desk')),
    );
  });

  it('a personal agent with that name is never a candidate', async () => {
    const w = world();
    expect(await w.send(slash({ user: OTTO.slack, text: 'connect Support' }))).toStrictEqual(said(COPY.slashNoSuchAgent));
    expect(w.people.inputs('agents:list-for-user')).toEqual([{ userId: 'usr_otto', teamIds: [] }]);
    expect(w.people.inputs('agents:resolve')).toEqual([]);
    expect(w.slack.methods()).toEqual(['users.info']);
  });

  it('an agent the invoker can see but not manage → slashNotManager, and Slack is asked nothing more', async () => {
    const w = world();
    expect(await w.send(slash({ user: MEL.slack, text: 'connect Support' }))).toStrictEqual(said(COPY.slashNotManager));
    expect(w.slack.methods()).toEqual(['users.info']);
    expect(w.memory.calls).toEqual([]);
    expect(msgs(w.lines, 'slack_command_declined')).toEqual([{ installId: INSTALL_ID, reason: 'not-manager' }]);
  });

  it('a team agent outside the invoker’s teams is no candidate', async () => {
    const w = world();
    expect(await w.send(slash({ text: 'connect Sales' }))).toStrictEqual(said(COPY.slashNoSuchAgent));
    expect(w.people.inputs('agents:resolve')).toEqual([]);
    expect(msgs(w.lines, 'slack_command_declined')).toEqual([{ installId: INSTALL_ID, reason: 'no-such-agent' }]);
  });

  it('two agents the invoker manages with that name → slashAmbiguous, nothing connected', async () => {
    const w = world();
    w.people.setRole(EU_TEAM, 'usr_ada', 'admin');
    expect(await w.send(slash({ text: 'connect support' }))).toStrictEqual(said(COPY.slashAmbiguous));
    expect(w.memory.calls).toEqual([]);
    expect(w.slack.methods()).toEqual(['users.info']);
    // A same-named agent the invoker only sees doesn't make it ambiguous.
    w.people.setRole(EU_TEAM, 'usr_ada', 'member');
    expect(await w.send(slash({ text: 'connect support' }))).toStrictEqual(
      said(COPY.slashConnected('Support', 'support-desk')),
    );
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id });
  });

  it('without @ax/teams no team agent is listed, so nothing matches', async () => {
    const w = world({ teams: false });
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashNoSuchAgent));
    expect(w.people.inputs('agents:list-for-user')).toEqual([{ userId: 'usr_ada', teamIds: [] }]);
  });

  it('connecting again → slashReconnected, and the channel now runs as whoever connected it last', async () => {
    const w = world();
    await w.send(slash({ text: 'connect Support' }));
    expect(await w.send(slash({ user: GRACE.slack, text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashReconnected('Support')),
    );
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id, connectedByUserId: 'usr_grace' });
  });

  it('a channel another agent has → slashChannelTaken, binding unchanged', async () => {
    const w = world();
    await w.memory.store.upsert({
      installId: INSTALL_ID,
      channelId: SUPPORT_CH,
      agentId: SALES.id,
      connectedByUserId: 'usr_sam',
      channelName: 'support-desk',
    });
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashChannelTaken));
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SALES.id, connectedByUserId: 'usr_sam' });
    // Refused before the bot joins: no bot left behind in a channel it can't serve.
    expect(w.slack.methods()).not.toContain('conversations.join');
  });

  it('an agent deleted while the channel is bound → slashNoSuchAgent, and the binding is taken back', async () => {
    const w = world();
    const write = w.memory.store.upsert;
    w.memory.store.upsert = async (row) => {
      const out = await write(row);
      w.people.agents.delete(SUPPORT.id);
      return out;
    };
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashNoSuchAgent));
    expect(w.memory.rows.size).toBe(0);
  });

  it('a workspace policy that keeps the bot out (restricted_action) → its own line, not "try again"', async () => {
    const w = world();
    w.slack.on.join = async () => {
      throw new SlackApiError('conversations.join', 'restricted_action');
    };
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashChannelNotAllowed('workspace-policy')),
    );
    expect(w.memory.rows.size).toBe(0);
  });

  it('a bot token Slack no longer takes → slashNeedsReconnect, never "a private channel"', async () => {
    for (const code of ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive']) {
      const w = world();
      w.slack.infoRefusals.set(SUPPORT_CH, code);
      expect(await w.send(slash({ text: 'connect Support' })), code).toStrictEqual(said(COPY.slashNeedsReconnect));
      expect(w.memory.rows.size).toBe(0);
    }
  });

  it('a private, archived or Slack Connect channel → slashChannelNotAllowed with the reason, never joined', async () => {
    const w = world();
    for (const [channel, reason] of [
      [PRIVATE_CH, 'not-public'],
      [ARCHIVED_CH, 'archived'],
      [SHARED_CH, 'shared'],
      [PENDING_CH, 'shared'],
      ['C07NOWHERE1', 'not-public'],
    ] as const) {
      expect(await w.send(slash({ channel, text: 'connect Support' })), channel).toStrictEqual(
        said(COPY.slashChannelNotAllowed(reason)),
      );
    }
    expect(w.slack.methods()).not.toContain('conversations.join');
    expect(w.memory.rows.size).toBe(0);
  });

  it('missing_scope from conversations.info here means a DM or private channel: not public, never "reconnect"', async () => {
    const w = world();
    const reply = await w.send(slash({ channel: DM_CH, text: 'connect Support' }));
    expect(reply).toStrictEqual(said(COPY.slashChannelNotAllowed('not-public')));
    expect(reply).not.toStrictEqual(said(COPY.slashNeedsReconnect));
    expect(w.slack.methods()).toEqual(['users.info', 'conversations.info']);
  });

  it('Slack refusing anything else, or a fault in AX → slashFailed, logged by code alone', async () => {
    const w = world();
    w.slack.infoRefusals.set(SUPPORT_CH, 'fatal_error');
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashFailed));

    const w2 = world();
    w2.faults.findUser = new PluginError({ code: 'timeout', plugin: '@ax/auth-better', message: `slow for ${ADA.email}` });
    expect(await w2.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashFailed));
    expect(msgs(w2.lines, 'slack_command_failed')).toEqual([{ installId: INSTALL_ID, stage: 'find-user', code: 'timeout' }]);

    const w3 = world();
    w3.people.faults.set('agents:list-for-user', new PluginError({ code: 'internal', plugin: '@ax/agents', message: 'db down' }));
    expect(await w3.send(slash({ text: 'connect Support' }))).toStrictEqual(said(COPY.slashFailed));
    expect(msgs(w3.lines, 'slack_command_failed')).toEqual([{ installId: INSTALL_ID, stage: 'connect', code: 'internal' }]);
  });
});

// ── /ax disconnect ──────────────────────────────────────────────────────────

describe('/ax disconnect', () => {
  async function connected(w: ReturnType<typeof world>, agentId = SUPPORT.id): Promise<void> {
    await w.memory.store.upsert({
      installId: INSTALL_ID,
      channelId: SUPPORT_CH,
      agentId,
      connectedByUserId: 'usr_ada',
      channelName: 'support-desk',
    });
  }

  it('nothing connected here → slashNothingConnected', async () => {
    const w = world();
    expect(await w.send(slash({ text: 'disconnect' }))).toStrictEqual(said(COPY.slashNothingConnected));
    expect(w.people.calls).toEqual([]);
  });

  it('a team admin of the agent’s team disconnects it', async () => {
    const w = world();
    await connected(w);
    expect(await w.send(slash({ user: GRACE.slack, text: 'DISCONNECT' }))).toStrictEqual(said(COPY.slashDisconnected));
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toBeUndefined();
    expect(msgs(w.lines, 'slack_channel_disconnected')).toEqual([{ installId: INSTALL_ID }]);
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: 'usr_grace', isAdmin: false } },
    ]);
    expect(w.slack.methods()).toEqual(['users.info']);
  });

  it('a team member who is not an admin → slashNotManager, binding untouched', async () => {
    const w = world();
    await connected(w);
    expect(await w.send(slash({ user: MEL.slack, text: 'disconnect' }))).toStrictEqual(said(COPY.slashNotManager));
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id });
  });

  it('an AX user outside the agent’s team → slashNotManager, binding untouched', async () => {
    const w = world();
    await connected(w);
    expect(await w.send(slash({ user: OTTO.slack, text: 'disconnect' }))).toStrictEqual(said(COPY.slashNotManager));
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
  });

  it('a binding whose agent is gone (agents:resolve: not-found) is cleared by any mapped member → slashDisconnected', async () => {
    const w = world();
    // A connect in flight when its agent was deleted can leave this behind.
    await connected(w, 'agt_deleted');
    expect(await w.send(slash({ user: OTTO.slack, text: 'disconnect' }))).toStrictEqual(said(COPY.slashDisconnected));
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toBeUndefined();
    expect(w.people.inputs('agents:resolve')).toEqual([{ agentId: 'agt_deleted', userId: 'usr_otto' }]);
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
    expect(msgs(w.lines, 'slack_channel_disconnected')).toEqual([{ installId: INSTALL_ID, reason: 'agent-gone' }]);
  });

  it('an answer that does not call the bound agent a team agent never clears the binding → slashNotManager', async () => {
    // Never true of a real binding (only a team agent is connected, and an
    // agent's visibility is fixed when it is made): bound here to Otto's
    // personal agent, which agents:resolve hands Otto as personal.
    const w = world();
    await connected(w, OTTOS.id);
    expect(await w.send(slash({ user: OTTO.slack, text: 'disconnect' }))).toStrictEqual(said(COPY.slashNotManager));
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: OTTOS.id });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
  });
});

// ── When the answer takes a while ───────────────────────────────────────────

describe('reply timing', () => {
  it('a result ready inside the deadline is the HTTP answer, and nothing is posted', async () => {
    const sleeps: number[] = [];
    const w = world({
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise<void>(() => {});
      },
    });
    expect(await w.send(slash({ text: 'connect Support' }))).toStrictEqual(
      said(COPY.slashConnected('Support', 'support-desk')),
    );
    expect(sleeps).toEqual([SLASH_REPLY_DEADLINE_MS]);
    expect(w.slack.ephemerals).toEqual([]);
  });

  it('slow Slack: past the deadline the answer is slashWorking, then the result once, privately', async () => {
    const deadline = deferred();
    const w = world({ sleep: () => deadline.promise });
    const join = deferred();
    w.slack.on.join = () => join.promise;
    const answering = w.send(slash({ text: 'connect Support' }));
    await until(() => w.slack.methods().includes('conversations.join'));
    deadline.resolve();
    expect(await answering).toStrictEqual(said(COPY.slashWorking));
    expect(w.slack.ephemerals).toEqual([]);

    join.resolve();
    await w.lifetime.drain();
    expect(w.slack.ephemerals).toEqual([
      { token: BOT_TOKEN, channel: SUPPORT_CH, user: ADA.slack, text: COPY.slashConnected('Support', 'support-desk') },
    ]);
    expect(w.memory.row(INSTALL_ID, SUPPORT_CH)).toMatchObject({ agentId: SUPPORT.id });
  });

  it('a slow users.info: an empty 200 at the deadline; the result follows only for someone admitted', async () => {
    for (const [user, expected] of [
      [GUEST, []],
      [ADA.slack, [COPY.slashConnected('Support', 'support-desk')]],
    ] as const) {
      const deadline = deferred();
      const w = world({ sleep: () => deadline.promise });
      const lookup = deferred();
      const real = w.slack.on.usersInfo;
      w.slack.on.usersInfo = async (id) => {
        await lookup.promise;
        return real(id);
      };
      const answering = w.send(slash({ user, text: 'connect Support' }));
      await until(() => w.slack.methods().includes('users.info'));
      deadline.resolve();
      // Not yet admitted, so not even "working on it".
      expect(await answering, user).toStrictEqual(SILENT);
      lookup.resolve();
      await w.lifetime.drain();
      expect(w.slack.ephemerals.map((e) => e.text), user).toEqual(expected);
    }
  });

  it('a late post that fails is logged by code alone', async () => {
    const deadline = deferred();
    const w = world({ sleep: () => deadline.promise });
    const join = deferred();
    w.slack.on.join = () => join.promise;
    w.slack.on.postEphemeral = async () => {
      throw new SlackApiError('chat.postEphemeral', 'not_in_channel');
    };
    const answering = w.send(slash({ text: 'connect Support' }));
    await until(() => w.slack.methods().includes('conversations.join'));
    deadline.resolve();
    expect(await answering).toStrictEqual(said(COPY.slashWorking));
    join.resolve();
    await w.lifetime.drain();
    expect(w.slack.ephemerals).toHaveLength(1);
    expect(msgs(w.lines, 'slack_reply_failed')).toEqual([{ installId: INSTALL_ID, stage: 'ephemeral', code: 'not_in_channel' }]);
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('carry codes only: never a Slack id, an email, a name, the text or a token', async () => {
    const w = world();
    const sent: RouteRequest[] = [
      slash({ text: 'connect Support' }),
      slash({ user: GRACE.slack, text: 'connect Support' }),
      slash({ user: MEL.slack, text: 'connect Support' }),
      slash({ user: CAROL.slack, text: 'connect Support' }),
      slash({ user: GUEST, text: 'connect Support' }),
      slash({ user: OTTO.slack, text: 'connect Sales' }),
      slash({ channel: ARCHIVED_CH, text: 'connect Support' }),
      slash({ user: MEL.slack, text: 'disconnect' }),
      slash({ user: GRACE.slack, text: 'disconnect' }),
      slash({ appId: 'A07OTHERAPP' }),
      signed(formBody(fields({ text: 'connect Support' })), { secret: 'f'.repeat(32) }),
      signed(Buffer.from('user_id=U07%20bad'), {}),
    ];
    for (const req of sent) await w.send(req);
    expect(w.lines.length).toBeGreaterThanOrEqual(10);
    for (const line of w.lines) {
      expect(line.msg).toMatch(/^slack_[a-z_]+$/);
      for (const key of Object.keys(line.fields ?? {})) {
        expect(['installId', 'reason', 'stage', 'code', 'reconnected'], `${line.msg}.${key}`).toContain(key);
      }
    }
    const logged = JSON.stringify(w.lines);
    for (const leak of [
      ...PEOPLE.flatMap((p) => [p.slack, p.email, p.name]),
      'usr_',
      'ada.admin',
      GUEST,
      SUPPORT_CH,
      ARCHIVED_CH,
      'support-desk',
      'Support',
      'Sales',
      SUPPORT.id,
      TEAM_ID,
      'Canopy Works',
      BOT_TOKEN,
      SIGNING_SECRET,
      'connect Support',
    ]) {
      expect(logged).not.toContain(leak);
    }
  });
});
