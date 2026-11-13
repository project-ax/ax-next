import { createHmac, randomBytes } from 'node:crypto';
import { PluginError, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  EVENTS_ROUTE_PATH,
  INSTALL_ID_RE,
  createEventsHandler,
  createSeenEvents,
  parseBody,
  type EventDispatcher,
  type SlackEnvelope,
} from '../events.js';
import type { RouteRequest, RouteResponse } from '../http-types.js';
import { createLifetime } from '../lifetime.js';
import {
  EVENT_DEDUPE_MAX,
  EVENT_DEDUPE_TTL_MS,
  EVENT_TEXT_MAX,
  EVENTS_MAX_BODY_BYTES,
  SLACK_ID_MAX,
  URL_CHALLENGE_MAX,
} from '../limits.js';
import { slackUrls } from '../manifest.js';
import type { SecretName } from '../secrets.js';
import { SlackApiError } from '../slack-api.js';
import type { InstallRow } from '../store.js';

// ── Fixtures, shaped like what Slack really sends ───────────────────────────

const NOW_MS = Date.parse('2026-11-13T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const SIGNING_SECRET = 'test-signing-secret-not-real-01';
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const PENDING_ID = 'Zx8_n2-QpL4mVb7cRt1sYw';
const NO_SECRET_ID = 'Mm0rT7qWc3Yb9Vn2Ls5KdA';
const UNKNOWN_ID = 'Pk4wQ9eRt2Yu7Io1Lp6AsQ';
const APP_ID = 'A07QF9ZK2MN';
const TEAM_ID = 'T07ABCDEF12';
const BOT_USER_ID = 'U07BOTUSER1';
const ALICE = 'U07ALICE001';
const DM_CHANNEL = 'D07DMCHANNEL';
const TEXT = 'Can you summarise yesterday?';
const CHALLENGE = '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P';

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

const DM_EVENT = {
  type: 'message',
  user: ALICE,
  text: TEXT,
  ts: '1763035200.000100',
  channel: DM_CHANNEL,
  event_ts: '1763035200.000100',
  channel_type: 'im',
  client_msg_id: '6e3a1f1c-5d0b-4e8e-9b3f-6c2d1a0e9f87',
  team: TEAM_ID,
  blocks: [
    {
      type: 'rich_text',
      block_id: 'Xq1Lp',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: TEXT }] }],
    },
  ],
};

