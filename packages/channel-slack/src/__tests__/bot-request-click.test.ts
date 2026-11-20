import { HookBus, PluginError, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { createBotRequestClickHandler } from '../bot-request-click.js';
import type { BotReply } from '../bots.js';
import { COPY } from '../copy.js';
import type { BotRequestClick } from '../interactions.js';
import type { SecretName, SecretStore } from '../secrets.js';
import { SlackApiError, type SlackApi } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { fakeBotToken } from './fake-slack-tokens.js';

/*
  The Decline gate (bot-request-click.ts), through the handler the
  interactions route hands each Decline in a bot request's DM to (TASK-1170).
  The rules pinned here: only a Slack member whose confirmed email maps to an
  AX admin NOW declines, proved again on every click from Slack and AX and
  never from the message; the admin check runs before anything touches the
  request, so anyone else learns nothing about it; a member Slack doesn't
  admit gets silence, and anyone else admitted gets one private line; the
  domain's decline (deleted under the app lock) is what makes a button act at
  most once; and logs carry codes, never a Slack id, an email, a name or an
  AX user's id.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const TEAM_ID = 'T07ABCDEF12';
const BOT_TOKEN = fakeBotToken('DECLINEGATESECRET');

/** The shared app's install: the bot that DMs the AX admins about a bot request. */
const SHARED: InstallRow = {
  installId: INSTALL_ID,
  kind: 'shared',
  status: 'active',
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: TEAM_ID,
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_owner',
  agentId: null,
  requestedByUserId: null,
  botHandle: null,
  createdAt: new Date('2026-11-13T10:00:00Z'),
  configTokenAddedAt: new Date('2026-11-13T10:00:00Z'),
  installedAt: new Date('2026-11-13T10:05:00Z'),
};

/** Ada: an AX admin, DMed about a team's request. */
const ADA = 'U07ADA00001';
const ADA_EMAIL = 'ada@canopyworks.com';
const DM_ADA = 'D07DMADA001';
/** Ben: a member with an AX account who isn't an admin (or no longer is). */
const BEN = 'U07BEN00001';
const BEN_EMAIL = 'ben@canopyworks.com';
const DM_BEN = 'D07DMBEN001';
/** The DM's message, and the request it's about: our own id, as bot-requests.ts mints it. */
const DM_TS = '1763121720.000300';
const REQUEST_ID = 'Hn5tY2wQ_aB8zK3vM6pR-g';

/** A users.info `user`, as Slack answers it for a full member with a confirmed email. */
function member(id: string, email: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    team_id: TEAM_ID,
    deleted: false,
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_email_confirmed: true,
    real_name: name,
    profile: { email, real_name: name, display_name: name.split(' ')[0] },
    ...over,
  };
}

const SLACK_USERS: Record<string, unknown> = {
  [ADA]: member(ADA, ADA_EMAIL, 'Ada Lovelace'),
  [BEN]: member(BEN, BEN_EMAIL, 'Ben Okafor'),
};
/** auth:find-user-by-email's answers, by the email exactly as users.info gave it. Absent: no account. */
const AX_USERS: Record<string, unknown> = {
  [ADA_EMAIL]: { userId: 'usr_ada' },
  [BEN_EMAIL]: { userId: 'usr_ben' },
};
/** auth:get-user's answers, by id, shaped like @ax/auth-better's `User`. Absent: no account. */
const ACCOUNTS: Record<string, unknown> = {
  usr_ada: { id: 'usr_ada', email: ADA_EMAIL, displayName: 'Ada Lovelace', isAdmin: true },
  usr_ben: { id: 'usr_ben', email: BEN_EMAIL, displayName: 'Ben Okafor', isAdmin: false },
};

/** A Decline, as the interactions route hands one on. Ada's in her DM unless said otherwise. */
const decline = (over: Partial<BotRequestClick> = {}): BotRequestClick => ({
  slackUserId: ADA,
  channel: DM_ADA,
  messageTs: DM_TS,
  requestId: REQUEST_ID,
  ...over,
});
const BENS = { slackUserId: BEN, channel: DM_BEN };

