import { createHmac } from 'node:crypto';
import { PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import {
  INTERACTIONS_ROUTE_PATH,
  createInteractionsHandler,
  type ButtonClick,
  type ClickHandler,
} from '../interactions.js';
import { createLifetime } from '../lifetime.js';
import { SLACK_ID_MAX } from '../limits.js';
import { slackUrls } from '../manifest.js';
import type { SecretName } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import type { InstallRow } from '../store.js';

/*
  `POST /slack/interactions/:installId`, through its route handler. The rules
  pinned here: the route checks what the events and `/ax` routes check (the
  same 404, 401, 413 and 503); a click is read only from Slack's signed
  payload, and only a click on one of our prompt buttons, on a message, by a
  Slack user, is handed on; the 200 goes out before the click is handled,
  and nothing about the click is ever logged but a code.
*/

// ── Fixtures, shaped like what Slack really sends ───────────────────────────

const NOW_MS = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const SIGNING_SECRET = 'test-signing-secret-not-real-01';
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const PENDING_ID = 'Zx8_n2-QpL4mVb7cRt1sYw';
const NO_SECRET_ID = 'Mm0rT7qWc3Yb9Vn2Ls5KdA';
const UNKNOWN_ID = 'Pk4wQ9eRt2Yu7Io1Lp6AsQ';
const APP_ID = 'A07QF9ZK2MN';
const TEAM_ID = 'T07ABCDEF12';
const BOT_USER_ID = 'U07BOTUSER1';
const MEL = 'U07MEL00001';
const ADA = 'U07ADA00001';
const CHANNEL = 'C07SUPPORT1';
const THREAD_TS = '1763121600.000100';
const PROMPT_TS = '1763121660.000200';
/** What both buttons of one prompt carry: 22 base64url characters. */
const PROMPT_ID = 'Rk2pX9vQ_mL4wT7nB1cZ-A';
/** The legacy verification token every payload still carries. Never read: the signature is the proof. */
const LEGACY_TOKEN = 'Jhj5dZrVaK7ZwHHjRyZWjbDl';
const RESPONSE_URL = 'https://hooks.slack.com/actions/T07ABCDEF12/7712345678901/7RxQYH2mRuSampleOnly';

const ACTIVE: InstallRow = {
  installId: INSTALL_ID,
  status: 'active',
  appId: APP_ID,
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: TEAM_ID,
  teamName: 'Canopy Works',
  botUserId: BOT_USER_ID,
  connectedByUserId: 'usr_admin1',
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

// A `block_actions` payload for a click on Allow, in a prompt our bot posted
// in Mel's thread (docs.slack.dev, "block_actions payloads").
const USER = { id: MEL, username: 'mel.member', name: 'mel.member', team_id: TEAM_ID };
const CONTAINER = { type: 'message', message_ts: PROMPT_TS, channel_id: CHANNEL, is_ephemeral: false };
const TEAM = { id: TEAM_ID, domain: 'canopyworks' };
const CHANNEL_REF = { id: CHANNEL, name: 'support-desk' };
const ALLOW = {
  action_id: 'ax_prompt_allow',
  block_id: 'Xq1Lp',
  text: { type: 'plain_text', text: 'Allow', emoji: false },
  value: PROMPT_ID,
  style: 'primary',
  type: 'button',
  action_ts: '1763121700.123456',
};
const DENY = {
  action_id: 'ax_prompt_deny',
  block_id: 'Xq1Lp',
  text: { type: 'plain_text', text: 'Deny', emoji: false },
  value: PROMPT_ID,
  type: 'button',
  action_ts: '1763121700.123456',
};
const MESSAGE = {
  user: BOT_USER_ID,
  type: 'message',
  ts: PROMPT_TS,
  bot_id: 'B07BOTID123',
  app_id: APP_ID,
  text: 'I need your OK before I can do part of this.',
  team: TEAM_ID,
  thread_ts: THREAD_TS,
  parent_user_id: MEL,
  blocks: [
    {
      type: 'section',
      block_id: 'kq3Xv',
      text: { type: 'plain_text', text: 'Wants to gain access to a new service or key', emoji: false },
    },
    {
      type: 'actions',
      block_id: 'Xq1Lp',
      elements: [
        { type: 'button', action_id: 'ax_prompt_allow', text: ALLOW.text, style: 'primary', value: PROMPT_ID },
        { type: 'button', action_id: 'ax_prompt_deny', text: DENY.text, value: PROMPT_ID },
      ],
    },
    {
      type: 'context',
      block_id: 'p9Wm2',
      elements: [{ type: 'mrkdwn', text: 'Only the person who asked can answer this.', verbatim: false }],
    },
  ],
};

function blockActions(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'block_actions',
    user: USER,
    api_app_id: APP_ID,
    token: LEGACY_TOKEN,
    container: CONTAINER,
    trigger_id: '7712345678901.7512345678901.3a1d8c2f0e9b4c6a8d7e5f4b3c2a1908',
    team: TEAM,
    enterprise: null,
    is_enterprise_install: false,
    channel: CHANNEL_REF,
    message: MESSAGE,
    state: { values: {} },
    response_url: RESPONSE_URL,
    actions: [ALLOW],
    ...over,
  };
}

/** `o` without `key`. */
function without(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _gone, ...rest } = o;
  return rest;
}

