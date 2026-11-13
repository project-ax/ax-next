import { HookBus, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  admitSender,
  admitSlackUser,
  answerMention,
  findSenderUser,
  isTemporaryLookupFailure,
  screenEvent,
  type Admission,
  type Mention,
  type RefusalReason,
} from '../admission.js';
import { COPY } from '../copy.js';
import type { SlackEnvelope, SlackInnerEvent } from '../events.js';
import { EMAIL_MAX } from '../limits.js';
import { SlackApiError, type SlackApi } from '../slack-api.js';
import { fakeBotToken } from './fake-slack-tokens.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TEAM_ID = 'T07ABCDEF12';
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const BOT_USER_ID = 'U07BOTUSER1';
const ALICE = 'U07ALICE001';
const BOT_TOKEN = fakeBotToken('ADMISSIONTESTSECRET');
/** Mixed case on purpose: admission hands it on verbatim. */
const ALICE_EMAIL = 'Alice.Smith@CanopyWorks.com';

/** A users.info `user` for a full, confirmed member of the install's workspace. */
function member(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ALICE,
    team_id: TEAM_ID,
    name: 'alice',
    deleted: false,
    is_bot: false,
    is_app_user: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_email_confirmed: true,
    profile: { email: ALICE_EMAIL, real_name: 'Alice Smith' },
    ...over,
  };
}

const refused = (reason: RefusalReason): Admission => ({ ok: false, reason });

interface ApiCall {
  method: 'usersInfo' | 'postEphemeral';
  token: string;
  args: unknown;
}

/**
 * A SlackApi that answers users.info from `users` (an Error is thrown) and
 * records users.info and postEphemeral. Any other method is a test failure:
 * admission never streams, posts in a thread or touches the app.
 */
function fakeApi(users: Record<string, unknown> = { [ALICE]: member() }) {
  const calls: ApiCall[] = [];
  const notHere = async (): Promise<never> => {
    throw new Error('admission must not call this Slack method');
  };
  const api: SlackApi = {
    rotateConfigToken: notHere,
    createApp: notHere,
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    async usersInfo(token, userId) {
      calls.push({ method: 'usersInfo', token, args: userId });
      const user = users[userId];
      if (user instanceof Error) throw user;
      if (user === undefined) throw new SlackApiError('users.info', 'user_not_found');
      return user;
    },
    postMessage: notHere,
    async postEphemeral(token, a) {
      calls.push({ method: 'postEphemeral', token, args: a });
    },
    startStream: notHere,
    appendStream: notHere,
    stopStream: notHere,
  };
  return { api, calls };
}

function envelope(event: Partial<SlackInnerEvent> & { type: string }, ext = false): SlackEnvelope {
  return {
    teamId: TEAM_ID,
    apiAppId: 'A07QF9ZK2MN',
    eventId: 'Ev07ABCDEF12',
    isExtSharedChannel: ext,
    event,
  };
}

const DM = {
  type: 'message',
  channelType: 'im',
  user: ALICE,
  channel: 'D07DMCHANNEL',
  ts: '1763035200.000100',
  text: 'hello',
} as const;

const MENTION = {
  type: 'app_mention',
  user: ALICE,
  channel: 'C07GENERAL1',
  ts: '1763035300.000200',
  text: '<@U07BOTUSER1> hi',
} as const;

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

// ── admitSlackUser: who may talk to the bot, from users.info only ──────────