/** A private line to `user` in the DM they clicked in: no thread (the DM's message is a top-level one). */
function told(user: string, channel: string, text: string) {
  return { method: 'postEphemeral', token: BOT_TOKEN, args: { channel, user, text } };
}

const fault = (plugin: string) =>
  new PluginError({ code: 'store-unavailable', plugin, message: `${plugin} down: ${ADA_EMAIL} usr_ada` });

// ── The fake Slack ──────────────────────────────────────────────────────────

type Method = keyof SlackApi;
interface SlackCall {
  method: Method;
  token: string;
  args: Record<string, unknown>;
}

function fakeSlack(trail: string[], o: { users: Record<string, unknown>; ephemeralFails?: unknown }) {
  const calls: SlackCall[] = [];
  const record = (method: Method, token: string, args: Record<string, unknown>): void => {
    calls.push({ method, token, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
    trail.push(`slack:${method}`);
  };
  /** A method the gate must never call: recorded too, so an exact call list shows it. */
  const notHere =
    (method: Method) =>
    async (): Promise<never> => {
      record(method, '', {});
      throw new Error(`the Decline gate must not call ${method}`);
    };
  const api: SlackApi = {
    rotateConfigToken: notHere('rotateConfigToken'),
    createApp: notHere('createApp'),
    updateApp: notHere('updateApp'),
    deleteApp: notHere('deleteApp'),
    setAppIcon: notHere('setAppIcon'),
    oauthAccess: notHere('oauthAccess'),
    async usersInfo(token, user) {
      record('usersInfo', token, { user });
      const answer = o.users[user];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new SlackApiError('users.info', 'user_not_found');
      return answer;
    },
    usersLookupByEmail: notHere('usersLookupByEmail'),
    postMessage: notHere('postMessage'),
    postBlocks: notHere('postBlocks'),
    postDirect: notHere('postDirect'),
    updateMessage: notHere('updateMessage'),
    async postEphemeral(token, a) {
      record('postEphemeral', token, { ...a });
      if (o.ephemeralFails !== undefined) throw o.ephemeralFails;
    },
    startStream: notHere('startStream'),
    appendStream: notHere('appendStream'),
    stopStream: notHere('stopStream'),
    addReaction: notHere('addReaction'),
    removeReaction: notHere('removeReaction'),
    conversationsInfo: notHere('conversationsInfo'),
    conversationsList: notHere('conversationsList'),
    conversationsJoin: notHere('conversationsJoin'),
  };
  return { api, calls };
}

// ── The world ───────────────────────────────────────────────────────────────

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

interface WorldOptions {
  /** users.info's answers by Slack id, over SLACK_USERS. An Error is thrown. */
  slackUsers?: Record<string, unknown>;
  /** auth:find-user-by-email's raw answers by email, over AX_USERS. */
  axUsers?: Record<string, unknown>;
  /** auth:get-user's raw answers by id, over ACCOUNTS. */
  accounts?: Record<string, unknown>;
  findUserFails?: boolean;
  getUserFails?: boolean;
  /** The vault's answer for the bot token: one, none, or a failure. */
  botToken?: string | null | Error;
  /** What the domain's decline does, instead of the one below that deletes an open request once. */
  decline?: () => Promise<BotReply>;
  ephemeralFails?: unknown;
  /** Every log call throws after recording its line. */
  loggerThrows?: boolean;
}

function world(o: WorldOptions = {}) {
  /** Everything the gate asked of anyone, in order. */
  const trail: string[] = [];
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields: { ...fields } });
    if (o.loggerThrows === true) throw new Error('log sink is gone');
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };

  const bus = new HookBus();
  const findUser: Array<{ ctx: AgentContext; email: unknown }> = [];
  bus.registerService('auth:find-user-by-email', 'fake-auth', async (ctx, input) => {
    const email = (input as { email: unknown }).email;
    findUser.push({ ctx, email });
    trail.push('auth:find-user-by-email');
    if (o.findUserFails === true) throw fault('fake-auth');
    const users: Record<string, unknown> = { ...AX_USERS, ...o.axUsers };
    return typeof email === 'string' && Object.hasOwn(users, email) ? users[email] : null;
  });
  const getUser: Array<{ ctx: AgentContext; userId: unknown }> = [];
  bus.registerService('auth:get-user', 'fake-auth', async (ctx, input) => {
    const userId = (input as { userId: unknown }).userId;
    getUser.push({ ctx, userId });
    trail.push('auth:get-user');
    if (o.getUserFails === true) throw fault('fake-auth');
    const accounts: Record<string, unknown> = { ...ACCOUNTS, ...o.accounts };
    return typeof userId === 'string' && Object.hasOwn(accounts, userId) ? accounts[userId] : null;
  });

  const vault: Array<{ installId: string; name: SecretName }> = [];
  const secrets: Pick<SecretStore, 'get'> = {
    async get(install, name) {
      vault.push({ installId: install.installId, name });
      trail.push(`vault:${name}`);
      const answer = o.botToken === undefined ? BOT_TOKEN : o.botToken;
      if (answer instanceof Error) throw answer;
      return name === 'bot-token' ? answer : null;
    },
  };

  const slack = fakeSlack(trail, {
    users: { ...SLACK_USERS, ...o.slackUsers },
    ...(o.ephemeralFails !== undefined ? { ephemeralFails: o.ephemeralFails } : {}),
  });

  // The domain's own rule (bot-requests.ts): the request is deleted under the
  // app lock, so of two declines only the first finds it.
  const open = new Set([REQUEST_ID]);
  const declines: Array<{ requestId: string; actorUserId: string }> = [];
  const requests = {
    async decline(i: { requestId: string; actorUserId: string }): Promise<BotReply> {
      declines.push({ ...i });
      trail.push('requests:decline');
      if (o.decline !== undefined) return o.decline();
      return open.delete(i.requestId) ? { status: 200, body: {} } : { status: 404, body: { error: 'not-found' } };
    },
  };

  const onBotRequestClick = createBotRequestClickHandler({ bus, api: slack.api, secrets, requests, logger });

  return { onBotRequestClick, trail, lines, slack, findUser, getUser, vault, declines, open };
}