/** What the handler should hand on for a click on `ALLOW` in `blockActions()`, written out by hand. */
const MELS_ALLOW: ButtonClick = {
  slackUserId: MEL,
  channel: CHANNEL,
  messageTs: PROMPT_TS,
  threadTs: THREAD_TS,
  action: 'allow',
  promptId: PROMPT_ID,
};

/** A form with exactly these fields, in this order. */
const formOf = (fields: Array<[string, string]>): Buffer => Buffer.from(new URLSearchParams(fields).toString());

/** The form Slack posts: one `payload` field holding the JSON. */
const form = (payload: unknown): Buffer =>
  formOf([['payload', typeof payload === 'string' ? payload : JSON.stringify(payload)]]);

// ── A fake request and response, shaped like @ax/http-server's ─────────────

interface Answered {
  status: number;
  /** Which terminator finished the response, or null while it is open. */
  how: 'json' | 'text' | 'end' | 'redirect' | null;
  body: unknown;
  headers: Record<string, string>;
}

/** An empty 200: Slack shows nothing, and the click (if any) is handled after it. */
const OK: Answered = { status: 200, how: 'end', body: undefined, headers: {} };
const BAD_REQUEST: Answered = { status: 400, how: 'end', body: undefined, headers: {} };
const UNAUTHORIZED: Answered = { status: 401, how: 'end', body: undefined, headers: {} };
const UNAVAILABLE: Answered = { status: 503, how: 'end', body: undefined, headers: {} };
/** @ax/http-server's own answer for a path nothing serves. */
const NOT_FOUND: Answered = { status: 404, how: 'json', body: { error: 'not-found' }, headers: {} };

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
    json(v) {
      finish('json', v);
    },
    text(s) {
      finish('text', s);
    },
    end() {
      finish('end');
    },
    redirect(url, status) {
      answer.status = status ?? 302;
      finish('redirect', url);
    },
  };
  return { res, answer };
}

function request(o: { body: Buffer; headers?: Record<string, string>; installId?: string; rawPath?: string }): RouteRequest {
  const installId = o.installId ?? INSTALL_ID;
  return {
    method: 'POST',
    path: `/slack/interactions/${installId}`,
    rawPath: o.rawPath ?? `/slack/interactions/${installId}`,
    params: { installId },
    query: {},
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...o.headers },
    body: o.body,
  };
}