describe('admitSlackUser', () => {
  it('a full, confirmed member is admitted with their users.info email, verbatim', () => {
    expect(admitSlackUser(member(), TEAM_ID)).toEqual({ ok: true, email: ALICE_EMAIL, name: 'Alice Smith' });
  });

  it.each<[string, unknown, RefusalReason]>([
    // 1. Not an object.
    ['null', null, 'lookup-failed'],
    ['undefined', undefined, 'lookup-failed'],
    ['a string', ALICE, 'lookup-failed'],
    ['a number', 42, 'lookup-failed'],
    ['an array', [member()], 'lookup-failed'],
    // 2. Bots, Slackbot included (it has is_bot: false).
    ['Slackbot', member({ id: 'USLACKBOT', is_bot: false }), 'bot'],
    ['a bot user', member({ is_bot: true }), 'bot'],
    ['a workflow bot', member({ is_workflow_bot: true }), 'bot'],
    // 3. Deactivated.
    ['a deactivated account', member({ deleted: true }), 'deactivated'],
    // 4. Guests.
    ['a multi-channel guest', member({ is_restricted: true }), 'guest'],
    ['a single-channel guest', member({ is_ultra_restricted: true }), 'guest'],
    // 5. Another workspace (Slack Connect people, Grid org members).
    ['a stranger', member({ is_stranger: true }), 'other-workspace'],
    ['a member of another team', member({ team_id: 'T07OTHERTM9' }), 'other-workspace'],
    ['no team at all', member({ team_id: undefined }), 'other-workspace'],
    // 6. Invited, not yet joined.
    ['an invited user', member({ is_invited_user: true }), 'invited'],
    // 7. Email not confirmed: only a literal true passes.
    ['an unconfirmed email', member({ is_email_confirmed: false }), 'email-unconfirmed'],
    ['is_email_confirmed absent', member({ is_email_confirmed: undefined }), 'email-unconfirmed'],
    ['is_email_confirmed null', member({ is_email_confirmed: null }), 'email-unconfirmed'],
    ["is_email_confirmed 'true'", member({ is_email_confirmed: 'true' }), 'email-unconfirmed'],
    // 8. No usable email.
    ['no profile', member({ profile: undefined }), 'no-email'],
    ['a profile that is not an object', member({ profile: ALICE_EMAIL }), 'no-email'],
    ['no email in the profile', member({ profile: { real_name: 'Alice' } }), 'no-email'],
    ['an empty email', member({ profile: { email: '' } }), 'no-email'],
    ['an email that is not a string', member({ profile: { email: 42 } }), 'no-email'],
    [
      `an email over ${EMAIL_MAX} characters`,
      member({ profile: { email: `${'a'.repeat(EMAIL_MAX - 15)}@canopyworks.com` } }),
      'no-email',
    ],
  ])('refuses %s', (_name, user, reason) => {
    expect(admitSlackUser(user, TEAM_ID)).toEqual(refused(reason));
  });

  it('a refusing flag that is present but not a boolean fails closed', () => {
    expect(admitSlackUser(member({ is_bot: 1 }), TEAM_ID)).toEqual(refused('bot'));
    expect(admitSlackUser(member({ deleted: 'yes' }), TEAM_ID)).toEqual(refused('deactivated'));
    expect(admitSlackUser(member({ is_restricted: 'true' }), TEAM_ID)).toEqual(refused('guest'));
    expect(admitSlackUser(member({ is_stranger: {} }), TEAM_ID)).toEqual(refused('other-workspace'));
    expect(admitSlackUser(member({ is_invited_user: 'x' }), TEAM_ID)).toEqual(refused('invited'));
  });

  it('rule order: a deactivated guest is deactivated, and every rule beats all later ones', () => {
    expect(admitSlackUser(member({ deleted: true, is_restricted: true }), TEAM_ID)).toEqual(
      refused('deactivated'),
    );
    // Each rule's trigger, together with the triggers of every rule after it.
    const triggers: Array<[RefusalReason, Record<string, unknown>]> = [
      ['bot', { is_bot: true }],
      ['deactivated', { deleted: true }],
      ['guest', { is_restricted: true }],
      ['other-workspace', { team_id: 'T07OTHERTM9' }],
      ['invited', { is_invited_user: true }],
      ['email-unconfirmed', { is_email_confirmed: false }],
      ['no-email', { profile: {} }],
    ];
    triggers.forEach(([reason], i) => {
      const user = Object.assign(member(), ...triggers.slice(i).map(([, t]) => t));
      expect(admitSlackUser(user, TEAM_ID), reason).toEqual(refused(reason));
    });
  });

  it('is_app_user on a normal member is admitted: it means "authorized this app", not a bot', () => {
    expect(admitSlackUser(member({ is_app_user: true }), TEAM_ID)).toEqual({ ok: true, email: ALICE_EMAIL, name: 'Alice Smith' });
  });

  it('refusing flags that are false, null or absent do not refuse', () => {
    const absent = member();
    for (const key of ['deleted', 'is_bot', 'is_restricted', 'is_ultra_restricted']) delete absent[key];
    expect(admitSlackUser(absent, TEAM_ID)).toEqual({ ok: true, email: ALICE_EMAIL, name: 'Alice Smith' });
    expect(
      admitSlackUser(member({ is_workflow_bot: null, is_stranger: false, is_invited_user: null }), TEAM_ID),
    ).toEqual({ ok: true, email: ALICE_EMAIL, name: 'Alice Smith' });
  });

  it('the display name comes along for the label: display name, else full name, cleaned', () => {
    const named = (profile: Record<string, unknown>, over: Record<string, unknown> = {}) =>
      admitSlackUser(member({ ...over, profile: { email: ALICE_EMAIL, ...profile } }), TEAM_ID);
    expect(named({ display_name: 'ali', real_name: 'Alice Smith' })).toMatchObject({ ok: true, name: 'ali' });
    expect(named({ display_name: '  ', real_name: 'Alice Smith' })).toMatchObject({ ok: true, name: 'Alice Smith' });
    expect(named({}, { real_name: 'Top Level' })).toMatchObject({ ok: true, name: 'Top Level' });
    expect(named({ display_name: 42 })).toMatchObject({ ok: true, name: '' });
    const rlo = String.fromCharCode(0x202e);
    expect(named({ display_name: `[Bob]\n(x)${rlo}y` })).toMatchObject({ ok: true, name: 'Bob x y' });
    // The name never changes who is admitted, or with what email.
    expect(named({ display_name: 'ceo@canopyworks.com' })).toEqual({ ok: true, email: ALICE_EMAIL, name: 'ceo@canopyworks.com' });
  });

  it(`an email of exactly ${EMAIL_MAX} characters is admitted, untrimmed and not lowercased`, () => {
    const longest = `${'A'.repeat(EMAIL_MAX - 16)}@CanopyWorks.com`;
    expect(longest).toHaveLength(EMAIL_MAX);
    expect(admitSlackUser(member({ profile: { email: longest } }), TEAM_ID)).toEqual({ ok: true, email: longest, name: '' });
    expect(admitSlackUser(member({ profile: { email: ' a@b.c ' } }), TEAM_ID)).toEqual({ ok: true, email: ' a@b.c ', name: '' });
  });
});