const msgs = (lines: Line[], msg: string) => lines.filter((l) => l.msg === msg).map((l) => l.fields);

// ── An AX admin declines ────────────────────────────────────────────────────

describe('the Decline gate: an AX admin declines', () => {
  it("an AX admin's click declines it, as her, and tells her nothing more", async () => {
    const w = world();
    await w.onBotRequestClick(SHARED, decline());

    expect(w.declines).toStrictEqual([{ requestId: REQUEST_ID, actorUserId: 'usr_ada' }]);
    // The redraw of her DM is the answer (bot-request-dms.ts): nothing private.
    expect(w.slack.calls).toStrictEqual([{ method: 'usersInfo', token: BOT_TOKEN, args: { user: ADA } }]);
    expect(w.trail).toEqual(['vault:bot-token', 'slack:usersInfo', 'auth:find-user-by-email', 'auth:get-user', 'requests:decline']);
    expect(msgs(w.lines, 'slack_bot_request_click_declined')).toEqual([{ installId: INSTALL_ID, requestId: REQUEST_ID }]);
    expect(w.lines).toHaveLength(1);
  });

  it("proves who she is from users.info's email and AX, never from the click: the email goes to auth exactly as Slack gave it, and the admin question is about the account it maps to", async () => {
    const odd = 'Ada.Lovelace@CanopyWorks.com';
    const w = world({
      slackUsers: { [ADA]: member(ADA, odd, 'Ada Lovelace') },
      axUsers: { [odd]: { userId: 'usr_ada' } },
    });
    await w.onBotRequestClick(SHARED, decline());

    expect(w.vault).toEqual([{ installId: INSTALL_ID, name: 'bot-token' }]);
    expect(w.findUser.map((f) => f.email)).toEqual([odd]);
    expect(w.getUser.map((g) => [g.userId, g.ctx.userId])).toEqual([['usr_ada', 'usr_ada']]);
    expect(w.declines).toStrictEqual([{ requestId: REQUEST_ID, actorUserId: 'usr_ada' }]);
  });
});

// ── Anyone else ─────────────────────────────────────────────────────────────