/** Slack's v0 signature, written out apart from the code under test. */
function signatureHeaders(body: Buffer, o: { ts?: number; secret?: string } = {}): Record<string, string> {
  const ts = String(o.ts ?? NOW_S);
  const digest = createHmac('sha256', o.secret ?? SIGNING_SECRET).update(`v0:${ts}:`).update(body).digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${digest}` };
}

/** A request signed over exactly these bytes. */
function signed(
  body: Buffer,
  o: { ts?: number; secret?: string; installId?: string; rawPath?: string; headers?: Record<string, string> } = {},
): RouteRequest {
  return request({
    body,
    ...(o.installId !== undefined ? { installId: o.installId } : {}),
    ...(o.rawPath !== undefined ? { rawPath: o.rawPath } : {}),
    headers: { ...signatureHeaders(body, o), ...o.headers },
  });
}

/** A signed click: Slack's form around this payload. */
const click = (payload: Record<string, unknown> = blockActions(), o: Parameters<typeof signed>[1] = {}): RouteRequest =>
  signed(form(payload), o);

// ── The handler's surroundings ──────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

interface Clicked {
  install: InstallRow;
  click: ButtonClick;
  /** Was the response already finished when the click started being handled? */
  ackedFirst: boolean;
}

function world(
  o: {
    installs?: InstallRow[];
    signingSecrets?: Record<string, string>;
    onClick?: ClickHandler;
    storeFails?: unknown;
    secretFails?: unknown;
    /** Every log call throws after recording its line. */
    loggerThrows?: boolean;
  } = {},
) {
  const installs = new Map((o.installs ?? [ACTIVE]).map((i) => [i.installId, i]));
  const signingSecrets = new Map(Object.entries(o.signingSecrets ?? { [INSTALL_ID]: SIGNING_SECRET }));
  const lookups: string[] = [];
  const secretReads: SecretName[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
    if (o.loggerThrows === true) throw new Error('log sink is gone');
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  const lifetime = createLifetime();
  const clicks: Clicked[] = [];
  let current: Answered | null = null;
  let nowMs = NOW_MS;

  const handler = createInteractionsHandler({
    store: {
      async get(installId) {
        lookups.push(installId);
        if (o.storeFails !== undefined) throw o.storeFails;
        return installs.get(installId) ?? null;
      },
    },
    secrets: {
      async get(install, name) {
        secretReads.push(name);
        if (o.secretFails !== undefined) throw o.secretFails;
        return name === 'signing-secret' ? (signingSecrets.get(install.installId) ?? null) : null;
      },
    },
    lifetime,
    logger,
    now: () => nowMs,
    onClick: async (install, c) => {
      clicks.push({ install, click: c, ackedFirst: current !== null && current.how !== null });
      if (o.onClick !== undefined) await o.onClick(install, c);
    },
  });

  async function send(req: RouteRequest): Promise<Answered> {
    const { res, answer } = fakeResponse();
    current = answer;
    await handler(req, res);
    // The handler never awaits the click; give it a turn to start (and to fail).
    await new Promise((r) => setImmediate(r));
    return answer;
  }

  return {
    send,
    clicks,
    lines,
    lookups,
    secretReads,
    lifetime,
    setNow(ms: number) {
      nowMs = ms;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const fieldsOf = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg).map((l) => l.fields);

// ── A click ─────────────────────────────────────────────────────────────────

describe('a click on a prompt button', () => {
  it('signed Allow or Deny → an empty 200, then onClick once with exactly what was clicked, after the answer went out', async () => {
    const w = world();
    expect(await w.send(click())).toStrictEqual(OK);
    expect(await w.send(click(blockActions({ actions: [DENY] })))).toStrictEqual(OK);
    expect(w.clicks).toStrictEqual([
      { install: ACTIVE, click: MELS_ALLOW, ackedFirst: true },
      { install: ACTIVE, click: { ...MELS_ALLOW, action: 'deny' }, ackedFirst: true },
    ]);
    // Only the signing secret is read here: whatever the click needs next is the click handler's.
    expect(w.secretReads).toEqual(['signing-secret', 'signing-secret']);
    expect(w.lines).toEqual([]);
  });

  it('the interactions URL the manifest gives Slack reaches this handler', async () => {
    expect(INTERACTIONS_ROUTE_PATH).toBe('/slack/interactions/:installId');
    const { pathname } = new URL(slackUrls('https://ax.example/', INSTALL_ID).interactionsUrl);
    const w = world();
    expect(await w.send(click(blockActions(), { rawPath: pathname }))).toStrictEqual(OK);
    expect(w.clicks.map((c) => c.click)).toStrictEqual([MELS_ALLOW]);
  });

  it('reads the channel and the message from wherever Slack put them, and no thread_ts as null', async () => {
    const w = world();
    const cases: Array<[string, Record<string, unknown>, ButtonClick]> = [
      ['no channel: the container names it', without(blockActions(), 'channel'), MELS_ALLOW],
      ['a null channel: the container names it', blockActions({ channel: null }), MELS_ALLOW],
      ['no channel_id in the container: the channel names it', blockActions({ container: without(CONTAINER, 'channel_id') }), MELS_ALLOW],
      ['no message_ts in the container: the message names it', blockActions({ container: without(CONTAINER, 'message_ts') }), MELS_ALLOW],
      ['no message: the container names it, and no thread', without(blockActions(), 'message'), { ...MELS_ALLOW, threadTs: null }],
      ['a message with no thread_ts', blockActions({ message: without(MESSAGE, 'thread_ts') }), { ...MELS_ALLOW, threadTs: null }],
      ['a null thread_ts', blockActions({ message: { ...MESSAGE, thread_ts: null } }), { ...MELS_ALLOW, threadTs: null }],
    ];
    for (const [name, payload, expected] of cases) {
      expect(await w.send(click(payload)), name).toStrictEqual(OK);
      expect(w.clicks.at(-1)?.click, name).toStrictEqual(expected);
    }
    expect(w.clicks).toHaveLength(cases.length);
  });

  it('the answer never waits for the click, and a click in flight holds drain open', async () => {
    const gate = deferred();
    const w = world({ onClick: () => gate.promise });
    const stillWaiting = new Promise<string>((resolve) => {
      setTimeout(() => resolve('the handler is still waiting on the click'), 1_000).unref();
    });
    expect(await Promise.race([w.send(click()), stillWaiting])).toStrictEqual(OK);
    expect(w.clicks).toHaveLength(1);

    let drained = false;
    const draining = w.lifetime.drain().then(() => {
      drained = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false);
    gate.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('a click that fails after the answer: still 200, and slack_interaction_failed carries its code alone', async () => {
    const w = world({
      onClick: async () => {
        throw new SlackApiError('chat.update', 'invalid_auth');
      },
    });
    expect(await w.send(click())).toStrictEqual(OK);
    expect(w.lines).toEqual([
      { level: 'error', msg: 'slack_interaction_failed', fields: { installId: INSTALL_ID, stage: 'click', code: 'invalid_auth' } },
    ]);

    const w2 = world({
      onClick: async () => {
        throw new Error(`could not answer ${MEL} in ${CHANNEL} with ${SIGNING_SECRET}`);
      },
    });
    expect(await w2.send(click())).toStrictEqual(OK);
    expect(w2.lines).toEqual([
      { level: 'error', msg: 'slack_interaction_failed', fields: { installId: INSTALL_ID, stage: 'click', code: 'unknown' } },
    ]);
  });
});

// ── What it checks before reading the payload ───────────────────────────────

describe('what the route checks before it reads the payload', () => {
  it('a forged, missing or foreign signature → 401, and onClick is never called', async () => {
    const w = world();
    const body = form(blockActions());
    // Ada's click on Mel's prompt, under the signature of Mel's.
    const forged = form(blockActions({ user: { ...USER, id: ADA } }));
    const cases: RouteRequest[] = [
      request({ body: forged, headers: signatureHeaders(body) }),
      request({ body }),
      signed(body, { secret: 'test-signing-secret-not-real-02' }),
    ];
    for (const req of cases) expect(await w.send(req)).toStrictEqual(UNAUTHORIZED);
    expect(w.clicks).toEqual([]);
    expect(w.lines).toEqual(
      cases.map(() => ({ level: 'warn', msg: 'slack_interaction_refused', fields: { installId: INSTALL_ID, reason: 'signature' } })),
    );
  });

  it('a stale or future timestamp → 401 and no click; inside the window it runs', async () => {
    const w = world();
    for (const skew of [-301, 301, -3_600, 86_400]) {
      expect(await w.send(click(blockActions(), { ts: NOW_S + skew })), String(skew)).toStrictEqual(UNAUTHORIZED);
    }
    expect(w.clicks).toEqual([]);
    for (const skew of [-300, 300]) {
      expect(await w.send(click(blockActions(), { ts: NOW_S + skew })), String(skew)).toStrictEqual(OK);
    }
    expect(w.clicks).toHaveLength(2);
  });

  it('an unknown, malformed or respelled installId, or one with no signing secret → the router’s own 404', async () => {
    const w = world({ installs: [ACTIVE, NO_SECRET] });
    const firstHex = INSTALL_ID.charCodeAt(0).toString(16);
    const cases: Array<[string, RouteRequest]> = [
      ['unknown install', click(blockActions(), { installId: UNKNOWN_ID })],
      ['21 characters', click(blockActions(), { installId: INSTALL_ID.slice(1) })],
      ['a padding character', click(blockActions(), { installId: `${INSTALL_ID.slice(0, 21)}=` })],
      ['rawPath with %2F', click(blockActions(), { rawPath: `/slack/interactions/${INSTALL_ID.slice(0, 10)}%2F${INSTALL_ID.slice(11)}` })],
      ['a percent-encoded spelling of the right id', click(blockActions(), { rawPath: `/slack/interactions/%${firstHex}${INSTALL_ID.slice(1)}` })],
      ['a trailing slash', click(blockActions(), { rawPath: `/slack/interactions/${INSTALL_ID}/` })],
      ['the events route’s path', click(blockActions(), { rawPath: `/slack/events/${INSTALL_ID}` })],
      ['no signing secret', click(blockActions(), { installId: NO_SECRET_ID })],
    ];
    for (const [name, req] of cases) expect(await w.send(req), name).toStrictEqual(NOT_FOUND);
    expect(w.clicks).toEqual([]);
    // The shape and the raw spelling are checked before any lookup.
    expect(w.lookups).toEqual([UNKNOWN_ID, NO_SECRET_ID]);
    expect(w.lines).toEqual([]);
  });

  it('a body over 64 KiB → 413 before any lookup, for any installId; right at 64 KiB it is read', async () => {
    const w = world();
    const huge = Buffer.alloc(65_537, 0x61);
    const tooLarge = { status: 413, how: 'json', body: { error: 'body-too-large' }, headers: {} };
    expect(await w.send(request({ body: huge, headers: signatureHeaders(huge) }))).toStrictEqual(tooLarge);
    expect(await w.send(request({ body: huge, installId: UNKNOWN_ID, headers: signatureHeaders(huge) }))).toStrictEqual(tooLarge);
    expect(w.lookups).toEqual([]);

    // Form fields Slack never sends pad it out; an empty field is no field.
    const full = Buffer.from(form(blockActions()).toString().padEnd(65_536, '&'));
    expect(full.length).toBe(65_536);
    expect(await w.send(signed(full))).toStrictEqual(OK);
    expect(w.clicks.map((c) => c.click)).toStrictEqual([MELS_ALLOW]);
  });

  it('a failed install or secret lookup → 503 and a code-only line', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    const w = world({ storeFails: down });
    expect(await w.send(click())).toStrictEqual(UNAVAILABLE);
    expect(w.lines).toEqual([
      { level: 'warn', msg: 'slack_interaction_failed', fields: { installId: INSTALL_ID, stage: 'install', code: 'ECONNREFUSED' } },
    ]);

    const w2 = world({
      secretFails: new PluginError({
        code: 'timeout',
        plugin: '@ax/credentials',
        message: `vault slow reading slack:${INSTALL_ID}:signing-secret`,
      }),
    });
    expect(await w2.send(click())).toStrictEqual(UNAVAILABLE);
    expect(w2.lines).toEqual([
      { level: 'warn', msg: 'slack_interaction_failed', fields: { installId: INSTALL_ID, stage: 'secret', code: 'timeout' } },
    ]);
    expect([...w.clicks, ...w2.clicks]).toEqual([]);
  });

  it('after stopAdmission → 503 before any lookup, so Slack shows the click failed and nothing happens', async () => {
    const w = world();
    w.lifetime.stopAdmission();
    expect(await w.send(click())).toStrictEqual(UNAVAILABLE);
    expect(w.lookups).toEqual([]);
    expect(w.clicks).toEqual([]);
  });
});

// ── The payload ─────────────────────────────────────────────────────────────

describe('the payload', () => {
  it('ssl_check with no payload → an empty 200, and no click; with a payload, the payload is read', async () => {
    const w = world();
    expect(await w.send(signed(formOf([['ssl_check', '1'], ['token', LEGACY_TOKEN]])))).toStrictEqual(OK);
    expect(w.clicks).toEqual([]);
    expect(w.lines).toEqual([]);

    expect(await w.send(signed(formOf([['ssl_check', '1'], ['payload', JSON.stringify(blockActions())]])))).toStrictEqual(OK);
    expect(w.clicks.map((c) => c.click)).toStrictEqual([MELS_ALLOW]);
  });

  it('a signed body we cannot read → 400, and no click', async () => {
    const w = world();
    // Each is a valid click on every rule but the one its name says.
    const valid = JSON.stringify(blockActions());
    const invalidUtf8 = Buffer.concat([form(blockActions()), Buffer.from('&note=caf'), Buffer.from([0xff])]);
    const cases: Array<[string, Buffer, Record<string, string>?]> = [
      ['no payload', formOf([['token', LEGACY_TOKEN]])],
      ['an ssl_check that is not 1', formOf([['ssl_check', '0']])],
      ['two payloads', formOf([['payload', valid], ['payload', valid]])],
      ['a payload that is not JSON', form('not json')],
      ['a JSON array', form('[1,2]')],
      ['JSON null', form('null')],
      ['a JSON string', form('"block_actions"')],
      ['JSON, not a form', Buffer.from(valid), { 'content-type': 'application/json' }],
      ['no content type', form(blockActions()), { 'content-type': '' }],
      ['invalid UTF-8', invalidUtf8],
      ['no user', form(without(blockActions(), 'user'))],
      ['a user that is not an object', form(blockActions({ user: MEL }))],
      ['no user.id', form(blockActions({ user: without(USER, 'id') }))],
      ['a user.id with a space', form(blockActions({ user: { ...USER, id: 'U07 MEL0001' } }))],
      ['a user.id over the id cap', form(blockActions({ user: { ...USER, id: `U${'7'.repeat(SLACK_ID_MAX)}` } }))],
      ['no channel anywhere', form(without(blockActions({ container: without(CONTAINER, 'channel_id') }), 'channel'))],
      ['a channel that is not an object', form(blockActions({ channel: CHANNEL }))],
      ['a channel.id with a space', form(blockActions({ channel: { ...CHANNEL_REF, id: 'C07 SUPPORT' } }))],
      ['a container.channel_id with a space', form(blockActions({ container: { ...CONTAINER, channel_id: 'C07 SUPPORT' } }))],
      ['channel and container naming two channels', form(blockActions({ channel: { ...CHANNEL_REF, id: 'C07OTHERCH1' } }))],
      ['no message ts anywhere', form(blockActions({ container: without(CONTAINER, 'message_ts'), message: without(MESSAGE, 'ts') }))],
      ['a message that is not an object', form(blockActions({ message: 'I need your OK' }))],
      ['a container.message_ts with a space', form(blockActions({ container: { ...CONTAINER, message_ts: '1763121660 000200' } }))],
      ['a message.ts with a space', form(blockActions({ message: { ...MESSAGE, ts: '1763121660 000200' } }))],
      ['container and message naming two messages', form(blockActions({ message: { ...MESSAGE, ts: '1763121999.000900' } }))],
      ['a thread_ts with a space', form(blockActions({ message: { ...MESSAGE, thread_ts: '1763121600 000100' } }))],
      ['a thread_ts that is not a string', form(blockActions({ message: { ...MESSAGE, thread_ts: 1763121600.0001 } }))],
    ];
    for (const [name, body, headers] of cases) {
      expect(await w.send(signed(body, headers === undefined ? {} : { headers })), name).toStrictEqual(BAD_REQUEST);
    }
    expect(w.clicks).toEqual([]);
    expect(fieldsOf(w.lines, 'slack_interaction_refused')).toEqual(cases.map(() => ({ installId: INSTALL_ID, reason: 'malformed' })));
    expect(w.lines.every((l) => l.level === 'warn')).toBe(true);

    // A charset parameter on the type is fine.
    const charset = { headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } };
    expect(await w.send(click(blockActions(), charset))).toStrictEqual(OK);
    expect(w.clicks).toHaveLength(1);
  });

  it('anything but a click on one of our prompt buttons, on a message, for this app and workspace → an empty 200, ignored', async () => {
    const w = world({
      installs: [ACTIVE, PENDING],
      signingSecrets: { [INSTALL_ID]: SIGNING_SECRET, [PENDING_ID]: SIGNING_SECRET },
    });
    // Each is a valid click on every rule but the one its reason names.
    const cases: Array<[string, RouteRequest, string, string]> = [
      ['an older interaction type', click(blockActions({ type: 'interactive_message' })), INSTALL_ID, 'type'],
      ['a select menu asking for options', click(blockActions({ type: 'block_suggestion' })), INSTALL_ID, 'type'],
      ['another app', click(blockActions({ api_app_id: 'A07OTHERAPP' })), INSTALL_ID, 'app'],
      ['a pending install', click(blockActions(), { installId: PENDING_ID }), PENDING_ID, 'status'],
      ['another workspace', click(blockActions({ team: { ...TEAM, id: 'T07OTHERTM9' } })), INSTALL_ID, 'team'],
      ['no workspace', click(without(blockActions(), 'team')), INSTALL_ID, 'team'],
      ['a click in a modal', click(blockActions({ container: { ...CONTAINER, type: 'view' } })), INSTALL_ID, 'container'],
      ['an ephemeral message', click(blockActions({ container: { ...CONTAINER, is_ephemeral: true } })), INSTALL_ID, 'container'],
      ['an is_ephemeral we cannot read', click(blockActions({ container: { ...CONTAINER, is_ephemeral: 'true' } })), INSTALL_ID, 'container'],
      ['no container', click(without(blockActions(), 'container')), INSTALL_ID, 'container'],
      ['no actions', click(blockActions({ actions: [] })), INSTALL_ID, 'action'],
      ['two actions', click(blockActions({ actions: [ALLOW, DENY] })), INSTALL_ID, 'action'],
      ['actions that are not a list', click(blockActions({ actions: ALLOW })), INSTALL_ID, 'action'],
      ['an action that is not an object', click(blockActions({ actions: ['ax_prompt_allow'] })), INSTALL_ID, 'action'],
      ['a select menu', click(blockActions({ actions: [{ ...ALLOW, type: 'static_select' }] })), INSTALL_ID, 'action'],
      ['an action id in another case', click(blockActions({ actions: [{ ...ALLOW, action_id: 'AX_PROMPT_ALLOW' }] })), INSTALL_ID, 'action'],
      ['an action id we never minted', click(blockActions({ actions: [{ ...ALLOW, action_id: 'ax_prompt_always' }] })), INSTALL_ID, 'action'],
      ['no action id', click(blockActions({ actions: [without(ALLOW, 'action_id')] })), INSTALL_ID, 'action'],
      ['a 21-character value', click(blockActions({ actions: [{ ...ALLOW, value: PROMPT_ID.slice(1) }] })), INSTALL_ID, 'action'],
      ['a 23-character value', click(blockActions({ actions: [{ ...ALLOW, value: `${PROMPT_ID}A` }] })), INSTALL_ID, 'action'],
      ['a value with padding', click(blockActions({ actions: [{ ...ALLOW, value: `${PROMPT_ID.slice(0, 21)}=` }] })), INSTALL_ID, 'action'],
      ['no value', click(blockActions({ actions: [without(ALLOW, 'value')] })), INSTALL_ID, 'action'],
    ];
    for (const [name, req, installId, reason] of cases) {
      expect(await w.send(req), name).toStrictEqual(OK);
      expect(w.lines.at(-1), name).toEqual({ level: 'info', msg: 'slack_interaction_ignored', fields: { installId, reason } });
    }
    expect(w.lines).toHaveLength(cases.length);
    expect(w.clicks).toEqual([]);
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('a logger that throws never changes what Slack is answered', async () => {
    const w = world({
      installs: [ACTIVE, PENDING],
      signingSecrets: { [INSTALL_ID]: SIGNING_SECRET, [PENDING_ID]: SIGNING_SECRET },
      loggerThrows: true,
      onClick: async () => {
        throw new Error('click failed');
      },
    });
    const cases: Array<[RouteRequest, Answered]> = [
      [click(blockActions(), { secret: 'f'.repeat(32) }), UNAUTHORIZED],
      [signed(form('not json')), BAD_REQUEST],
      [click(blockActions(), { installId: PENDING_ID }), OK],
      [click(blockActions({ actions: [] })), OK],
      [click(), OK],
    ];
    for (const [req, answer] of cases) expect(await w.send(req)).toStrictEqual(answer);
    // Every one of them tried to log, the click's failure included.
    expect(w.lines.map((l) => l.msg)).toEqual([
      'slack_interaction_refused',
      'slack_interaction_refused',
      'slack_interaction_ignored',
      'slack_interaction_ignored',
      'slack_interaction_failed',
    ]);
    expect(w.clicks).toHaveLength(1);
  });

  it('carry an install, a reason, a stage and a code: never a Slack id, the payload, a token or a secret', async () => {
    const w = world({
      installs: [ACTIVE, PENDING],
      signingSecrets: { [INSTALL_ID]: SIGNING_SECRET, [PENDING_ID]: SIGNING_SECRET },
      onClick: async () => {
        throw new Error(`${MEL} ${PROMPT_ID} ${SIGNING_SECRET}`);
      },
    });
    const sent = click();
    await w.send(sent);
    await w.send(click(blockActions(), { secret: 'f'.repeat(32) }));
    await w.send(signed(form('not json')));
    await w.send(click(blockActions({ user: { ...USER, id: 'U07 MEL0001' } })));
    await w.send(click(blockActions({ api_app_id: 'A07OTHERAPP' })));
    await w.send(click(blockActions(), { installId: PENDING_ID }));
    await w.send(click(blockActions({ actions: [{ ...ALLOW, value: 'not-a-prompt-id' }] })));
    expect(w.lines.length).toBeGreaterThanOrEqual(7);

    for (const line of w.lines) {
      expect(line.msg).toMatch(/^slack_interaction_[a-z]+$/);
      for (const key of Object.keys(line.fields ?? {})) {
        expect(['installId', 'reason', 'stage', 'code']).toContain(key);
      }
    }
    const logged = JSON.stringify(w.lines);
    for (const leak of [
      SIGNING_SECRET,
      sent.headers['x-slack-signature'] ?? 'unreachable',
      LEGACY_TOKEN,
      RESPONSE_URL,
      MEL,
      'mel.member',
      CHANNEL,
      'support-desk',
      PROMPT_TS,
      THREAD_TS,
      PROMPT_ID,
      TEAM_ID,
      'canopyworks',
      'Canopy Works',
    ]) {
      expect(logged).not.toContain(leak);
    }
  });
});