// ── admitSender: one users.info call with the bot token ─────────────────────

describe('admitSender', () => {
  it('admitSender maps users.info errors to lookup-failed and passes the bot token', async () => {
    const { api, calls } = fakeApi({
      [ALICE]: new SlackApiError('users.info', 'ratelimited', 2_000),
      U07NETWORK1: new SlackApiError('users.info', 'network'),
      U07PLAINERR: new Error('socket hang up, token=do-not-log-me'),
    });
    expect(await admitSender(api, BOT_TOKEN, ALICE, TEAM_ID)).toEqual({
      ok: false,
      reason: 'lookup-failed',
      code: 'ratelimited',
    });
    expect(await admitSender(api, BOT_TOKEN, 'U07NETWORK1', TEAM_ID)).toEqual({
      ok: false,
      reason: 'lookup-failed',
      code: 'network',
    });
    // Code-only: never an error's message.
    const plain = await admitSender(api, BOT_TOKEN, 'U07PLAINERR', TEAM_ID);
    expect(plain).toMatchObject({ ok: false, reason: 'lookup-failed' });
    expect(JSON.stringify(plain)).not.toContain('do-not-log-me');
    // Slack's own "no such user" is a lookup failure too.
    expect(await admitSender(api, BOT_TOKEN, 'U07NOBODY01', TEAM_ID)).toEqual({
      ok: false,
      reason: 'lookup-failed',
      code: 'user_not_found',
    });

    expect(calls.map((c) => [c.method, c.token, c.args])).toEqual([
      ['usersInfo', BOT_TOKEN, ALICE],
      ['usersInfo', BOT_TOKEN, 'U07NETWORK1'],
      ['usersInfo', BOT_TOKEN, 'U07PLAINERR'],
      ['usersInfo', BOT_TOKEN, 'U07NOBODY01'],
    ]);
  });

  it("admits a member with users.info's email, and refuses by the same rules", async () => {
    const { api } = fakeApi({
      [ALICE]: member(),
      U07GUEST001: member({ id: 'U07GUEST001', is_restricted: true }),
    });
    expect(await admitSender(api, BOT_TOKEN, ALICE, TEAM_ID)).toEqual({ ok: true, email: ALICE_EMAIL, name: 'Alice Smith' });
    expect(await admitSender(api, BOT_TOKEN, 'U07GUEST001', TEAM_ID)).toEqual(refused('guest'));
  });

  it('an answer about someone other than the sender is a lookup failure, never an admission', async () => {
    // users.info for Mallory answering with Alice's record must not hand
    // Mallory Alice's email (and so Alice's agent).
    const { api } = fakeApi({ U07MALLORY1: member() });
    expect(await admitSender(api, BOT_TOKEN, 'U07MALLORY1', TEAM_ID)).toEqual({
      ok: false,
      reason: 'lookup-failed',
      code: 'user-mismatch',
    });
  });
});