describe('the Decline gate: anyone else', () => {
  it('a member whose account isn\'t an AX admin, or who has no account: one private "Only an admin can answer this.", and decline is never called', async () => {
    const cases: Array<[string, WorldOptions, Partial<BotRequestClick>]> = [
      ['Ben: an account, not an admin', {}, BENS],
      ['Ada, demoted since her DM was sent', { accounts: { usr_ada: { ...(ACCOUNTS['usr_ada'] as object), isAdmin: false } } }, {}],
      ['an account auth no longer has', { accounts: { usr_ada: null } }, {}],
      ['auth answering about someone else', { accounts: { usr_ada: { id: 'usr_other', isAdmin: true } } }, {}],
      ["an isAdmin that isn't exactly true", { accounts: { usr_ada: { id: 'usr_ada', isAdmin: 'true' } } }, {}],
      ['no account for her confirmed email', { axUsers: { [ADA_EMAIL]: null } }, {}],
      ["an account answer we can't read", { axUsers: { [ADA_EMAIL]: { userId: '' } } }, {}],
    ];
    for (const [name, options, who] of cases) {
      const w = world(options);
      const click = decline(who);
      await w.onBotRequestClick(SHARED, click);
      expect(w.slack.calls.filter((c) => c.method === 'postEphemeral'), name).toStrictEqual([
        told(click.slackUserId, click.channel, COPY.botRequestOnlyAdmin),
      ]);
      expect(w.declines, name).toEqual([]);
      expect(w.open.has(REQUEST_ID), name).toBe(true);
    }
  });

  it('a guest, deactivated, other-workspace or unconfirmed clicker: silence, and no AX lookup', async () => {
    const ada = (over: Record<string, unknown>) => member(ADA, ADA_EMAIL, 'Ada Lovelace', over);
    const cases: Array<[string, unknown, string]> = [
      ['a guest', ada({ is_restricted: true }), 'guest'],
      ['a single-channel guest', ada({ is_ultra_restricted: true }), 'guest'],
      ['deactivated', ada({ deleted: true }), 'deactivated'],
      ['another workspace', ada({ team_id: 'T07OTHERTM9' }), 'other-workspace'],
      ['a stranger (Slack Connect)', ada({ is_stranger: true }), 'other-workspace'],
      ['an unconfirmed email', ada({ is_email_confirmed: false }), 'email-unconfirmed'],
      ['invited, not yet joined', ada({ is_invited_user: true }), 'invited'],
      ['a bot', ada({ is_bot: true }), 'bot'],
      ['no email', ada({ profile: { real_name: 'Ada Lovelace' } }), 'no-email'],
      ['users.info answering about someone else', member(BEN, BEN_EMAIL, 'Ben Okafor'), 'user-mismatch'],
      ['a user Slack no longer has', new SlackApiError('users.info', 'user_not_found'), 'user_not_found'],
      ['a revoked bot token', new SlackApiError('users.info', 'token_revoked'), 'token_revoked'],
    ];
    for (const [name, answer, code] of cases) {
      const w = world({ slackUsers: { [ADA]: answer } });
      await w.onBotRequestClick(SHARED, decline());
      expect(w.trail, name).toEqual(['vault:bot-token', 'slack:usersInfo']);
      expect(msgs(w.lines, 'slack_bot_request_click_refused'), name).toEqual([
        { installId: INSTALL_ID, requestId: REQUEST_ID, reason: 'not-admitted', code },
      ]);
    }

    // An install row with no workspace on record admits nobody, without asking Slack.
    const w = world();
    await w.onBotRequestClick({ ...SHARED, teamId: null, teamName: null }, decline());
    expect(w.trail).toEqual(['vault:bot-token']);
    expect(msgs(w.lines, 'slack_bot_request_click_refused')).toEqual([
      { installId: INSTALL_ID, requestId: REQUEST_ID, reason: 'not-admitted', code: 'other-workspace' },
    ]);
  });

  it('Slack briefly unavailable: "try again" privately, and no AX lookup', async () => {
    for (const code of ['ratelimited', 'timeout', 'network', 'http-503', 'internal_error']) {
      const w = world({ slackUsers: { [ADA]: new SlackApiError('users.info', code) } });
      await w.onBotRequestClick(SHARED, decline());
      expect(w.trail, code).toEqual(['vault:bot-token', 'slack:usersInfo', 'slack:postEphemeral']);
      expect(w.slack.calls.at(-1), code).toStrictEqual(told(ADA, DM_ADA, COPY.promptFailed));
    }
  });

  it('an auth fault mapping or checking: "try again", logged code-only, decline never called', async () => {
    const cases: Array<[string, WorldOptions, string]> = [
      ['mapping her email', { findUserFails: true }, 'find-user'],
      ['asking whether she is an admin', { getUserFails: true }, 'is-admin'],
    ];
    for (const [name, options, stage] of cases) {
      const w = world(options);
      await w.onBotRequestClick(SHARED, decline());
      expect(w.slack.calls.filter((c) => c.method === 'postEphemeral'), name).toStrictEqual([
        told(ADA, DM_ADA, COPY.promptFailed),
      ]);
      expect(w.declines, name).toEqual([]);
      expect(msgs(w.lines, 'slack_bot_request_click_failed'), name).toEqual([
        { installId: INSTALL_ID, requestId: REQUEST_ID, stage, code: 'store-unavailable' },
      ]);
    }
  });

  it('the admin check runs before anything touches the request', async () => {
    const ben = world();
    await ben.onBotRequestClick(SHARED, decline(BENS));
    expect(ben.trail).toEqual(['vault:bot-token', 'slack:usersInfo', 'auth:find-user-by-email', 'auth:get-user', 'slack:postEphemeral']);

    const ada = world();
    await ada.onBotRequestClick(SHARED, decline());
    const trail = ada.trail;
    expect(trail.indexOf('auth:get-user')).toBeGreaterThanOrEqual(0);
    expect(trail.indexOf('auth:get-user')).toBeLessThan(trail.indexOf('requests:decline'));
  });
});