function callback(
  o: { eventId?: string; teamId?: string; appId?: string; event?: unknown; ext?: unknown } = {},
): Record<string, unknown> {
  return {
    token: 'Jhj5dZrVaK7ZwHHjRyZWjbDl',
    team_id: o.teamId ?? TEAM_ID,
    context_team_id: TEAM_ID,
    context_enterprise_id: null,
    api_app_id: o.appId ?? APP_ID,
    event: o.event ?? DM_EVENT,
    type: 'event_callback',
    event_id: o.eventId ?? 'Ev07ABCDEF12',
    event_time: 1763035200,
    authorizations: [
      {
        enterprise_id: null,
        team_id: TEAM_ID,
        user_id: BOT_USER_ID,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    is_ext_shared_channel: 'ext' in o ? o.ext : false,
    event_context: '4-eyJldCI6Im1lc3NhZ2UiLCJ0aWQiOiJUMDdBQkNERUYxMiJ9',
  };
}

const PARSED: SlackEnvelope = {
  teamId: TEAM_ID,
  apiAppId: APP_ID,
  eventId: 'Ev07ABCDEF12',
  isExtSharedChannel: false,
  event: {
    type: 'message',
    user: ALICE,
    text: TEXT,
    ts: '1763035200.000100',
    channel: DM_CHANNEL,
    channelType: 'im',
  },
};

// ── A fake request and response, shaped like @ax/http-server's ─────────────

interface Answered {
  status: number;
  /** Which terminator finished the response, or null while it is open. */
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

function request(o: {
  body: Buffer;
  headers?: Record<string, string>;
  installId?: string;
  rawPath?: string;
}): RouteRequest {
  const installId = o.installId ?? INSTALL_ID;
  return {
    method: 'POST',
    path: `/slack/events/${installId}`,
    rawPath: o.rawPath ?? `/slack/events/${installId}`,
    params: { installId },
    query: {},
    headers: { 'content-type': 'application/json', ...o.headers },
    body: o.body,
  };
}

/** Slack's v0 signature, written out apart from the code under test. */
function signatureHeaders(
  body: Buffer,
  o: { ts?: number; secret?: string } = {},
): Record<string, string> {
  const ts = String(o.ts ?? NOW_S);
  const digest = createHmac('sha256', o.secret ?? SIGNING_SECRET)
    .update(`v0:${ts}:`)
    .update(body)
    .digest('hex');
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${digest}` };
}

const bytes = (payload: unknown): Buffer =>
  Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));

function signed(
  payload: unknown,
  o: {
    ts?: number;
    secret?: string;
    installId?: string;
    rawPath?: string;
    headers?: Record<string, string>;
  } = {},
): RouteRequest {
  const body = bytes(payload);
  return request({
    body,
    ...(o.installId !== undefined ? { installId: o.installId } : {}),
    ...(o.rawPath !== undefined ? { rawPath: o.rawPath } : {}),
    headers: { ...signatureHeaders(body, o), ...o.headers },
  });
}

// ── The handler's surroundings ──────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function world(
  o: {
    installs?: InstallRow[];
    signingSecrets?: Record<string, string>;
    dispatch?: EventDispatcher;
    storeFails?: unknown;
    secretFails?: unknown;
    /** Every log call throws after recording its line. */
    loggerThrows?: boolean;
  } = {},
) {
  const installs = new Map((o.installs ?? [ACTIVE]).map((i) => [i.installId, i]));
  const signingSecrets = new Map(
    Object.entries(o.signingSecrets ?? { [INSTALL_ID]: SIGNING_SECRET }),
  );
  const lookups: string[] = [];
  const secretReads: Array<{ installId: string; connectedByUserId: string; name: SecretName }> =
    [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
    if (o.loggerThrows === true) throw new Error('log sink is gone');
  };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  const lifetime = createLifetime();
  const dispatched: Array<{ install: InstallRow; envelope: SlackEnvelope; ackedFirst: boolean }> =
    [];
  let current: Answered | null = null;
  let nowMs = NOW_MS;

  const handler = createEventsHandler({
    store: {
      async get(installId) {
        lookups.push(installId);
        if (o.storeFails !== undefined) throw o.storeFails;
        return installs.get(installId) ?? null;
      },
    },
    secrets: {
      async get(install, name) {
        secretReads.push({
          installId: install.installId,
          connectedByUserId: install.connectedByUserId,
          name,
        });
        if (o.secretFails !== undefined) throw o.secretFails;
        return name === 'signing-secret' ? (signingSecrets.get(install.installId) ?? null) : null;
      },
    },
    lifetime,
    seen: createSeenEvents({ ttlMs: EVENT_DEDUPE_TTL_MS, max: EVENT_DEDUPE_MAX }),
    dispatch: async (install, envelope) => {
      // Was the response already finished when the dispatch started?
      dispatched.push({ install, envelope, ackedFirst: current !== null && current.how !== null });
      if (o.dispatch !== undefined) await o.dispatch(install, envelope);
    },
    logger,
    now: () => nowMs,
  });

  async function send(req: RouteRequest): Promise<Answered> {
    const { res, answer } = fakeResponse();
    current = answer;
    await handler(req, res);
    // The handler never awaits its dispatch; give it a turn to start.
    await new Promise((r) => setImmediate(r));
    return answer;
  }

  return {
    send,
    dispatched,
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

const refusedFields = (lines: Line[]) =>
  lines.filter((l) => l.msg === 'slack_event_refused').map((l) => l.fields);

// ── parseBody ───────────────────────────────────────────────────────────────

describe('parseBody', () => {
  it('reads a DM event_callback into the envelope, and nothing else', () => {
    expect(parseBody(callback())).toStrictEqual({ kind: 'event_callback', envelope: PARSED });
  });

  it('reads what a thread reply, a bot message, a file share and a mention carry', () => {
    expect(
      parseBody(callback({ event: { ...DM_EVENT, thread_ts: '1763035100.000050' } })),
    ).toMatchObject({ envelope: { event: { threadTs: '1763035100.000050' } } });

    const bot = {
      type: 'message',
      subtype: 'bot_message',
      bot_id: 'B07BOTID123',
      text: 'Nightly report ready',
      ts: '1763035200.000200',
      channel: DM_CHANNEL,
      channel_type: 'im',
    };
    expect(parseBody(callback({ event: bot }))).toStrictEqual({
      kind: 'event_callback',
      envelope: {
        ...PARSED,
        event: {
          type: 'message',
          subtype: 'bot_message',
          botId: 'B07BOTID123',
          text: 'Nightly report ready',
          ts: '1763035200.000200',
          channel: DM_CHANNEL,
          channelType: 'im',
        },
      },
    });

    expect(
      parseBody(callback({ event: { ...DM_EVENT, subtype: 'file_share', text: '' } })),
    ).toMatchObject({ envelope: { event: { subtype: 'file_share', text: '' } } });

    const mention = {
      type: 'app_mention',
      user: ALICE,
      text: `<@${BOT_USER_ID}> what changed?`,
      ts: '1763035300.000300',
      channel: 'C07GENERAL1',
      event_ts: '1763035300.000300',
    };
    expect(parseBody(callback({ event: mention }))).toMatchObject({
      envelope: { event: { type: 'app_mention', channel: 'C07GENERAL1' } },
    });
    expect(parseBody(callback({ ext: true }))).toMatchObject({
      envelope: { isExtSharedChannel: true },
    });
  });

  it('treats a null or missing optional field as absent', () => {
    const parsed = parseBody({
      ...callback({ event: { ...DM_EVENT, bot_id: null, thread_ts: null, subtype: null } }),
      is_ext_shared_channel: null,
    });
    expect(parsed).toStrictEqual({ kind: 'event_callback', envelope: PARSED });
    const { is_ext_shared_channel: _dropped, ...withoutExt } = callback();
    expect(parseBody(withoutExt)).toStrictEqual({ kind: 'event_callback', envelope: PARSED });
  });

  it('reads url_verification and refuses a missing, empty or oversized challenge', () => {
    const base = { token: 'Jhj5dZrVaK7ZwHHjRyZWjbDl', type: 'url_verification' };
    expect(parseBody({ ...base, challenge: CHALLENGE })).toStrictEqual({
      kind: 'url_verification',
      challenge: CHALLENGE,
    });
    expect(parseBody({ ...base, challenge: 'c'.repeat(URL_CHALLENGE_MAX) })).toMatchObject({
      kind: 'url_verification',
    });
    for (const challenge of [undefined, '', 42, 'c'.repeat(URL_CHALLENGE_MAX + 1)]) {
      expect(parseBody({ ...base, challenge }), String(challenge)).toBeNull();
    }
  });

  it('refuses anything that is not a JSON object', () => {
    for (const json of [null, undefined, 'event_callback', 42, true, [callback()]]) {
      expect(parseBody(json), JSON.stringify(json)).toBeNull();
    }
  });

  it('calls every other type other', () => {
    expect(
      parseBody({
        token: 'Jhj5dZrVaK7ZwHHjRyZWjbDl',
        team_id: TEAM_ID,
        minute_rate_limited: 1763035200,
        api_app_id: APP_ID,
        type: 'app_rate_limited',
      }),
    ).toStrictEqual({ kind: 'other' });
    expect(parseBody({})).toStrictEqual({ kind: 'other' });
  });

  it('accepts text up to Slack’s cap and ids up to SLACK_ID_MAX', () => {
    const longId = `E${'v'.repeat(SLACK_ID_MAX - 1)}`;
    expect(
      parseBody(
        callback({ eventId: longId, event: { ...DM_EVENT, text: 'x'.repeat(EVENT_TEXT_MAX) } }),
      ),
    ).toMatchObject({ envelope: { eventId: longId } });
  });

  it('refuses a malformed event_callback', () => {
    const malformed: Array<[string, unknown]> = [
      ['no event_id', { ...callback(), event_id: undefined }],
      ['event_id too long', callback({ eventId: `E${'v'.repeat(SLACK_ID_MAX)}` })],
      ['event_id with a colon', callback({ eventId: 'Ev07:ABC' })],
      ['no team_id', { ...callback(), team_id: undefined }],
      ['api_app_id not a string', { ...callback(), api_app_id: 7 }],
      ['event not an object', callback({ event: 'message' })],
      ['event with no type', callback({ event: { ...DM_EVENT, type: undefined } })],
      ['user not a string', callback({ event: { ...DM_EVENT, user: { id: ALICE } } })],
      ['text over the cap', callback({ event: { ...DM_EVENT, text: 'x'.repeat(EVENT_TEXT_MAX + 1) } })],
      ['bot_id empty', callback({ event: { ...DM_EVENT, bot_id: '' } })],
      ['thread_ts not a string', callback({ event: { ...DM_EVENT, thread_ts: 1763035100 } })],
      ['channel with a space', callback({ event: { ...DM_EVENT, channel: 'D07 DM' } })],
      ['is_ext_shared_channel not a boolean', callback({ ext: 'false' })],
    ];
    for (const [name, json] of malformed) expect(parseBody(json), name).toBeNull();
  });
});

// ── createSeenEvents ────────────────────────────────────────────────────────

describe('createSeenEvents', () => {
  it('remembers an event id for the TTL, then forgets it', () => {
    const seen = createSeenEvents({ ttlMs: 3_600_000, max: 10 });
    expect(seen.firstSighting('Ev07ABCDEF12', NOW_MS)).toBe(true);
    expect(seen.firstSighting('Ev07ABCDEF12', NOW_MS + 60_000)).toBe(false);
    expect(seen.firstSighting('Ev07ABCDEF12', NOW_MS + 3_599_999)).toBe(false);
    expect(seen.firstSighting('Ev07ABCDEF12', NOW_MS + 3_600_000)).toBe(true);
    expect(seen.firstSighting('Ev07ABCDEF12', NOW_MS + 3_600_001)).toBe(false);
  });

  it('holds at most max ids, forgetting the oldest first', () => {
    const seen = createSeenEvents({ ttlMs: 3_600_000, max: 3 });
    for (const id of ['Ev1', 'Ev2', 'Ev3', 'Ev4']) expect(seen.firstSighting(id, NOW_MS)).toBe(true);
    expect(seen.firstSighting('Ev2', NOW_MS)).toBe(false);
    expect(seen.firstSighting('Ev3', NOW_MS)).toBe(false);
    expect(seen.firstSighting('Ev4', NOW_MS)).toBe(false);
    // Ev1 was the oldest when Ev4 arrived.
    expect(seen.firstSighting('Ev1', NOW_MS)).toBe(true);
  });

  it('refuses a TTL or bound that is not a positive integer', () => {
    for (const o of [
      { ttlMs: 0, max: 10 },
      { ttlMs: 1000, max: 0 },
      { ttlMs: Number.NaN, max: 10 },
      { ttlMs: 1000, max: 1.5 },
    ]) {
      expect(() => createSeenEvents(o), JSON.stringify(o)).toThrow(RangeError);
    }
  });
});

describe('INSTALL_ID_RE', () => {
  it('matches every minted installId (16 random bytes, base64url) and nothing looser', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(INSTALL_ID_RE.test(randomBytes(16).toString('base64url'))).toBe(true);
    }
    for (const id of [
      INSTALL_ID.slice(1),
      `${INSTALL_ID}A`,
      'q3VtZ0xH4kTn9Wb2LmPa1+',
      'q3VtZ0xH4kTn9Wb2LmPa1/',
      'q3VtZ0xH4kTn9Wb2LmPa1=',
      'q3VtZ0xH4kTn9Wb2LmPa1A\n',
    ]) {
      expect(INSTALL_ID_RE.test(id), JSON.stringify(id)).toBe(false);
    }
  });
});

// ── createEventsHandler ─────────────────────────────────────────────────────

describe('createEventsHandler', () => {
  it('signed event_callback → 200 and dispatch once with the parsed envelope, after the ack', async () => {
    const w = world();
    const answer = await w.send(signed(callback()));
    expect(answer).toStrictEqual({ status: 200, how: 'end', body: undefined, headers: {} });
    expect(w.dispatched).toStrictEqual([{ install: ACTIVE, envelope: PARSED, ackedFirst: true }]);
    // The signing secret is read as the admin who connected the install.
    expect(w.secretReads).toEqual([
      { installId: INSTALL_ID, connectedByUserId: 'usr_admin1', name: 'signing-secret' },
    ]);
  });

  it('the ack never waits for the dispatch', async () => {
    const w = world({ dispatch: () => new Promise<void>(() => {}) });
    const answer = await w.send(signed(callback()));
    expect(answer).toMatchObject({ status: 200, how: 'end' });
    expect(w.dispatched).toHaveLength(1);
  });

  it('the events URL the manifest gives Slack reaches this handler', async () => {
    expect(EVENTS_ROUTE_PATH).toBe('/slack/events/:installId');
    const { pathname } = new URL(slackUrls('https://ax.example/', INSTALL_ID).eventsUrl);
    const w = world();
    expect(await w.send(signed(callback(), { rawPath: pathname }))).toMatchObject({ status: 200 });
    expect(w.dispatched).toHaveLength(1);
  });

  it('same event_id twice → one dispatch', async () => {
    const w = world();
    await w.send(signed(callback()));
    // Slack's retry: a fresh timestamp and signature, the same event.
    w.setNow(NOW_MS + 60_000);
    const retry = await w.send(
      signed(callback(), {
        ts: NOW_S + 60,
        headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' },
      }),
    );
    expect(retry).toMatchObject({ status: 200, how: 'end' });
    expect(w.dispatched).toHaveLength(1);
    expect(w.lines).toContainEqual({
      level: 'info',
      msg: 'slack_event_ignored',
      fields: { installId: INSTALL_ID, reason: 'duplicate' },
    });

    await w.send(signed(callback({ eventId: 'Ev07ABCDEF13' }), { ts: NOW_S + 60 }));
    expect(w.dispatched.map((d) => d.envelope.eventId)).toEqual(['Ev07ABCDEF12', 'Ev07ABCDEF13']);
  });

  it('a forged request with a fresh event_id does not mark it seen', async () => {
    const w = world();
    const forged = await w.send(
      signed(callback({ eventId: 'Ev07FRESH001' }), {
        secret: '00000000000000000000000000000000',
      }),
    );
    expect(forged).toMatchObject({ status: 401, how: 'end' });

    const real = await w.send(signed(callback({ eventId: 'Ev07FRESH001' })));
    expect(real).toMatchObject({ status: 200, how: 'end' });
    expect(w.dispatched.map((d) => d.envelope.eventId)).toEqual(['Ev07FRESH001']);
  });

  it('a bad, missing or foreign signature → 401, no dispatch', async () => {
    const w = world();
    const body = bytes(callback());
    const tampered = bytes(callback({ event: { ...DM_EVENT, text: 'Delete everything' } }));
    const cases: RouteRequest[] = [
      request({ body: tampered, headers: signatureHeaders(body) }),
      request({ body }),
      signed(callback(), { secret: 'test-signing-secret-not-real-02' }),
    ];
    for (const req of cases) {
      expect(await w.send(req)).toStrictEqual({
        status: 401,
        how: 'end',
        body: undefined,
        headers: {},
      });
    }
    expect(w.dispatched).toHaveLength(0);
    expect(refusedFields(w.lines)).toEqual(
      cases.map(() => ({ installId: INSTALL_ID, reason: 'signature' })),
    );
  });

  it('a stale or future timestamp → 401 and no dispatch; inside the window it runs', async () => {
    const w = world();
    for (const [i, skew] of [-301, 301, -3_600, 86_400].entries()) {
      const req = signed(callback({ eventId: `Ev07SKEWX0${i}` }), { ts: NOW_S + skew });
      expect(await w.send(req), String(skew)).toMatchObject({ status: 401 });
    }
    expect(w.dispatched).toHaveLength(0);

    for (const [i, skew] of [-300, 300].entries()) {
      const req = signed(callback({ eventId: `Ev07SKEWOK${i}` }), { ts: NOW_S + skew });
      expect(await w.send(req), String(skew)).toMatchObject({ status: 200 });
    }
    expect(w.dispatched).toHaveLength(2);
  });

  it('an unknown, malformed or respelled installId, or one with no signing secret, gets the router’s own 404', async () => {
    const w = world({ installs: [ACTIVE, NO_SECRET] });
    const firstHex = INSTALL_ID.charCodeAt(0).toString(16);
    const cases: Array<[string, RouteRequest]> = [
      ['unknown install', signed(callback(), { installId: UNKNOWN_ID })],
      ['21 characters', signed(callback(), { installId: INSTALL_ID.slice(1) })],
      ['a padding character', signed(callback(), { installId: `${INSTALL_ID.slice(0, 21)}=` })],
      [
        'rawPath with %2F',
        signed(callback(), {
          rawPath: `/slack/events/${INSTALL_ID.slice(0, 10)}%2F${INSTALL_ID.slice(11)}`,
        }),
      ],
      [
        'a percent-encoded spelling of the right id',
        signed(callback(), { rawPath: `/slack/events/%${firstHex}${INSTALL_ID.slice(1)}` }),
      ],
      ['a trailing slash', signed(callback(), { rawPath: `/slack/events/${INSTALL_ID}/` })],
      ['no signing secret', signed(callback(), { installId: NO_SECRET_ID })],
    ];
    for (const [name, req] of cases) {
      // One answer for all of them; plugin.test.ts checks it against the real router's 404.
      expect(await w.send(req), name).toStrictEqual({
        status: 404,
        how: 'json',
        body: { error: 'not-found' },
        headers: {},
      });
    }
    expect(w.dispatched).toHaveLength(0);
    // The shape and the raw spelling are checked before any lookup.
    expect(w.lookups).toEqual([UNKNOWN_ID, NO_SECRET_ID]);
    expect(w.lines).toEqual([]);
  });

  it('a body over the cap → 413 before any lookup, the same for any installId', async () => {
    const w = world();
    const huge = Buffer.alloc(EVENTS_MAX_BODY_BYTES + 1, 0x20);
    const known = await w.send(request({ body: huge, headers: signatureHeaders(huge) }));
    expect(known).toStrictEqual({
      status: 413,
      how: 'json',
      body: { error: 'body-too-large' },
      headers: {},
    });
    const unknown = await w.send(
      request({ body: huge, installId: UNKNOWN_ID, headers: signatureHeaders(huge) }),
    );
    expect(unknown).toStrictEqual(known);
    expect(w.lookups).toEqual([]);

    // Right at the cap is fine.
    const full = bytes(JSON.stringify(callback()).padEnd(EVENTS_MAX_BODY_BYTES, ' '));
    expect(full.length).toBe(EVENTS_MAX_BODY_BYTES);
    expect(await w.send(signed(full))).toMatchObject({ status: 200 });
    expect(w.dispatched).toHaveLength(1);
  });

  it('url_verification: signed → 200 with the challenge, even while pending; unsigned → 401', async () => {
    const w = world({
      installs: [ACTIVE, PENDING],
      signingSecrets: { [INSTALL_ID]: SIGNING_SECRET, [PENDING_ID]: SIGNING_SECRET },
    });
    const verification = {
      token: 'Jhj5dZrVaK7ZwHHjRyZWjbDl',
      challenge: CHALLENGE,
      type: 'url_verification',
    };
    const ok = { status: 200, how: 'json', body: { challenge: CHALLENGE }, headers: {} };
    expect(await w.send(signed(verification))).toStrictEqual(ok);
    expect(await w.send(signed(verification, { installId: PENDING_ID }))).toStrictEqual(ok);
    expect(await w.send(request({ body: bytes(verification) }))).toMatchObject({ status: 401 });
    expect(w.dispatched).toHaveLength(0);
  });

  it('another app, another workspace or a pending install → 200 and ignored', async () => {
    const w = world({
      installs: [ACTIVE, PENDING],
      signingSecrets: { [INSTALL_ID]: SIGNING_SECRET, [PENDING_ID]: SIGNING_SECRET },
    });
    const cases: Array<[RouteRequest, string, string]> = [
      [signed(callback({ appId: 'A07OTHERAPP' })), INSTALL_ID, 'app'],
      [signed(callback({ teamId: 'T07OTHERTM9', eventId: 'Ev07TEAM0001' })), INSTALL_ID, 'team'],
      [signed(callback({ eventId: 'Ev07PEND0001' }), { installId: PENDING_ID }), PENDING_ID, 'status'],
    ];
    for (const [req, installId, reason] of cases) {
      expect(await w.send(req), reason).toMatchObject({ status: 200, how: 'end' });
      expect(w.lines.at(-1), reason).toEqual({
        level: 'info',
        msg: 'slack_event_ignored',
        fields: { installId, reason },
      });
    }
    expect(w.dispatched).toHaveLength(0);
    // An ignored event is not remembered: the same id, once it applies, runs.
    expect(await w.send(signed(callback({ eventId: 'Ev07TEAM0001' })))).toMatchObject({
      status: 200,
    });
    expect(w.dispatched).toHaveLength(1);
  });

  it('our own bot’s message → 200 and ignored', async () => {
    const w = world();
    const own = {
      type: 'message',
      user: BOT_USER_ID,
      bot_id: 'B07BOTID123',
      app_id: APP_ID,
      text: 'Here is your summary.',
      ts: '1763035260.000200',
      channel: DM_CHANNEL,
      event_ts: '1763035260.000200',
      channel_type: 'im',
    };
    expect(await w.send(signed(callback({ eventId: 'Ev07OWNBOT01', event: own })))).toMatchObject(
      { status: 200, how: 'end' },
    );
    expect(w.dispatched).toHaveLength(0);
  });

  it('other signed types → 200, not dispatched', async () => {
    const w = world();
    const rateLimited = {
      token: 'Jhj5dZrVaK7ZwHHjRyZWjbDl',
      team_id: TEAM_ID,
      minute_rate_limited: 1763035200,
      api_app_id: APP_ID,
      type: 'app_rate_limited',
    };
    expect(await w.send(signed(rateLimited))).toMatchObject({ status: 200, how: 'end' });
    expect(w.dispatched).toHaveLength(0);
    expect(w.lines).toEqual([
      { level: 'info', msg: 'slack_event_ignored', fields: { installId: INSTALL_ID, reason: 'other' } },
    ]);
  });

  it('a signed body that is not a usable JSON object → 400, no dispatch', async () => {
    const w = world();
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"type":"event_callback","event_id":"Ev07ABC'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]);
    const bodies: unknown[] = [
      'not json',
      '[1,2]',
      '"event_callback"',
      'null',
      invalidUtf8,
      callback({ eventId: `E${'v'.repeat(SLACK_ID_MAX)}` }),
      callback({ event: 'message' }),
    ];
    for (const body of bodies) {
      expect(await w.send(signed(body)), String(body)).toStrictEqual({
        status: 400,
        how: 'end',
        body: undefined,
        headers: {},
      });
    }
    expect(w.dispatched).toHaveLength(0);
    expect(refusedFields(w.lines)).toEqual(
      bodies.map(() => ({ installId: INSTALL_ID, reason: 'malformed' })),
    );
  });

  it('after stopAdmission → 503 before any lookup, so Slack retries elsewhere', async () => {
    const w = world();
    w.lifetime.stopAdmission();
    expect(await w.send(signed(callback()))).toStrictEqual({
      status: 503,
      how: 'end',
      body: undefined,
      headers: {},
    });
    expect(w.lookups).toEqual([]);
    expect(w.dispatched).toHaveLength(0);
  });

  it('a dispatch in flight holds drain open', async () => {
    const gate = deferred();
    const w = world({ dispatch: () => gate.promise });
    await w.send(signed(callback()));
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

  it('dispatch rejects → response already 200 and slack_event_failed logged without the error text', async () => {
    const w = world({
      dispatch: async () => {
        throw new SlackApiError('users.info', 'invalid_auth');
      },
    });
    expect(await w.send(signed(callback()))).toMatchObject({ status: 200, how: 'end' });
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_event_failed',
        fields: { installId: INSTALL_ID, stage: 'dispatch', code: 'invalid_auth' },
      },
    ]);

    const w2 = world({
      dispatch: async () => {
        throw new Error(`could not answer "${TEXT}" with ${SIGNING_SECRET}`);
      },
    });
    expect(await w2.send(signed(callback()))).toMatchObject({ status: 200, how: 'end' });
    expect(w2.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_event_failed',
        fields: { installId: INSTALL_ID, stage: 'dispatch', code: 'unknown' },
      },
    ]);
  });

  it('a failed install or secret lookup → 503 and a code-only line', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
    });
    const w = world({ storeFails: down });
    expect(await w.send(signed(callback()))).toMatchObject({ status: 503, how: 'end' });
    expect(w.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_event_failed',
        fields: { installId: INSTALL_ID, stage: 'install', code: 'ECONNREFUSED' },
      },
    ]);

    const w2 = world({
      secretFails: new PluginError({
        code: 'timeout',
        plugin: '@ax/credentials',
        message: `vault slow reading slack:${INSTALL_ID}:signing-secret`,
      }),
    });
    expect(await w2.send(signed(callback()))).toMatchObject({ status: 503, how: 'end' });
    expect(w2.lines).toEqual([
      {
        level: 'warn',
        msg: 'slack_event_failed',
        fields: { installId: INSTALL_ID, stage: 'secret', code: 'timeout' },
      },
    ]);
    expect(w.dispatched).toHaveLength(0);
    expect(w2.dispatched).toHaveLength(0);
  });

  it('a logger that throws never changes what Slack is answered', async () => {
    const w = world({
      installs: [ACTIVE, PENDING],
      signingSecrets: { [INSTALL_ID]: SIGNING_SECRET, [PENDING_ID]: SIGNING_SECRET },
      loggerThrows: true,
      dispatch: async () => {
        throw new Error('dispatch failed');
      },
    });
    const cases: Array<[RouteRequest, number]> = [
      [signed(callback(), { secret: 'f'.repeat(32) }), 401],
      [signed('not json'), 400],
      [signed(callback({ eventId: 'Ev07PEND0002' }), { installId: PENDING_ID }), 200],
      [signed({ type: 'app_rate_limited', team_id: TEAM_ID }), 200],
      [signed(callback()), 200],
      [signed(callback()), 200],
    ];
    for (const [req, status] of cases) {
      expect(await w.send(req)).toMatchObject({ status, how: 'end' });
    }
    // Every one of them tried to log, the dispatch failure included.
    expect(w.lines.map((l) => l.msg)).toEqual([
      'slack_event_refused',
      'slack_event_refused',
      'slack_event_ignored',
      'slack_event_ignored',
      'slack_event_failed',
      'slack_event_ignored',
    ]);
  });

  it('log lines carry only slack_ events with an install, a reason, a stage and a code', async () => {
    const w = world({
      installs: [ACTIVE, PENDING],
      signingSecrets: { [INSTALL_ID]: SIGNING_SECRET, [PENDING_ID]: SIGNING_SECRET },
      dispatch: async () => {
        throw new Error(`${TEXT} ${SIGNING_SECRET}`);
      },
    });
    const sent = signed(callback());
    await w.send(sent);
    await w.send(sent);
    await w.send(signed(callback({ eventId: 'Ev07OTHER001' }), { secret: 'f'.repeat(32) }));
    await w.send(signed('not json'));
    await w.send(signed(callback({ appId: 'A07OTHERAPP', eventId: 'Ev07OTHER002' })));
    await w.send(signed(callback({ eventId: 'Ev07OTHER003' }), { installId: PENDING_ID }));
    await w.send(signed({ type: 'app_rate_limited', team_id: TEAM_ID }));
    expect(w.lines.length).toBeGreaterThanOrEqual(6);

    for (const line of w.lines) {
      expect(line.msg).toMatch(/^slack_[a-z_]+$/);
      for (const key of Object.keys(line.fields ?? {})) {
        expect(['installId', 'reason', 'stage', 'code']).toContain(key);
      }
    }
    const logged = JSON.stringify(w.lines);
    for (const leak of [
      SIGNING_SECRET,
      sent.headers['x-slack-signature']!,
      TEXT,
      ALICE,
      DM_CHANNEL,
      TEAM_ID,
      'Canopy Works',
    ]) {
      expect(logged).not.toContain(leak);
    }
  });
});