describe('isTemporaryLookupFailure', () => {
  // Our client's own codes for "Slack, or the way to it, was briefly not there".
  it.each(['ratelimited', 'timeout', 'network', 'http-500', 'http-502', 'http-503', 'http-504', 'http-599'])(
    'a users.info %s says nothing about the sender: temporary',
    (code) => {
      expect(isTemporaryLookupFailure({ ok: false, reason: 'lookup-failed', code })).toBe(true);
    },
  );

  // Slack's own `ok: false` codes for "we had a problem, not you" — documented
  // as transient on every Web API method. They arrive as plain codes on an
  // HTTP 200, so the http-5xx row above never sees them.
  it.each(['internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])(
    "a users.info %s is Slack's own transient failure: temporary",
    (code) => {
      expect(isTemporaryLookupFailure({ ok: false, reason: 'lookup-failed', code })).toBe(true);
    },
  );

  // About the install or the account (a retry won't fix it), or an answer we couldn't trust.
  it.each([
    'token_revoked',
    'invalid_auth',
    'account_inactive',
    'user_not_found',
    'user-mismatch',
    'bad-response',
    'too-large',
    'redirect',
    'slack-error',
    'unknown',
    'http-404',
    'http-429',
    'http-50',
    'http-5000',
    'xhttp-503',
    'internal_errors',
    'not_internal_error',
  ])('a users.info %s is not temporary', (code) => {
    expect(isTemporaryLookupFailure({ ok: false, reason: 'lookup-failed', code })).toBe(false);
  });

  it('a refusal, a lookup failure with no code, and an admission are never temporary', () => {
    expect(isTemporaryLookupFailure({ ok: false, reason: 'lookup-failed' })).toBe(false);
    expect(isTemporaryLookupFailure({ ok: false, reason: 'guest' })).toBe(false);
    expect(isTemporaryLookupFailure({ ok: false, reason: 'guest', code: 'ratelimited' })).toBe(false);
    expect(isTemporaryLookupFailure({ ok: true, email: ALICE_EMAIL, name: 'Alice' })).toBe(false);
  });
});

// ── screenEvent: where the bot answers at all, before any Slack call ───────

describe('screenEvent', () => {
  const install = { botUserId: BOT_USER_ID };

  it('a DM from a person is a DM, threaded on its own ts at the top level', () => {
    expect(screenEvent(install, envelope(DM))).toEqual({
      kind: 'dm',
      sender: ALICE,
      channel: 'D07DMCHANNEL',
      ts: DM.ts,
      threadTs: DM.ts,
      text: 'hello',
      fileShare: false,
    });
  });

  it('a reply in a DM thread keys on thread_ts, and missing text reads as empty', () => {
    const { text: _text, ...noText } = DM;
    expect(screenEvent(install, envelope({ ...noText, threadTs: '1763035100.000050' }))).toMatchObject({
      kind: 'dm',
      // The message itself (where 👀 goes) keeps its own ts.
      ts: DM.ts,
      threadTs: '1763035100.000050',
      text: '',
    });
  });

  it('a file shared in a DM is a DM flagged as a file share', () => {
    expect(screenEvent(install, envelope({ ...DM, subtype: 'file_share' }))).toMatchObject({
      kind: 'dm',
      fileShare: true,
    });
  });

  it('a mention is a mention, carrying thread_ts only when it was in a thread', () => {
    expect(screenEvent(install, envelope(MENTION))).toEqual({
      kind: 'mention',
      sender: ALICE,
      channel: 'C07GENERAL1',
    });
    expect(screenEvent(install, envelope({ ...MENTION, threadTs: '1763035000.000010' }))).toEqual({
      kind: 'mention',
      sender: ALICE,
      channel: 'C07GENERAL1',
      threadTs: '1763035000.000010',
    });
  });

  it('Slack Connect: nothing in a channel shared with another company is answered, DM or mention', () => {
    expect(screenEvent(install, envelope(DM, true))).toEqual({ kind: 'ignore', reason: 'slack-connect' });
    expect(screenEvent(install, envelope(MENTION, true))).toEqual({ kind: 'ignore', reason: 'slack-connect' });
  });

  it('bots: no sender, a bot_id, or our own bot user is never answered', () => {
    const { user: _user, ...noUser } = DM;
    expect(screenEvent(install, envelope(noUser))).toEqual({ kind: 'ignore', reason: 'bot' });
    expect(screenEvent(install, envelope({ ...DM, botId: 'B07OTHERBOT' }))).toEqual({ kind: 'ignore', reason: 'bot' });
    expect(screenEvent(install, envelope({ ...DM, user: BOT_USER_ID }))).toEqual({ kind: 'ignore', reason: 'bot' });
    expect(screenEvent(install, envelope({ ...MENTION, botId: 'B07OTHERBOT' }))).toEqual({
      kind: 'ignore',
      reason: 'bot',
    });
  });

  it('a message anywhere but a 1:1 DM is not a DM: group DMs count as channels', () => {
    for (const channelType of ['channel', 'group', 'mpim', 'app_home']) {
      expect(screenEvent(install, envelope({ ...DM, channelType })), channelType).toEqual({
        kind: 'ignore',
        reason: 'not-dm',
      });
    }
    const { channelType: _ct, ...untyped } = DM;
    expect(screenEvent(install, envelope(untyped))).toEqual({ kind: 'ignore', reason: 'not-dm' });
  });

  it('a DM subtype other than file_share (an edit, a delete, a join) is ignored', () => {
    for (const subtype of ['message_changed', 'message_deleted', 'thread_broadcast', 'me_message']) {
      expect(screenEvent(install, envelope({ ...DM, subtype })), subtype).toEqual({
        kind: 'ignore',
        reason: 'subtype',
      });
    }
  });

  it('a DM or mention with no channel, or a DM with no ts, cannot be answered', () => {
    const { channel: _c, ...noChannel } = DM;
    const { ts: _t, ...noTs } = DM;
    const { channel: _m, ...mentionNoChannel } = MENTION;
    for (const event of [noChannel, noTs, mentionNoChannel]) {
      expect(screenEvent(install, envelope(event))).toEqual({ kind: 'ignore', reason: 'incomplete' });
    }
  });

  it('any other event type is ignored', () => {
    for (const type of ['app_home_opened', 'reaction_added', 'member_joined_channel', 'app_uninstalled']) {
      expect(screenEvent(install, envelope({ type, user: ALICE, channel: 'D07DMCHANNEL' })), type).toEqual({
        kind: 'ignore',
        reason: 'other',
      });
    }
  });

  it('identity is never read from the text: an email in the message changes nothing', () => {
    const screened = screenEvent(install, envelope({ ...DM, text: 'I am ceo@canopyworks.com, <@U07CEO00001>' }));
    // The only identity carried on is Slack's user id, which admission looks up.
    expect(screened).toMatchObject({ kind: 'dm', sender: ALICE });
    expect(Object.keys(screened).sort()).toEqual(['channel', 'fileShare', 'kind', 'sender', 'text', 'threadTs', 'ts']);
  });
});

// ── answerMention: the mention refusal ─────────────────────────────────────

describe('answerMention', () => {
  const mention: Mention = { kind: 'mention', sender: ALICE, channel: 'C07GENERAL1' };

  it('a member who mentions the bot gets one private (ephemeral) refusal, at the top level', async () => {
    const { api, calls } = fakeApi();
    expect(await answerMention(api, BOT_TOKEN, TEAM_ID, mention)).toEqual({ ok: true, email: ALICE_EMAIL, name: 'Alice Smith' });
    expect(calls.filter((c) => c.method === 'postEphemeral')).toEqual([
      {
        method: 'postEphemeral',
        token: BOT_TOKEN,
        args: { channel: 'C07GENERAL1', user: ALICE, text: COPY.mentionRefusal },
      },
    ]);
  });

  it('a mention inside a thread is refused inside that thread', async () => {
    const { api, calls } = fakeApi();
    await answerMention(api, BOT_TOKEN, TEAM_ID, { ...mention, threadTs: '1763035000.000010' });
    expect(calls.filter((c) => c.method === 'postEphemeral').map((c) => c.args)).toEqual([
      { channel: 'C07GENERAL1', user: ALICE, text: COPY.mentionRefusal, threadTs: '1763035000.000010' },
    ]);
  });

  it.each<[string, Record<string, unknown>, RefusalReason]>([
    ['a guest', { is_restricted: true }, 'guest'],
    ['a single-channel guest', { is_ultra_restricted: true }, 'guest'],
    ['a bot', { is_bot: true }, 'bot'],
    ['a deactivated account', { deleted: true }, 'deactivated'],
    ['someone from another workspace', { is_stranger: true }, 'other-workspace'],
    ['an invited user', { is_invited_user: true }, 'invited'],
    ['an unconfirmed email', { is_email_confirmed: false }, 'email-unconfirmed'],
    ['no email', { profile: {} }, 'no-email'],
  ])('%s who mentions the bot gets silence', async (_name, over, reason) => {
    const { api, calls } = fakeApi({ [ALICE]: member(over) });
    expect(await answerMention(api, BOT_TOKEN, TEAM_ID, mention)).toEqual(refused(reason));
    expect(calls.map((c) => c.method)).toEqual(['usersInfo']);
  });

  it('a users.info failure is silence too, never a guess', async () => {
    const { api, calls } = fakeApi({ [ALICE]: new SlackApiError('users.info', 'invalid_auth') });
    expect(await answerMention(api, BOT_TOKEN, TEAM_ID, mention)).toEqual({
      ok: false,
      reason: 'lookup-failed',
      code: 'invalid_auth',
    });
    expect(calls.map((c) => c.method)).toEqual(['usersInfo']);
  });
});

// ── findSenderUser: the verified email to an AX account ─────────────────────

describe('findSenderUser', () => {
  function authBus(answer: (email: string) => unknown) {
    const bus = new HookBus();
    const asked: Array<{ email: unknown; ctx: AgentContext }> = [];
    bus.registerService('auth:find-user-by-email', 'stub-auth', async (ctx, input) => {
      const email = (input as { email: unknown }).email;
      asked.push({ email, ctx });
      return answer(email as string);
    });
    return { bus, asked };
  }
  const ctx = (): AgentContext => makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: '' });

  it('a mapped sender comes back as their user id, with nothing logged', async () => {
    const { bus, asked } = authBus(() => ({ userId: 'usr_alice' }));
    const { logger, lines } = recordingLogger();
    const c = ctx();
    expect(await findSenderUser(bus, c, ALICE_EMAIL, { installId: INSTALL_ID, logger })).toBe('usr_alice');
    // The email goes as admission gave it, under the caller's ctx.
    expect(asked).toEqual([{ email: ALICE_EMAIL, ctx: c }]);
    expect(lines).toEqual([]);
  });

  it('every null logs slack_sender_not_mapped with the install id only, never the email', async () => {
    const { bus } = authBus(() => null);
    const { logger, lines } = recordingLogger();
    for (let i = 0; i < 2; i += 1) {
      expect(await findSenderUser(bus, ctx(), ALICE_EMAIL, { installId: INSTALL_ID, logger })).toBeNull();
    }
    expect(lines).toEqual([
      { level: 'info', msg: 'slack_sender_not_mapped', fields: { installId: INSTALL_ID } },
      { level: 'info', msg: 'slack_sender_not_mapped', fields: { installId: INSTALL_ID } },
    ]);
    expect(JSON.stringify(lines)).not.toContain('CanopyWorks');
  });

  it('an answer that is not exactly a user id fails closed as not mapped', async () => {
    for (const answer of [undefined, {}, { userId: '' }, { userId: 42 }, 'usr_alice', [{ userId: 'usr_alice' }]]) {
      const { bus } = authBus(() => answer);
      const { logger, lines } = recordingLogger();
      expect(await findSenderUser(bus, ctx(), ALICE_EMAIL, { installId: INSTALL_ID, logger }), JSON.stringify(answer)).toBeNull();
      expect(lines.map((l) => l.msg)).toEqual(['slack_sender_not_mapped']);
    }
  });

  it('a failing lookup throws to the caller and is not reported as not mapped', async () => {
    const { bus } = authBus(() => {
      throw new Error('database down');
    });
    const { logger, lines } = recordingLogger();
    await expect(findSenderUser(bus, ctx(), ALICE_EMAIL, { installId: INSTALL_ID, logger })).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it('a logger that throws does not change the answer', async () => {
    const { bus } = authBus(() => null);
    const { logger } = recordingLogger();
    const throwing: Logger = { ...logger, info: () => { throw new Error('stdout closed'); } };
    expect(await findSenderUser(bus, ctx(), ALICE_EMAIL, { installId: INSTALL_ID, logger: throwing })).toBeNull();
  });
});