// ── The request ─────────────────────────────────────────────────────────────

describe('the Decline gate: the request', () => {
  it('a request already handled (404): "This request was already handled." privately; a double click declines once', async () => {
    const w = world();
    await w.onBotRequestClick(SHARED, decline());
    await w.onBotRequestClick(SHARED, decline());

    expect(w.declines).toHaveLength(2);
    expect(w.open.has(REQUEST_ID)).toBe(false);
    expect(w.slack.calls.filter((c) => c.method === 'postEphemeral')).toStrictEqual([
      told(ADA, DM_ADA, COPY.botRequestHandled),
    ]);
    expect(msgs(w.lines, 'slack_bot_request_click_declined')).toHaveLength(1);
    expect(msgs(w.lines, 'slack_bot_request_click_refused')).toEqual([
      { installId: INSTALL_ID, requestId: REQUEST_ID, reason: 'gone' },
    ]);
  });

  it('a decline that throws or answers anything but 200 or 404: "try again", logged code-only', async () => {
    const cases: Array<[string, () => Promise<BotReply>, string]> = [
      ['a store fault', async () => Promise.reject(fault('channel-slack')), 'store-unavailable'],
      ['an error with no code', async () => Promise.reject(new Error(`decline of ${REQUEST_ID} by usr_ada failed`)), 'unknown'],
      ['a 500', async () => ({ status: 500, body: { error: 'internal' } }), 'status-500'],
      ['a 409', async () => ({ status: 409, body: { error: 'conflict' } }), 'status-409'],
      ['no reply at all', async () => null as unknown as BotReply, 'unknown'],
    ];
    for (const [name, reply, code] of cases) {
      const w = world({ decline: reply });
      await w.onBotRequestClick(SHARED, decline());
      expect(w.declines, name).toStrictEqual([{ requestId: REQUEST_ID, actorUserId: 'usr_ada' }]);
      expect(w.slack.calls.filter((c) => c.method === 'postEphemeral'), name).toStrictEqual([
        told(ADA, DM_ADA, COPY.promptFailed),
      ]);
      expect(msgs(w.lines, 'slack_bot_request_click_failed'), name).toEqual([
        { installId: INSTALL_ID, requestId: REQUEST_ID, stage: 'decline', code },
      ]);
    }
  });
});

// ── No token, lines and logs ────────────────────────────────────────────────

describe('the Decline gate: no bot token, private lines and logs', () => {
  it('no bot token: logged, nothing said, nothing asked', async () => {
    const cases: Array<[string, WorldOptions, string]> = [
      ['none in the vault', { botToken: null }, 'missing'],
      ['a vault read that fails', { botToken: fault('@ax/credentials') }, 'store-unavailable'],
    ];
    for (const [name, options, code] of cases) {
      const w = world(options);
      await w.onBotRequestClick(SHARED, decline());
      expect(w.trail, name).toEqual(['vault:bot-token']);
      expect(w.lines, name).toEqual([
        {
          level: 'error',
          msg: 'slack_bot_request_click_failed',
          fields: { installId: INSTALL_ID, requestId: REQUEST_ID, stage: 'bot-token', code },
        },
      ]);
    }
  });

  it('a private line Slack refuses is logged, and never thrown', async () => {
    const w = world({ ephemeralFails: new SlackApiError('chat.postEphemeral', 'channel_not_found') });
    await expect(w.onBotRequestClick(SHARED, decline(BENS))).resolves.toBeUndefined();
    expect(w.trail.at(-1)).toBe('slack:postEphemeral');
    expect(msgs(w.lines, 'slack_bot_request_click_failed')).toEqual([
      { installId: INSTALL_ID, requestId: REQUEST_ID, stage: 'ephemeral', code: 'channel_not_found' },
    ]);
  });

  it('a logger that throws changes nothing: an admin still declines, and anyone else is still told', async () => {
    const ada = world({ loggerThrows: true });
    await expect(ada.onBotRequestClick(SHARED, decline())).resolves.toBeUndefined();
    expect(ada.declines).toHaveLength(1);
    expect(ada.lines.length).toBeGreaterThan(0);

    const ben = world({ loggerThrows: true });
    await expect(ben.onBotRequestClick(SHARED, decline(BENS))).resolves.toBeUndefined();
    expect(ben.slack.calls.at(-1)).toStrictEqual(told(BEN, DM_BEN, COPY.botRequestOnlyAdmin));
  });

  it('log lines carry an install, the request, a reason, a stage and a code: never a Slack id, an email, a name, an AX user id or the token', async () => {
    const all: Line[] = [];
    const runs: Array<[WorldOptions, Partial<BotRequestClick>]> = [
      [{}, {}],
      [{}, BENS],
      [{ axUsers: { [ADA_EMAIL]: null } }, {}],
      [{ slackUsers: { [ADA]: member(ADA, ADA_EMAIL, 'Ada Lovelace', { is_restricted: true }) } }, {}],
      [{ slackUsers: { [ADA]: new SlackApiError('users.info', 'ratelimited') } }, {}],
      [{ findUserFails: true }, {}],
      [{ getUserFails: true }, {}],
      [{ decline: async () => Promise.reject(new Error(`${ADA_EMAIL} ${ADA} usr_ada ${BOT_TOKEN}`)) }, {}],
      [{ decline: async () => ({ status: 404, body: { error: 'not-found' } }) }, {}],
      [{ ephemeralFails: new Error(`${DM_BEN} ${BEN}`) }, BENS],
      [{ botToken: null }, {}],
    ];
    for (const [options, who] of runs) {
      const w = world(options);
      await w.onBotRequestClick(SHARED, decline(who));
      all.push(...w.lines);
    }
    expect(all.length).toBeGreaterThanOrEqual(runs.length);

    for (const line of all) {
      // findSenderUser's own line (admission.ts) rides along on a miss.
      expect(line.msg).toMatch(/^slack_(?:bot_request_click_[a-z]+|sender_not_mapped)$/);
      for (const key of Object.keys(line.fields)) {
        expect(['installId', 'requestId', 'reason', 'stage', 'code']).toContain(key);
      }
    }
    const logged = JSON.stringify(all);
    for (const leak of [
      ADA,
      BEN,
      ADA_EMAIL,
      BEN_EMAIL,
      'Ada Lovelace',
      'Ben Okafor',
      'usr_ada',
      'usr_ben',
      DM_ADA,
      DM_BEN,
      DM_TS,
      TEAM_ID,
      BOT_TOKEN,
    ]) {
      expect(logged).not.toContain(leak);
    }
  });
});
