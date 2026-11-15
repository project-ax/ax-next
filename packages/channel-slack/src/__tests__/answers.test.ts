import { DEFAULT_SERVICE_TIMEOUT_MS, HookBus, PluginError, type AgentContext, type Logger } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClickHandler, type Answer, type AnswerDeps, type SubjectAnswer } from '../answers.js';
import { promptBlocks, type PromptAction } from '../blocks.js';
import type { ChannelStore } from '../channel-store.js';
import { COPY } from '../copy.js';
import { createDecisionAnswer } from '../decision-answer.js';
import { createHostAnswer, createSkillAnswer } from '../permission-prompts.js';
import type { ButtonClick } from '../interactions.js';
import { PROMPT_MAX, PROMPT_STEP_TIMEOUT_MS, PROMPT_TTL_MS } from '../limits.js';
import {
  createPromptRegistry,
  type Prompt,
  type PromptContext,
  type PromptRegistry,
  type PromptSubject,
} from '../prompts.js';
import type { SecretName, SecretStore } from '../secrets.js';
import { SlackApiError, type SlackApi } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import type { ContinuationRequest } from '../turn.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { memoryChannelStore } from './memory-channel-store.js';

/*
  The click gate (answers.ts), through the ClickHandler the interactions
  route hands each click to. The rules pinned here: only the person whose
  turn it was can answer a prompt, proved again from Slack and AX on every
  click and never from the message; each step refuses on its own; one
  answer per prompt; a bystander's click never takes the prompt's lock;
  every step has a deadline; a prompt is redrawn only with COPY lines; and
  logs carry codes, never ids, emails or text.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const PUBLIC_ORIGIN = 'https://ax.example';
/** Today in the web app, where a prompt's request also waits. */
const TODAY = 'https://ax.example/workspace';
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const TEAM_ID = 'T07ABCDEF12';
const BOT_TOKEN = fakeBotToken('ANSWERSTESTSECRET');

const INSTALL: InstallRow = {
  installId: INSTALL_ID,
  status: 'active',
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: TEAM_ID,
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_admin',
  createdAt: new Date('2026-11-13T10:00:00Z'),
  installedAt: new Date('2026-11-13T10:05:00Z'),
};
/** A second install for the same workspace: its own app, its own prompts. */
const OTHER_INSTALL: InstallRow = { ...INSTALL, installId: 'Wd3sQ8nLz1Kc6Vb0Xp4TrA', appId: 'A07OTHERAPP' };

/** Mel: whose turn it was, in her DM and in #support. */
const MEL = 'U07MEL00001';
/** Ada and Ben: members of the support team too, reading Mel's thread in #support. */
const ADA = 'U07ADA00001';
const BEN = 'U07BEN00001';
const DM_MEL = 'D07DMMEL001';
const SUPPORT = 'C07SUPPORT1';
const RANDOM = 'C07RANDOM01';
/** The thread the prompt was posted in, and the prompt message itself. */
const THREAD_TS = '1763121600.000100';
const PROMPT_TS = '1763121660.000200';
/** An id shaped like a prompt's that no registry ever minted. */
const NEVER_MINTED = 'Rk2pX9vQ_mL4wT7nB1cZ-A';

/** A users.info `user`, as Slack answers it for a full member with a confirmed email. */
function member(id: string, email: string, over: Record<string, unknown> = {}) {
  return {
    id,
    team_id: TEAM_ID,
    deleted: false,
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_email_confirmed: true,
    profile: { email, real_name: id, display_name: '' },
    ...over,
  };
}

const MEL_EMAIL = 'mel@canopyworks.com';
const SLACK_USERS: Record<string, unknown> = {
  [MEL]: member(MEL, MEL_EMAIL),
  [ADA]: member(ADA, 'ada@canopyworks.com'),
  [BEN]: member(BEN, 'ben@canopyworks.com'),
};
/** auth:find-user-by-email's answer, by the email exactly as users.info gave it. Null: no account. */
const AX_USERS: Record<string, string | null> = {
  [MEL_EMAIL]: 'usr_mel',
  'ada@canopyworks.com': 'usr_ada',
  'ben@canopyworks.com': 'usr_ben',
};

const SUPPORT_TEAM = 'team_support';
const MEL_AGENT: FakeAgent = {
  id: 'agt_mel',
  displayName: 'Mel',
  visibility: 'personal',
  ownerType: 'user',
  ownerId: 'usr_mel',
};
const SUPPORT_AGENT: FakeAgent = {
  id: 'agt_support',
  displayName: 'Support',
  visibility: 'team',
  ownerType: 'team',
  ownerId: SUPPORT_TEAM,
};
/** Another of the support team's agents: a channel can be connected to it instead. */
const OPS_AGENT: FakeAgent = { ...SUPPORT_AGENT, id: 'agt_ops', displayName: 'Ops' };

/** Mel's DM turn that held a call. */
const MEL_DM: PromptContext = {
  installId: INSTALL_ID,
  teamId: TEAM_ID,
  channel: DM_MEL,
  threadTs: THREAD_TS,
  askerSlackId: MEL,
  userId: 'usr_mel',
  agentId: 'agt_mel',
  conversationId: 'conv_mel_dm',
  mode: 'dm',
};
/** Mel's attended turn in #support, which is connected to the support team's agent. */
const MEL_SUPPORT: PromptContext = {
  ...MEL_DM,
  channel: SUPPORT,
  agentId: 'agt_support',
  conversationId: 'conv_mel_support',
  mode: 'attended',
};

const HELD: PromptSubject = { kind: 'decision', decisionId: 'dec_0001' };
/** A decision's host-authored summary, exactly as the turn handed it to promptBlocks. */
const SUMMARY = 'Wants to gain access to a new service or key';

/** The prompt redrawn with `line`, as Slack should get it: the subject, then the line, and nothing to click. */
function redrawn(channel: string, line: string, ts = PROMPT_TS) {
  return {
    channel,
    ts,
    text: line,
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: SUMMARY, emoji: false } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
    ],
  };
}

/** A private line to `user` in the prompt's thread. */
function told(channel: string, user: string, text: string) {
  return { method: 'postEphemeral', token: BOT_TOKEN, args: { channel, user, text, threadTs: THREAD_TS } };
}

const MEL_LOOKED_UP = { method: 'usersInfo', token: BOT_TOKEN, args: { user: MEL } };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A promise that never settles: a hung call. */
const never = (): Promise<never> => new Promise<never>(() => {});

// ── The fake Slack ──────────────────────────────────────────────────────────

type Method = keyof SlackApi;
interface SlackCall {
  method: Method;
  token: string;
  args: Record<string, unknown>;
}

function fakeSlack(o: { users: Record<string, unknown>; hang?: Method; hold?: { method: Method; until: Promise<void> } }) {
  const calls: SlackCall[] = [];
  let held = false;
  const record = async (method: Method, token: string, args: Record<string, unknown>): Promise<void> => {
    calls.push({ method, token, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
    if (o.hang === method) await never();
    if (o.hold?.method === method && !held) {
      held = true;
      await o.hold.until;
    }
  };
  /** A method the gate must never call: recorded too, so an exact call list shows it. */
  const notHere =
    (method: Method) =>
    async (): Promise<never> => {
      calls.push({ method, token: '', args: {} });
      throw new Error(`the click gate must not call ${method}`);
    };
  const api: SlackApi = {
    rotateConfigToken: notHere('rotateConfigToken'),
    createApp: notHere('createApp'),
    updateApp: notHere('updateApp'),
    deleteApp: notHere('deleteApp'),
    setAppIcon: notHere('setAppIcon'),
    oauthAccess: notHere('oauthAccess'),
    async usersInfo(token, user) {
      await record('usersInfo', token, { user });
      const answer = o.users[user];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new SlackApiError('users.info', 'user_not_found');
      return answer;
    },
    postMessage: notHere('postMessage'),
    postBlocks: notHere('postBlocks'),
    async updateMessage(token, a) {
      await record('updateMessage', token, { ...a });
    },
    async postEphemeral(token, a) {
      await record('postEphemeral', token, { ...a });
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

interface Run {
  ctx: AgentContext;
  prompt: Prompt;
  action: PromptAction;
  extra: { install: InstallRow; botToken: string; messageTs: string | null };
}

type Fault = 'fails' | 'hang';

interface WorldOptions {
  /** users.info's answers by Slack id, over SLACK_USERS. An Error is thrown. */
  slackUsers?: Record<string, unknown>;
  /** auth:find-user-by-email's answers by email, over AX_USERS. */
  axUsers?: Record<string, string | null>;
  /** The vault's answer for the bot token: one, none, a failure, or a read that never ends. */
  botToken?: string | null | Error | 'hang';
  findUser?: Fault;
  resolve?: Fault;
  binding?: Fault;
  /** This Slack method never answers. */
  slackHang?: Method;
  /** The first call of this Slack method answers only once `until` settles. */
  slackHold?: { method: Method; until: Promise<void> };
  /** What the decision answer gives back; `n` is its run (1-based). Its default: Allowed or Denied, settled. */
  answer?: (n: number) => Answer | Promise<Answer>;
  /** The answers by subject kind, instead of the recording decision answer. */
  answers?: AnswerDeps['answers'];
  /** The answers by subject kind, built on the world's bus (the real decision answer, say). Over `answers`. */
  answersOn?: (bus: HookBus) => AnswerDeps['answers'];
  /** More services on the world's bus, beside auth and agents (a fake @ax/decisions, say). */
  services?: (bus: HookBus) => void;
  /** Wrap the real registry (a broken one, say). */
  registry?: (real: PromptRegistry) => PromptRegistry;
}

const fault = (plugin: string) =>
  new PluginError({ code: 'store-unavailable', plugin, message: `${plugin} down: ${MEL_EMAIL}` });

async function world(o: WorldOptions = {}) {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields: { ...fields } });
  };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };

  // The bus never reports a stall of its own: a hung fake is the test's point.
  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const findUser: Array<{ ctx: AgentContext; email: unknown }> = [];
  bus.registerService('auth:find-user-by-email', 'fake-auth', async (ctx, input) => {
    const email = (input as { email: unknown }).email;
    findUser.push({ ctx, email });
    if (o.findUser === 'hang') return never();
    if (o.findUser === 'fails') throw fault('fake-auth');
    const users: Record<string, string | null> = { ...AX_USERS, ...o.axUsers };
    const userId = typeof email === 'string' ? users[email] : undefined;
    return typeof userId === 'string' ? { userId } : null;
  });

  // agents:resolve answered the way @ax/agents answers it (fake-agents.ts),
  // behind a door this world can jam or break.
  const agentsBus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const agents = fakeAgents(agentsBus);
  agents.addAgent(MEL_AGENT);
  agents.addAgent(SUPPORT_AGENT);
  agents.addAgent(OPS_AGENT);
  agents.setRole(SUPPORT_TEAM, 'usr_mel', 'member');
  agents.setRole(SUPPORT_TEAM, 'usr_ada', 'member');
  agents.setRole(SUPPORT_TEAM, 'usr_ben', 'member');
  const resolved: Array<{ ctx: AgentContext; input: unknown }> = [];
  bus.registerService('agents:resolve', 'fake-agents', async (ctx, input) => {
    resolved.push({ ctx, input });
    if (o.resolve === 'hang') return never();
    if (o.resolve === 'fails') throw fault('fake-agents');
    return agentsBus.call('agents:resolve', ctx, input);
  });
  o.services?.(bus);

  // #support is connected to the support team's agent.
  const channels = memoryChannelStore();
  await channels.store.upsert({
    installId: INSTALL_ID,
    channelId: SUPPORT,
    agentId: SUPPORT_AGENT.id,
    connectedByUserId: 'usr_ada',
    channelName: 'support',
  });
  const bindingReads: Array<[string, string]> = [];
  const channelStore: Pick<ChannelStore, 'get'> = {
    async get(installId, channelId) {
      bindingReads.push([installId, channelId]);
      if (o.binding === 'hang') return never();
      if (o.binding === 'fails') throw new Error(`database down reading ${channelId}`);
      return channels.store.get(installId, channelId);
    },
  };

  const vault: Array<{ installId: string; name: SecretName }> = [];
  const secrets: Pick<SecretStore, 'get'> = {
    async get(install, name) {
      vault.push({ installId: install.installId, name });
      const answer = o.botToken === undefined ? BOT_TOKEN : o.botToken;
      if (answer === 'hang') return never();
      if (answer instanceof Error) throw answer;
      return name === 'bot-token' ? answer : null;
    },
  };

  const slack = fakeSlack({
    users: { ...SLACK_USERS, ...o.slackUsers },
    ...(o.slackHang ? { hang: o.slackHang } : {}),
    ...(o.slackHold ? { hold: o.slackHold } : {}),
  });

  let nowMs = Date.parse('2026-11-14T12:00:00.000Z');
  let minted = 0;
  const real = createPromptRegistry({
    now: () => nowMs,
    // Call n of randomBytes fills every byte with n: one id per prompt, the same every run.
    randomBytes: (size) => Buffer.alloc(size, ++minted),
    ttlMs: PROMPT_TTL_MS,
    max: PROMPT_MAX,
  });
  const prompts = o.registry === undefined ? real : o.registry(real);

  const runs: Run[] = [];
  const decision: SubjectAnswer = async (ctx, prompt, action, extra) => {
    runs.push({ ctx, prompt, action, extra });
    if (o.answer !== undefined) return o.answer(runs.length);
    return { line: action === 'deny' ? COPY.decisionDenied : COPY.decisionAllowed, settle: true };
  };

  const onClick = createClickHandler({
    bus,
    api: slack.api,
    secrets,
    prompts,
    channels: channelStore,
    publicOrigin: PUBLIC_ORIGIN,
    logger,
    answers: o.answersOn?.(bus) ?? o.answers ?? { decision },
  });

  return {
    onClick,
    slack,
    lines,
    runs,
    findUser,
    resolved,
    bindingReads,
    vault,
    agents,
    channels,
    /** Open a prompt for the turn `c`, recorded as posted at PROMPT_TS unless `posted` is false. */
    open(c: PromptContext = MEL_DM, p: { subject?: PromptSubject; subjectText?: string; posted?: boolean } = {}): Prompt {
      const prompt = real.add(c, p.subject ?? HELD, p.subjectText ?? SUMMARY);
      if (p.posted !== false) real.posted(prompt.id, PROMPT_TS);
      return prompt;
    },
    /** Mel's click on Allow on `prompt`, as the interactions route reads one. */
    clickOn(prompt: Prompt, over: Partial<ButtonClick> = {}): ButtonClick {
      return {
        slackUserId: MEL,
        channel: prompt.channel,
        messageTs: PROMPT_TS,
        threadTs: THREAD_TS,
        action: 'allow',
        promptId: prompt.id,
        ...over,
      };
    },
    /** The prompt as its asker would find it now, left exactly as it was. */
    state(prompt: Prompt): 'open' | 'busy' | 'gone' {
      const claim = real.claim(prompt.id, prompt.askerSlackId);
      if (claim.ok) {
        real.release(prompt.id);
        return 'open';
      }
      return claim.reason === 'busy' ? 'busy' : 'gone';
    },
    /** Move the registry's clock. */
    later(ms: number): void {
      nowMs += ms;
    },
    /** The fields of every line logged as `msg`, in order. */
    logged(msg: string): Array<Record<string, unknown>> {
      return lines.filter((l) => l.msg === msg).map((l) => l.fields);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── The asker's own click ───────────────────────────────────────────────────

describe('the click gate: the asker answers', () => {
  it("Mel's Allow on her DM prompt: the answer runs once, as the prompt's user, agent and conversation; the prompt shows its line in place of the buttons, and is settled", async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.runs).toHaveLength(1);
    const run = w.runs[0]!;
    expect(run.prompt.id).toBe(prompt.id);
    expect(run.action).toBe('allow');
    expect(run.extra.install).toBe(INSTALL);
    expect(run.extra.botToken).toBe(BOT_TOKEN);
    // The message it redraws, for whatever follows the answer to redraw again.
    expect(run.extra.messageTs).toBe(PROMPT_TS);
    expect({
      sessionId: run.ctx.sessionId,
      userId: run.ctx.userId,
      agentId: run.ctx.agentId,
      conversationId: run.ctx.conversationId,
    }).toEqual({ sessionId: 'channel-slack', userId: 'usr_mel', agentId: 'agt_mel', conversationId: 'conv_mel_dm' });
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.decisionAllowed) },
    ]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_answered')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', action: 'allow', settled: true },
    ]);
  });

  it("proves who Mel is from users.info's email and AX, and reads no channel binding for a DM", async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.vault).toEqual([{ installId: INSTALL_ID, name: 'bot-token' }]);
    expect(w.findUser.map((f) => f.email)).toEqual([MEL_EMAIL]);
    expect(w.resolved.map((r) => r.input)).toEqual([{ agentId: 'agt_mel', userId: 'usr_mel' }]);
    expect(w.bindingReads).toEqual([]);
  });

  it("Mel's Deny on her prompt in #support: handed to the answer as deny, once #support is still connected to the agent", async () => {
    const w = await world();
    const prompt = w.open(MEL_SUPPORT);

    await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));

    expect(w.runs.map((r) => [r.action, r.ctx.userId, r.ctx.agentId, r.ctx.conversationId])).toEqual([
      ['deny', 'usr_mel', 'agt_support', 'conv_mel_support'],
    ]);
    expect(w.bindingReads).toEqual([[INSTALL_ID, SUPPORT]]);
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(SUPPORT, COPY.decisionDenied) },
    ]);
    expect(w.state(prompt)).toBe('gone');
  });

  it('the redrawn prompt shows its subject exactly as the prompt drew it: from the raw subject, cleaned once', async () => {
    const hostile = '<!channel> approve @here, &#64;everyone';
    const w = await world();
    const prompt = w.open(MEL_DM, { subjectText: hostile });

    await w.onClick(INSTALL, w.clickOn(prompt));

    const update = w.slack.calls.find((c) => c.method === 'updateMessage');
    const asked = promptBlocks({ subject: hostile, promptId: prompt.id, todayLink: TODAY });
    expect((update?.args['blocks'] as unknown[])[0]).toEqual(asked.blocks[0]);
  });
});

// ── Anyone else's click ─────────────────────────────────────────────────────

describe('the click gate: anyone else is refused (card acceptance)', () => {
  it("Ada's clicks on Mel's prompt: one private 'only the asker' line, no users.info, no AX lookup, no answer; her second click says nothing", async () => {
    const w = await world();
    const prompt = w.open(MEL_SUPPORT);

    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: ADA }));
    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: ADA, action: 'deny' }));

    expect(w.slack.calls).toEqual([told(SUPPORT, ADA, COPY.promptOnlyAsker)]);
    expect(w.runs).toEqual([]);
    expect(w.findUser).toEqual([]);
    expect(w.resolved).toEqual([]);
    expect(w.bindingReads).toEqual([]);
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', reason: 'not-asker' },
      { installId: INSTALL_ID, kind: 'decision', reason: 'not-asker' },
    ]);
    // Still Mel's to answer.
    expect(w.state(prompt)).toBe('open');
    await w.onClick(INSTALL, w.clickOn(prompt));
    expect(w.runs).toHaveLength(1);
  });

  it("a bystander's click never takes the lock: Ada before Mel, Ben while Mel's answer runs; Mel's click answers exactly once", async () => {
    const gate = deferred();
    const w = await world({
      answer: async () => {
        await gate.promise;
        return { line: COPY.decisionAllowed, settle: true };
      },
    });
    const prompt = w.open(MEL_SUPPORT);

    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: ADA }));
    const mels = w.onClick(INSTALL, w.clickOn(prompt));
    await vi.waitFor(() => expect(w.runs).toHaveLength(1));
    // While Mel's answer runs: Ben is told, never "busy"; Ada was told already.
    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: BEN }));
    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: ADA }));
    // Their refusals let go of nothing: Mel's own second click is still the busy one.
    await w.onClick(INSTALL, w.clickOn(prompt));
    gate.release();
    await mels;

    expect(w.runs).toHaveLength(1);
    expect(w.slack.calls.map((c) => [c.method, c.args['user'] ?? null])).toEqual([
      ['postEphemeral', ADA],
      ['usersInfo', MEL],
      ['postEphemeral', BEN],
      ['updateMessage', null],
    ]);
    expect(w.logged('slack_prompt_declined').map((f) => f['reason'])).toEqual([
      'not-asker',
      'not-asker',
      'not-asker',
      'busy',
    ]);
    expect(w.state(prompt)).toBe('gone');
  });

  it('defense in depth: even a registry that hands anyone the lock gets no bystander past the gate, and the lock it took is let go', async () => {
    // Broken on purpose: every claim is taken as if Mel clicked.
    const w = await world({ registry: (real) => ({ ...real, claim: (id) => real.claim(id, MEL) }) });
    const prompt = w.open(MEL_SUPPORT);

    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: ADA }));

    expect(w.slack.calls).toEqual([told(SUPPORT, ADA, COPY.promptOnlyAsker)]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
  });
});

// ── Each step, alone ────────────────────────────────────────────────────────

describe('the click gate: each step refuses on its own (each case valid on every other rule)', () => {
  it('step 1: no bot token: nothing is taken, said or answered', async () => {
    const w = await world({ botToken: null });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_failed')).toEqual([{ installId: INSTALL_ID, stage: 'bot-token', code: 'missing' }]);
  });

  it("step 1: a vault read that fails: the same, logged with the failure's code only", async () => {
    const w = await world({ botToken: fault('fake-vault') });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, stage: 'bot-token', code: 'store-unavailable' },
    ]);
  });

  it("step 2: a prompt this process doesn't have (after a restart): the clicker is pointed at Today, privately, in the clicked thread (Review Focus 2)", async () => {
    const w = await world();

    await w.onClick(INSTALL, {
      slackUserId: MEL,
      channel: DM_MEL,
      messageTs: PROMPT_TS,
      threadTs: THREAD_TS,
      action: 'allow',
      promptId: NEVER_MINTED,
    });

    expect(w.slack.calls).toEqual([told(DM_MEL, MEL, COPY.promptGone(TODAY))]);
    expect(w.runs).toEqual([]);
    expect(w.findUser).toEqual([]);
    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, reason: 'gone' }]);
  });

  it('step 2: a prompt past its TTL is gone too, and a click on a message Slack named no thread for gets its line unthreaded', async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);
    w.later(PROMPT_TTL_MS);

    await w.onClick(INSTALL, w.clickOn(prompt, { threadTs: null }));

    expect(w.slack.calls).toEqual([
      { method: 'postEphemeral', token: BOT_TOKEN, args: { channel: DM_MEL, user: MEL, text: COPY.promptGone(TODAY) } },
    ]);
    expect(w.runs).toEqual([]);
  });

  it("step 3: a click that came in on another install than the prompt's: silence, and the prompt stays open", async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);

    await w.onClick(OTHER_INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: OTHER_INSTALL.installId, kind: 'decision', reason: 'mismatch' },
    ]);
  });

  it("step 3: a click from another channel than the prompt's: silence, a bystander's too (step 3 runs before step 4)", async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt, { channel: RANDOM }));
    await w.onClick(INSTALL, w.clickOn(prompt, { channel: RANDOM, slackUserId: ADA }));

    expect(w.slack.calls).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_declined').map((f) => f['reason'])).toEqual(['mismatch', 'mismatch']);
  });

  it('step 5: Mel is a guest now: silence, nothing runs, and the prompt stays open', async () => {
    const w = await world({ slackUsers: { [MEL]: member(MEL, MEL_EMAIL, { is_restricted: true }) } });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP]);
    expect(w.runs).toEqual([]);
    expect(w.findUser).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', reason: 'not-admitted', code: 'guest' },
    ]);
  });

  it('step 5: an install row with no workspace on record admits nobody, without asking Slack: silence', async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);

    await w.onClick({ ...INSTALL, teamId: null }, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', reason: 'not-admitted', code: 'other-workspace' },
    ]);
  });

  it('step 5: users.info answered about someone else: silence', async () => {
    const w = await world({ slackUsers: { [MEL]: member(ADA, 'ada@canopyworks.com') } });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
  });

  it("step 5: users.info failed only because Slack was briefly unavailable: 'try again', privately, and the prompt stays open", async () => {
    const w = await world({ slackUsers: { [MEL]: new SlackApiError('users.info', 'ratelimited', 1_000) } });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptFailed)]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
  });

  it("step 6: Mel's verified email maps to no AX account now: 'only the asker', privately; nothing runs; the prompt stays open", async () => {
    const w = await world({ axUsers: { [MEL_EMAIL]: null } });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptOnlyAsker)]);
    expect(w.runs).toEqual([]);
    expect(w.resolved).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, kind: 'decision', reason: 'not-mapped' }]);
  });

  it("step 6: it maps to someone else's account: the same", async () => {
    const w = await world({ axUsers: { [MEL_EMAIL]: 'usr_someone_else' } });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptOnlyAsker)]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
  });

  it("step 6: the account lookup fails: 'try again', privately; the prompt stays open", async () => {
    const w = await world({ findUser: 'fails' });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptFailed)]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'find-user', code: 'store-unavailable' },
    ]);
  });

  it("step 7: Mel can't use #support's agent anymore (off its team): the prompt closes, and nothing runs (Review Focus 5)", async () => {
    const w = await world();
    const prompt = w.open(MEL_SUPPORT);
    w.agents.setRole(SUPPORT_TEAM, 'usr_mel', null);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(SUPPORT, COPY.promptClosed) },
    ]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, kind: 'decision', reason: 'no-access' }]);
  });

  it('step 7: her agent was deleted: the prompt closes, and nothing runs', async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);
    w.agents.agents.delete(MEL_AGENT.id);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.promptClosed) },
    ]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('gone');
  });

  it("step 7: a channel prompt's agent that agents no longer calls a team agent: closes (a DM's personal agent is fine)", async () => {
    const w = await world();
    // #support connected to Mel's personal agent: what agents:resolve would now say about a demoted team agent.
    await w.channels.store.remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id);
    await w.channels.store.upsert({
      installId: INSTALL_ID,
      channelId: SUPPORT,
      agentId: MEL_AGENT.id,
      connectedByUserId: 'usr_ada',
      channelName: 'support',
    });
    const prompt = w.open({ ...MEL_SUPPORT, agentId: MEL_AGENT.id });

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, kind: 'decision', reason: 'no-access' }]);
  });

  it("step 7: the agents lookup fails: 'try again', privately; the prompt stays open", async () => {
    const w = await world({ resolve: 'fails' });
    const prompt = w.open(MEL_SUPPORT);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(SUPPORT, MEL, COPY.promptFailed)]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'agent-access', code: 'store-unavailable' },
    ]);
  });

  it('step 8: #support was disconnected since the turn: the prompt closes, and nothing runs (Review Focus 5)', async () => {
    const w = await world();
    const prompt = w.open(MEL_SUPPORT);
    await w.channels.store.remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(SUPPORT, COPY.promptClosed) },
    ]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', reason: 'disconnected' },
    ]);
  });

  it('step 8: #support is connected to another agent now: the same', async () => {
    const w = await world();
    const prompt = w.open(MEL_SUPPORT);
    await w.channels.store.remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id);
    await w.channels.store.upsert({
      installId: INSTALL_ID,
      channelId: SUPPORT,
      agentId: OPS_AGENT.id,
      connectedByUserId: 'usr_ada',
      channelName: 'support',
    });

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_declined').map((f) => f['reason'])).toEqual(['disconnected']);
  });

  it("step 8: the binding read fails: 'try again', privately; the prompt stays open", async () => {
    const w = await world({ binding: 'fails' });
    const prompt = w.open(MEL_SUPPORT);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(SUPPORT, MEL, COPY.promptFailed)]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_failed')).toEqual([{ installId: INSTALL_ID, kind: 'decision', stage: 'binding', code: 'unknown' }]);
  });

  it('step 9: a subject nothing here can answer: the prompt closes, and nothing runs', async () => {
    // A gate built with no answer for the prompt's kind (a kernel without one).
    const w = await world({ answers: {} });
    const prompt = w.open(MEL_SUPPORT);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(SUPPORT, COPY.promptClosed) },
    ]);
    expect(w.runs).toEqual([]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, kind: 'decision', reason: 'unsupported' }]);
  });

  it("step 9: only the deps' own answers count: one inherited through a prototype never runs", async () => {
    let inheritedRuns = 0;
    const inherited: SubjectAnswer = async () => {
      inheritedRuns += 1;
      return { line: COPY.decisionAllowed, settle: true };
    };
    const w = await world({ answers: Object.create({ decision: inherited }) as AnswerDeps['answers'] });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(inheritedRuns).toBe(0);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', reason: 'unsupported' },
    ]);
  });

  it("step 9: an answer that fails: 'try again', privately, the prompt stays open, and Mel's next click answers it", async () => {
    const w = await world({
      answer: (n) => {
        if (n === 1) throw fault('fake-decisions');
        return { line: COPY.decisionAllowed, settle: true };
      },
    });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptFailed)]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'answer', code: 'store-unavailable' },
    ]);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.runs).toHaveLength(2);
    expect(w.slack.calls.filter((c) => c.method === 'updateMessage')).toHaveLength(1);
    expect(w.state(prompt)).toBe('gone');
  });
});

// ── One answer per prompt ───────────────────────────────────────────────────

describe('the click gate: one answer per prompt', () => {
  it('a double click: the answer runs once, the prompt is redrawn once, and the second click says nothing (Review Focus 1)', async () => {
    const gate = deferred();
    const w = await world({
      answer: async () => {
        await gate.promise;
        return { line: COPY.decisionAllowed, settle: true };
      },
    });
    const prompt = w.open(MEL_DM);

    const first = w.onClick(INSTALL, w.clickOn(prompt));
    const second = w.onClick(INSTALL, w.clickOn(prompt));
    await vi.waitFor(() => expect(w.runs).toHaveLength(1));
    gate.release();
    await Promise.all([first, second]);

    expect(w.runs).toHaveLength(1);
    expect(w.slack.calls.map((c) => c.method)).toEqual(['usersInfo', 'updateMessage']);
    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, reason: 'busy' }]);
  });

  for (const outcome of ['answered', 'closed'] as const) {
    it(`a second click while the prompt is being redrawn (${outcome}) is the silent busy one, never told the prompt is gone`, async () => {
      const redrawing = deferred();
      const w = await world({
        slackHold: { method: 'updateMessage', until: redrawing.promise },
        // Nothing here to answer the prompt's subject: it closes instead.
        ...(outcome === 'closed' ? { answers: {} } : {}),
      });
      const prompt = w.open(MEL_DM);

      const first = w.onClick(INSTALL, w.clickOn(prompt));
      await vi.waitFor(() => expect(w.slack.calls.map((c) => c.method)).toContain('updateMessage'));
      await w.onClick(INSTALL, w.clickOn(prompt));
      redrawing.release();
      await first;

      expect(w.slack.calls.map((c) => c.method)).toEqual(['usersInfo', 'updateMessage']);
      expect(w.logged('slack_prompt_declined').map((f) => f['reason'])).toEqual(
        outcome === 'closed' ? ['unsupported', 'busy'] : ['busy'],
      );
      expect(w.state(prompt)).toBe('gone');
    });
  }

  /** Each way a click on Mel's prompt ends with a private line while the prompt stays hers to answer. */
  const LET_GO_FIRST: Array<[string, WorldOptions]> = [
    [
      'an answer that failed',
      {
        answer: (n) => {
          if (n === 1) throw fault('fake-decisions');
          return { line: COPY.decisionAllowed, settle: true };
        },
      },
    ],
    [
      'an answer that leaves the prompt open',
      {
        answer: (n) =>
          n === 1 ? { line: COPY.promptFailed, settle: false } : { line: COPY.decisionAllowed, settle: true },
      },
    ],
    ['Slack briefly unavailable', { slackUsers: { [MEL]: new SlackApiError('users.info', 'ratelimited', 1_000) } }],
    ['an email that maps to no account', { axUsers: { [MEL_EMAIL]: null } }],
  ];

  for (const [what, options] of LET_GO_FIRST) {
    it(`${what}: the prompt is let go before Mel is told, so her click during that line isn't the busy one`, async () => {
      const telling = deferred();
      const w = await world({ ...options, slackHold: { method: 'postEphemeral', until: telling.promise } });
      const prompt = w.open(MEL_DM);

      const first = w.onClick(INSTALL, w.clickOn(prompt));
      await vi.waitFor(() => expect(w.slack.calls.map((c) => c.method)).toContain('postEphemeral'));
      await w.onClick(INSTALL, w.clickOn(prompt));
      telling.release();
      await first;

      // Her second click got past the claim: it asked users.info again.
      expect(w.slack.calls.filter((c) => c.method === 'usersInfo')).toHaveLength(2);
      expect(w.logged('slack_prompt_declined').map((f) => f['reason'])).not.toContain('busy');
    });
  }

  it('a throw past every step still lets go of the prompt: the asker can click again', async () => {
    // An answers table that breaks the first time it is looked in, before any answer runs.
    const ran: PromptAction[] = [];
    let looks = 0;
    const table = { decision: async (_ctx, _prompt, action) => {
      ran.push(action);
      return { line: COPY.decisionAllowed, settle: true };
    } } satisfies AnswerDeps['answers'];
    const answers = new Proxy(table, {
      getOwnPropertyDescriptor(target, key) {
        looks += 1;
        if (looks === 1) throw new Error('a broken answers table');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const w = await world({ answers });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt)).catch(() => undefined);
    expect(ran).toEqual([]);
    expect(w.state(prompt)).toBe('open');

    await w.onClick(INSTALL, w.clickOn(prompt));
    expect(ran).toEqual(['allow']);
    expect(w.state(prompt)).toBe('gone');
  });

  for (const [what, result] of [
    ['null', null],
    ['a string', COPY.decisionAllowed],
    ['an object with no line', { settle: true }],
  ] as const) {
    it(`an answer that hands back ${what} may have acted already: the prompt closes, and the next click runs nothing`, async () => {
      const w = await world({ answer: () => result as unknown as Answer });
      const prompt = w.open(MEL_DM);

      await expect(w.onClick(INSTALL, w.clickOn(prompt))).resolves.toBeUndefined();

      expect(w.slack.calls).toEqual([
        MEL_LOOKED_UP,
        { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.promptClosed) },
      ]);
      expect(w.logged('slack_prompt_failed')).toEqual([
        { installId: INSTALL_ID, kind: 'decision', stage: 'answer', code: 'unusable-answer' },
      ]);
      expect(w.state(prompt)).toBe('gone');

      await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));
      expect(w.runs).toHaveLength(1);
    });
  }

  it('an answer that leaves the prompt open: no redraw (its buttons stay), its line privately, and the prompt can be answered again', async () => {
    const w = await world({ answer: () => ({ line: COPY.promptFailed, settle: false }) });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptFailed)]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_answered')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', action: 'allow', settled: false },
    ]);
  });

  it("an answer that doesn't say false settles the prompt: one answer per prompt fails closed", async () => {
    const w = await world({ answer: () => ({ line: COPY.decisionAllowed }) as Answer });
    const prompt = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.state(prompt)).toBe('gone');
  });
});

// ── Where the prompt is redrawn ─────────────────────────────────────────────

describe('the click gate: which message is redrawn', () => {
  it("a click that beat the prompt's own post (no ts recorded yet): the clicked message is redrawn", async () => {
    const clicked = '1763121661.000300';
    const w = await world();
    const prompt = w.open(MEL_DM, { posted: false });

    await w.onClick(INSTALL, w.clickOn(prompt, { messageTs: clicked }));

    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.decisionAllowed, clicked) },
    ]);
    // And the answer is told that is the prompt's message.
    expect(w.runs.map((r) => r.extra.messageTs)).toEqual([clicked]);
  });

  it("step 3: once the prompt's message is known, a click naming any other message is refused: silence, a bystander's too, and the prompt stays open", async () => {
    // Defense in depth: a prompt's id rides only on its own message's buttons.
    const w = await world();
    const prompt = w.open(MEL_DM);
    const elsewhere = '1763121699.000900';

    await w.onClick(INSTALL, w.clickOn(prompt, { messageTs: elsewhere }));
    await w.onClick(INSTALL, w.clickOn(prompt, { messageTs: elsewhere, slackUserId: ADA }));

    expect(w.slack.calls).toEqual([]);
    expect(w.runs).toEqual([]);
    expect(w.findUser).toEqual([]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', reason: 'mismatch' },
      { installId: INSTALL_ID, kind: 'decision', reason: 'mismatch' },
    ]);

    // A click on its own message still answers it, and redraws that message.
    await w.onClick(INSTALL, w.clickOn(prompt));
    expect(w.runs).toHaveLength(1);
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.decisionAllowed, PROMPT_TS) },
    ]);
  });

  it("no ts it can use (none recorded, and the click's isn't a Slack ts): nothing is redrawn, it's logged, and the answer stands", async () => {
    const w = await world();
    const prompt = w.open(MEL_DM, { posted: false });

    await w.onClick(INSTALL, w.clickOn(prompt, { messageTs: '<!channel>' }));

    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]!.extra.messageTs).toBeNull();
    expect(w.slack.calls).toEqual([MEL_LOOKED_UP]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'update', code: 'no-message' },
    ]);
  });

  it("a redraw Slack refuses is logged and isn't fatal: the prompt is still settled", async () => {
    const w = await world();
    const prompt = w.open(MEL_DM);
    w.slack.api.updateMessage = async () => {
      throw new SlackApiError('chat.update', 'message_not_found');
    };

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'update', code: 'message_not_found' },
    ]);
    expect(w.logged('slack_prompt_answered')).toHaveLength(1);
  });
});

// ── Deadlines ───────────────────────────────────────────────────────────────

describe('the click gate: every step has a deadline', () => {
  /**
   * One step that never answers, and what the click does once the deadline
   * passes: Mel is told to try again (a step inside the claim) with the
   * prompt open again, or the click just ends (a step outside it). The
   * answer is the exception: it may still act, so the prompt stays taken.
   */
  const HUNG: Array<{
    step: string;
    options: WorldOptions;
    context: PromptContext;
    /** Whether the click is on a prompt this process has. */
    known: boolean;
    then: { state: 'open' | 'busy' | 'gone'; failed: Record<string, unknown> | null; told: string | null; runs: number };
  }> = [
    {
      step: 'the bot token read',
      options: { botToken: 'hang' },
      context: MEL_DM,
      known: true,
      then: {
        state: 'open',
        failed: { installId: INSTALL_ID, stage: 'bot-token', code: 'timeout' },
        told: null,
        runs: 0,
      },
    },
    {
      step: 'users.info',
      options: { slackHang: 'usersInfo' },
      context: MEL_DM,
      known: true,
      then: { state: 'open', failed: null, told: COPY.promptFailed, runs: 0 },
    },
    {
      step: 'the account lookup',
      options: { findUser: 'hang' },
      context: MEL_DM,
      known: true,
      then: {
        state: 'open',
        failed: { installId: INSTALL_ID, kind: 'decision', stage: 'find-user', code: 'timeout' },
        told: COPY.promptFailed,
        runs: 0,
      },
    },
    {
      step: 'the agents lookup',
      options: { resolve: 'hang' },
      context: MEL_DM,
      known: true,
      then: {
        state: 'open',
        failed: { installId: INSTALL_ID, kind: 'decision', stage: 'agent-access', code: 'timeout' },
        told: COPY.promptFailed,
        runs: 0,
      },
    },
    {
      step: 'the binding read',
      options: { binding: 'hang' },
      context: MEL_SUPPORT,
      known: true,
      then: {
        state: 'open',
        failed: { installId: INSTALL_ID, kind: 'decision', stage: 'binding', code: 'timeout' },
        told: COPY.promptFailed,
        runs: 0,
      },
    },
    {
      step: 'the answer',
      options: { answer: () => never() },
      context: MEL_DM,
      known: true,
      // It may still land: the prompt stays taken, and Mel hears it's still going, not "try again".
      then: {
        state: 'busy',
        failed: { installId: INSTALL_ID, kind: 'decision', stage: 'answer', code: 'timeout' },
        told: COPY.promptStillWorking,
        runs: 1,
      },
    },
    {
      step: 'the redraw',
      options: { slackHang: 'updateMessage' },
      context: MEL_DM,
      known: true,
      then: {
        state: 'gone',
        failed: { installId: INSTALL_ID, kind: 'decision', stage: 'update', code: 'timeout' },
        told: null,
        runs: 1,
      },
    },
    {
      step: 'a private line',
      options: { slackHang: 'postEphemeral' },
      context: MEL_DM,
      known: false,
      then: {
        state: 'open',
        failed: { installId: INSTALL_ID, stage: 'ephemeral', code: 'timeout' },
        told: COPY.promptGone(TODAY),
        runs: 0,
      },
    },
  ];

  for (const c of HUNG) {
    it(`${c.step} that never answers ends the click at PROMPT_STEP_TIMEOUT_MS, and not a moment before`, async () => {
      vi.useFakeTimers();
      const w = await world(c.options);
      const prompt = w.open(c.context);
      let ended = false;
      const click = w.onClick(INSTALL, w.clickOn(prompt, c.known ? {} : { promptId: NEVER_MINTED })).then(() => {
        ended = true;
      });

      await vi.advanceTimersByTimeAsync(PROMPT_STEP_TIMEOUT_MS - 1);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toBe(true);
      await click;

      expect(w.state(prompt)).toBe(c.then.state);
      expect(w.logged('slack_prompt_failed')).toEqual(c.then.failed === null ? [] : [c.then.failed]);
      const ephemerals = w.slack.calls.filter((call) => call.method === 'postEphemeral').map((call) => call.args['text']);
      expect(ephemerals).toEqual(c.then.told === null ? [] : [c.then.told]);
      expect(w.runs).toHaveLength(c.then.runs);
    });
  }

  it("while a step hangs, the prompt stays taken: Mel's second click is the silent busy one, until the deadline lets it go", async () => {
    vi.useFakeTimers();
    const w = await world({ findUser: 'hang' });
    const prompt = w.open(MEL_DM);
    const first = w.onClick(INSTALL, w.clickOn(prompt));
    await vi.advanceTimersByTimeAsync(PROMPT_STEP_TIMEOUT_MS - 1);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, reason: 'busy' }]);
    // The hung click's users.info, and nothing from the busy one.
    expect(w.slack.calls.map((c) => c.method)).toEqual(['usersInfo']);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(w.state(prompt)).toBe('open');
  });

  it("while the answer hangs, the prompt stays taken, past the deadline too: Mel's second click is silent and runs nothing", async () => {
    vi.useFakeTimers();
    const w = await world({ answer: () => never() });
    const prompt = w.open(MEL_DM);
    const first = w.onClick(INSTALL, w.clickOn(prompt));
    await vi.advanceTimersByTimeAsync(PROMPT_STEP_TIMEOUT_MS - 1);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, reason: 'busy' }]);
    expect(w.slack.calls.map((c) => c.method)).toEqual(['usersInfo']);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(w.state(prompt)).toBe('busy');

    await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));

    expect(w.runs).toHaveLength(1);
    expect(w.logged('slack_prompt_declined')).toEqual([
      { installId: INSTALL_ID, reason: 'busy' },
      { installId: INSTALL_ID, reason: 'busy' },
    ]);
  });

  it('leaves no timer behind once a click is answered', async () => {
    vi.useFakeTimers();
    const w = await world();
    const answered = w.open(MEL_SUPPORT);
    const refused = w.open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(answered));
    await w.onClick(INSTALL, w.clickOn(refused, { slackUserId: ADA, channel: DM_MEL }));
    await w.onClick(INSTALL, w.clickOn(refused, { promptId: NEVER_MINTED }));

    expect(w.runs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── An answer past its deadline ─────────────────────────────────────────────

describe('the click gate: an answer past its deadline still holds the prompt until it lands', () => {
  /**
   * Mel's Allow, whose answer outlives the click's deadline and lands only
   * when the test says: the abandoned approve may still go through, so
   * nothing else may run on the prompt until it has.
   */
  async function slowAllow(late: () => Answer | Promise<Answer>, options: WorldOptions = {}) {
    vi.useFakeTimers();
    const landing = deferred();
    const w = await world({
      ...options,
      answer: async (n) => {
        if (n > 1) return { line: COPY.decisionDenied, settle: true };
        await landing.promise;
        return late();
      },
    });
    const prompt = w.open(MEL_DM);
    const click = w.onClick(INSTALL, w.clickOn(prompt));
    await vi.advanceTimersByTimeAsync(PROMPT_STEP_TIMEOUT_MS);
    await click;
    return { w, prompt, land: landing.release };
  }

  it("Allow times out, then Mel clicks Deny: silence, no dismiss, until the approve lands; then the prompt shows the approve's line and is settled", async () => {
    const { w, prompt, land } = await slowAllow(() => ({ line: COPY.decisionAllowed, settle: true }));
    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptStillWorking)]);
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'answer', code: 'timeout' },
    ]);

    await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));

    expect(w.runs.map((r) => r.action)).toEqual(['allow']);
    expect(w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, reason: 'busy' }]);
    expect(w.slack.calls).toHaveLength(2);
    expect(w.state(prompt)).toBe('busy');

    land();
    await vi.waitFor(() => expect(w.state(prompt)).toBe('gone'));

    expect(w.slack.calls.slice(2)).toEqual([
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.decisionAllowed) },
    ]);
    expect(w.logged('slack_prompt_answered')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', action: 'allow', settled: true },
    ]);

    // Deny after it landed: the prompt is answered, and Mel is pointed at Today. Still no dismiss.
    await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));
    expect(w.runs.map((r) => r.action)).toEqual(['allow']);
    expect(w.slack.calls.at(-1)).toEqual(told(DM_MEL, MEL, COPY.promptGone(TODAY)));
  });

  it("an answer that fails after its deadline: the prompt is open again, Mel is told to try again, and her next click answers it", async () => {
    const { w, prompt, land } = await slowAllow(() => {
      throw fault('fake-decisions');
    });

    land();
    await vi.waitFor(() => expect(w.state(prompt)).toBe('open'));

    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      told(DM_MEL, MEL, COPY.promptStillWorking),
      told(DM_MEL, MEL, COPY.promptFailed),
    ]);
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'answer', code: 'timeout' },
      { installId: INSTALL_ID, kind: 'decision', stage: 'late-answer', code: 'store-unavailable' },
    ]);

    await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));
    expect(w.runs.map((r) => r.action)).toEqual(['allow', 'deny']);
    expect(w.state(prompt)).toBe('gone');
  });

  it('an answer that lands late and leaves the prompt open: its line privately, no redraw, and the prompt is open again', async () => {
    const { w, prompt, land } = await slowAllow(() => ({ line: COPY.promptFailed, settle: false }));

    land();
    await vi.waitFor(() => expect(w.state(prompt)).toBe('open'));

    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      told(DM_MEL, MEL, COPY.promptStillWorking),
      told(DM_MEL, MEL, COPY.promptFailed),
    ]);
  });

  it('an answer that lands late with nothing usable: the prompt closes, never retried', async () => {
    const { w, prompt, land } = await slowAllow(() => null as unknown as Answer);

    land();
    await vi.waitFor(() => expect(w.state(prompt)).toBe('gone'));

    expect(w.slack.calls.at(-1)).toEqual({
      method: 'updateMessage',
      token: BOT_TOKEN,
      args: redrawn(DM_MEL, COPY.promptClosed),
    });
  });

  it("Mel hears it's still going before she hears how it went, even when it lands while she's being told", async () => {
    const telling = deferred();
    vi.useFakeTimers();
    const landing = deferred();
    const w = await world({
      slackHold: { method: 'postEphemeral', until: telling.promise },
      answer: async () => {
        await landing.promise;
        return { line: COPY.decisionAllowed, settle: true };
      },
    });
    const prompt = w.open(MEL_DM);
    const click = w.onClick(INSTALL, w.clickOn(prompt));
    await vi.advanceTimersByTimeAsync(PROMPT_STEP_TIMEOUT_MS);
    expect(w.slack.calls.map((c) => c.method)).toEqual(['usersInfo', 'postEphemeral']);

    landing.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.slack.calls.map((c) => c.method)).toEqual(['usersInfo', 'postEphemeral']);
    telling.release();
    await click;
    await vi.waitFor(() => expect(w.state(prompt)).toBe('gone'));

    expect(w.slack.calls.map((c) => c.method)).toEqual(['usersInfo', 'postEphemeral', 'updateMessage']);
  });

  it('an answer that never lands holds the prompt only so long: a TTL past its expiry, the registry lets it go', async () => {
    const { w, prompt } = await slowAllow(() => ({ line: COPY.decisionAllowed, settle: true }));

    w.later(PROMPT_TTL_MS);
    expect(w.state(prompt)).toBe('busy');
    w.later(PROMPT_TTL_MS);
    expect(w.state(prompt)).toBe('gone');
  });
});

// ── Behind the gate, the real decision answer ───────────────────────────────

describe("the click gate with the decision answer (decision-answer.ts): a decisions hook past the bus's deadline holds the prompt until it settles", () => {
  /** When the fake decisions wakes the agent. */
  const WAKE = '2026-11-14T12:00:10.000Z';

  /**
   * Mel's DM prompt, answered by the real decision answer over a fake
   * @ax/decisions whose approve lands only when the test says. `timeoutMs`
   * is the deadline the bus gives approve and dismiss: unset, the bus's
   * default, as for the real plugin (it registers none of its own).
   */
  async function heldApprove(timeoutMs?: number) {
    vi.useFakeTimers();
    const landing = deferred();
    let status = 'pending';
    const approves: Array<Record<string, unknown>> = [];
    const dismisses: Array<Record<string, unknown>> = [];
    const follows: ContinuationRequest[] = [];
    /** The Slack calls made by the time each follow-up started. */
    const slackAtFollow: string[][] = [];
    const timing = timeoutMs === undefined ? {} : { timeoutMs };
    let slackSoFar = (): string[] => [];
    const w = await world({
      services: (bus) => {
        bus.registerService(
          'decisions:approve',
          'fake-decisions',
          async (ctx, input) => {
            const asked = input as Record<string, unknown>;
            // As @ax/decisions guards it: an approve runs as the user it is for.
            if (ctx.userId !== asked['userId']) throw new Error('approve scope mismatch');
            approves.push({ ...asked });
            await landing.promise;
            status = 'executed';
            return {
              decision: { id: 'dec_0001', status },
              executed: false,
              path: 'agent-executes',
              error: null,
              pendingUntil: WAKE,
              streamReqId: asked['continuationReqId'],
            };
          },
          timing,
        );
        bus.registerService(
          'decisions:dismiss',
          'fake-decisions',
          async (ctx, input) => {
            const asked = input as Record<string, unknown>;
            if (ctx.userId !== asked['userId']) throw new Error('dismiss scope mismatch');
            dismisses.push({ ...asked });
            status = 'dismissed';
            return { decision: { id: 'dec_0001', status } };
          },
          timing,
        );
        bus.registerService('decisions:get', 'fake-decisions', async () => ({ decision: { id: 'dec_0001', status } }));
      },
      answersOn: (bus) => ({
        decision: createDecisionAnswer({
          bus,
          publicOrigin: PUBLIC_ORIGIN,
          follow: (c) => {
            follows.push(c);
            slackAtFollow.push(slackSoFar());
          },
        }),
      }),
    });
    slackSoFar = () => w.slack.calls.map((c) => c.method);
    const prompt = w.open(MEL_DM);
    return { w, prompt, approves, dismisses, follows, slackAtFollow, land: landing.release };
  }

  it("Allow hits the bus's deadline, then Mel clicks Deny: silence, no dismiss; once the approve settles, the prompt shows what the row says", async () => {
    const h = await heldApprove();
    const click = h.w.onClick(INSTALL, h.w.clickOn(h.prompt));
    await vi.advanceTimersByTimeAsync(PROMPT_STEP_TIMEOUT_MS);
    await click;
    expect(h.w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptStillWorking)]);
    // Past the bus's own deadline too: it stopped waiting for the approve, which hasn't stopped.
    await vi.advanceTimersByTimeAsync(DEFAULT_SERVICE_TIMEOUT_MS);

    await h.w.onClick(INSTALL, h.w.clickOn(h.prompt, { action: 'deny' }));

    expect(h.dismisses).toEqual([]);
    expect(h.w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, reason: 'busy' }]);
    expect(h.w.slack.calls).toHaveLength(2);
    expect(h.w.state(h.prompt)).toBe('busy');

    h.land();
    await vi.waitFor(() => expect(h.w.state(h.prompt)).toBe('gone'));

    expect(h.w.slack.calls.slice(2)).toEqual([
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.decisionAllowed) },
    ]);
    expect(h.approves).toHaveLength(1);
    // Its echo was lost with the deadline: nothing to follow by.
    expect(h.follows).toEqual([]);
    expect(h.w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'answer', code: 'timeout' },
      { installId: INSTALL_ID, kind: 'decision', stage: 'approve', code: 'timeout' },
    ]);

    // Deny after it settled: answered, and Mel is pointed at Today. Still no dismiss.
    await h.w.onClick(INSTALL, h.w.clickOn(h.prompt, { action: 'deny' }));
    expect(h.dismisses).toEqual([]);
    expect(h.w.slack.calls.at(-1)).toEqual(told(DM_MEL, MEL, COPY.promptGone(TODAY)));
  });

  it("the same when the bus's deadline for the hook comes before the click's: the bus gives up first, and the prompt still waits", async () => {
    const h = await heldApprove(1_000);
    const click = h.w.onClick(INSTALL, h.w.clickOn(h.prompt));
    await vi.advanceTimersByTimeAsync(1_000);

    await h.w.onClick(INSTALL, h.w.clickOn(h.prompt, { action: 'deny' }));

    expect(h.dismisses).toEqual([]);
    expect(h.w.logged('slack_prompt_declined')).toEqual([{ installId: INSTALL_ID, reason: 'busy' }]);
    expect(h.w.slack.calls).toEqual([MEL_LOOKED_UP]);

    await vi.advanceTimersByTimeAsync(PROMPT_STEP_TIMEOUT_MS);
    await click;
    expect(h.w.slack.calls).toEqual([MEL_LOOKED_UP, told(DM_MEL, MEL, COPY.promptStillWorking)]);
    expect(h.w.state(h.prompt)).toBe('busy');

    h.land();
    await vi.waitFor(() => expect(h.w.state(h.prompt)).toBe('gone'));
    expect(h.w.slack.calls.at(-1)).toEqual({
      method: 'updateMessage',
      token: BOT_TOKEN,
      args: redrawn(DM_MEL, COPY.decisionAllowed),
    });
    expect(h.dismisses).toEqual([]);
  });

  it('on time, the agent is followed as soon as the approve returns, before the prompt is redrawn, under the id the Allow minted', async () => {
    const h = await heldApprove();
    h.land();

    await h.w.onClick(INSTALL, h.w.clickOn(h.prompt));

    expect(h.follows).toHaveLength(1);
    const followed = h.follows[0]!;
    expect({
      prompt: followed.prompt.id,
      botToken: followed.botToken,
      reqId: followed.reqId,
      pendingUntil: followed.pendingUntil,
    }).toEqual({
      prompt: h.prompt.id,
      botToken: BOT_TOKEN,
      reqId: h.approves[0]!['continuationReqId'],
      pendingUntil: WAKE,
    });
    // Following makes no Slack call, and it began before the redraw did.
    expect(h.slackAtFollow).toEqual([['usersInfo']]);
    expect(h.w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawn(DM_MEL, COPY.decisionAllowed) },
    ]);
    expect(h.w.state(h.prompt)).toBe('gone');
  });
});

// ── A host the sandbox was refused (TASK-1095 PR B) ────────────────────────

describe('the click gate: a host prompt, answered with the real host answer', () => {
  /** The turn's live sandbox session, as the egress wall's card named it. */
  const SESSION = 'sess_live_0001';
  const HOST = 'api.example.com';
  const HOST_SUBJECT: PromptSubject = { kind: 'host', host: HOST, sessionId: SESSION };

  /** A world whose `proxy:add-host` records each call and lets the host through, as credential-proxy does for its owner. */
  async function hostWorld() {
    const added: Array<{ ctx: AgentContext; input: unknown }> = [];
    const w = await world({
      services: (bus) => {
        bus.registerService('proxy:add-host', 'fake-credential-proxy', async (ctx, input) => {
          added.push({ ctx, input: JSON.parse(JSON.stringify(input)) as unknown });
          return { added: true, agentId: 'agt_support' };
        });
      },
      answersOn: (bus) => ({ host: createHostAnswer({ bus }) }),
    });
    const open = () => w.open(MEL_SUPPORT, { subject: HOST_SUBJECT, subjectText: COPY.hostSubject(HOST) });
    /** The host prompt redrawn with `line`: its subject, then the line, and nothing to click. */
    const redrawnHost = (line: string) => ({
      channel: SUPPORT,
      ts: PROMPT_TS,
      text: line,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: COPY.hostSubject(HOST), emoji: false } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
      ],
    });
    return { w, added, open, redrawnHost };
  }

  it("Mel's Allow on her host prompt in #support: proxy:add-host as usr_mel, for exactly the prompt's session and host; the prompt says so", async () => {
    const { w, added, open, redrawnHost } = await hostWorld();
    const prompt = open();

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(added.map((a) => a.input)).toEqual([{ sessionId: SESSION, host: HOST }]);
    expect(added[0]!.ctx.userId).toBe('usr_mel');
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawnHost(COPY.hostAllowed) },
    ]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_answered')).toEqual([
      { installId: INSTALL_ID, kind: 'host', action: 'allow', settled: true },
    ]);
  });

  it("Ada's click on Mel's host prompt: told privately it isn't hers, and nothing is let through", async () => {
    const { w, added, open } = await hostWorld();
    const prompt = open();

    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: ADA }));

    expect(added).toEqual([]);
    expect(w.slack.calls).toEqual([told(SUPPORT, ADA, COPY.promptOnlyAsker)]);
    expect(w.state(prompt)).toBe('open');
  });

  it("Mel's Deny: nothing is called, and the prompt says so", async () => {
    const { w, added, open, redrawnHost } = await hostWorld();
    const prompt = open();

    await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));

    expect(added).toEqual([]);
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawnHost(COPY.hostDenied) },
    ]);
    expect(w.state(prompt)).toBe('gone');
  });

  it('a channel disconnected since the turn (Review Focus 5): the prompt closes, and nothing is let through', async () => {
    const { w, added, open, redrawnHost } = await hostWorld();
    const prompt = open();
    await w.channels.store.remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(added).toEqual([]);
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawnHost(COPY.promptClosed) },
    ]);
    expect(w.state(prompt)).toBe('gone');
  });
});

// ── A catalog skill the agent asked to use (TASK-1095 PR B) ────────────────

describe('the click gate: a skill prompt, answered with the real skill answer', () => {
  const SKILL_ID = 'gmail-sender';
  const SKILL_SUBJECT: PromptSubject = { kind: 'skill', skillId: SKILL_ID };
  const ASKED = COPY.skillSubject(SKILL_ID, 'Reads and sends email from your Gmail account.');
  const GRANT = 'agent:apply-capability-grant';
  const CONVERSATION_GET = 'conversations:get';

  /**
   * A world whose `conversations:get` answers as @ax/conversations does (each
   * conversation its owner's, with its frozen agent) and whose
   * `agent:apply-capability-grant` attaches the skill. Both record each call.
   */
  async function skillWorld(o: { conversationGet?: Fault | 'other-agent' } = {}) {
    const calls: Array<{ hook: string; ctx: AgentContext; input: unknown }> = [];
    const conversations: Record<string, { userId: string; agentId: string }> = {
      conv_mel_dm: { userId: 'usr_mel', agentId: 'agt_mel' },
      conv_mel_support: { userId: 'usr_mel', agentId: o.conversationGet === 'other-agent' ? 'agt_ops' : 'agt_support' },
    };
    const w = await world({
      services: (bus) => {
        bus.registerService(CONVERSATION_GET, 'fake-conversations', async (ctx, input) => {
          calls.push({ hook: CONVERSATION_GET, ctx, input: JSON.parse(JSON.stringify(input)) as unknown });
          if (o.conversationGet === 'fails') throw fault('fake-conversations');
          const { conversationId, userId } = input as { conversationId: string; userId: string };
          const row = conversations[conversationId];
          if (row === undefined || row.userId !== userId) {
            throw new PluginError({ code: 'not-found', plugin: 'fake-conversations', message: 'conversation not found' });
          }
          return { conversation: { conversationId, ...row }, turns: [] };
        });
        bus.registerService(GRANT, 'fake-chat-orchestrator', async (ctx, input) => {
          calls.push({ hook: GRANT, ctx, input: JSON.parse(JSON.stringify(input)) as unknown });
          return { attached: true };
        });
      },
      answersOn: (bus) => ({ skill: createSkillAnswer({ bus, publicOrigin: PUBLIC_ORIGIN }) }),
    });
    const open = (c: PromptContext = MEL_SUPPORT) => w.open(c, { subject: SKILL_SUBJECT, subjectText: ASKED });
    /** The skill prompt redrawn with `line`: its subject, then the line, and nothing to click. */
    const redrawnSkill = (channel: string, line: string) => ({
      channel,
      ts: PROMPT_TS,
      text: line,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: ASKED, emoji: false } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: line }] },
      ],
    });
    return { w, calls, open, redrawnSkill, hooks: () => calls.map((c) => c.hook) };
  }

  it("Mel's Allow on her skill prompt in #support: once the gate has re-proved her, her conversation is read back, then the skill is attached for exactly the prompt's conversation, user, agent and skill", async () => {
    const { w, calls, open, redrawnSkill, hooks } = await skillWorld();
    const prompt = open();

    await w.onClick(INSTALL, w.clickOn(prompt));

    // agents:resolve already ran in the gate (step 7), before the answer's own checks.
    expect(w.resolved.map((r) => r.input)).toEqual([{ agentId: 'agt_support', userId: 'usr_mel' }]);
    expect(hooks()).toEqual([CONVERSATION_GET, GRANT]);
    expect(calls[0]!.input).toEqual({ conversationId: 'conv_mel_support', userId: 'usr_mel' });
    expect(calls[1]!.input).toEqual({
      conversationId: 'conv_mel_support',
      userId: 'usr_mel',
      agentId: 'agt_support',
      skillId: SKILL_ID,
    });
    expect(calls[1]!.ctx.userId).toBe('usr_mel');
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawnSkill(SUPPORT, COPY.skillAllowed) },
    ]);
    expect(w.state(prompt)).toBe('gone');
    expect(w.logged('slack_prompt_answered')).toEqual([
      { installId: INSTALL_ID, kind: 'skill', action: 'allow', settled: true },
    ]);
  });

  it("Ada's click on Mel's skill prompt: told privately it isn't hers, and nothing is read or attached", async () => {
    const { w, calls, open } = await skillWorld();
    const prompt = open();

    await w.onClick(INSTALL, w.clickOn(prompt, { slackUserId: ADA }));

    expect(calls).toEqual([]);
    expect(w.slack.calls).toEqual([told(SUPPORT, ADA, COPY.promptOnlyAsker)]);
    expect(w.state(prompt)).toBe('open');
  });

  it("Mel's Deny: nothing is called, and the prompt says so", async () => {
    const { w, calls, open, redrawnSkill } = await skillWorld();
    const prompt = open(MEL_DM);

    await w.onClick(INSTALL, w.clickOn(prompt, { action: 'deny' }));

    expect(calls).toEqual([]);
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawnSkill(DM_MEL, COPY.skillDenied) },
    ]);
    expect(w.state(prompt)).toBe('gone');
  });

  it("the conversation read fails: the gate's 'try again', the prompt open again, and nothing attached", async () => {
    const { w, open, hooks } = await skillWorld({ conversationGet: 'fails' });
    const prompt = open();

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(hooks()).toEqual([CONVERSATION_GET]);
    expect(w.slack.calls).toEqual([MEL_LOOKED_UP, told(SUPPORT, MEL, COPY.promptFailed)]);
    expect(w.state(prompt)).toBe('open');
    expect(w.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'skill', stage: 'answer', code: 'store-unavailable' },
    ]);
  });

  it("the conversation is another agent's: nothing attached, and the prompt sends Mel to the web app", async () => {
    const { w, open, redrawnSkill, hooks } = await skillWorld({ conversationGet: 'other-agent' });
    const prompt = open();

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(hooks()).toEqual([CONVERSATION_GET]);
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawnSkill(SUPPORT, COPY.skillFailed(TODAY)) },
    ]);
    expect(w.state(prompt)).toBe('gone');
  });

  it('a channel disconnected since the turn (Review Focus 5): the prompt closes, and nothing is read or attached', async () => {
    const { w, calls, open, redrawnSkill } = await skillWorld();
    const prompt = open();
    await w.channels.store.remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id);

    await w.onClick(INSTALL, w.clickOn(prompt));

    expect(calls).toEqual([]);
    expect(w.slack.calls).toEqual([
      MEL_LOOKED_UP,
      { method: 'updateMessage', token: BOT_TOKEN, args: redrawnSkill(SUPPORT, COPY.promptClosed) },
    ]);
    expect(w.state(prompt)).toBe('gone');
  });
});

// ── What a prompt is redrawn with, and what is logged ───────────────────────

describe('the click gate: lines and logs', () => {
  /** Every COPY value, with the lines that take Today's link given it. */
  const COPY_LINES = new Set<string>([
    ...Object.values(COPY).filter((v): v is string => typeof v === 'string'),
    ...[
      COPY.heldForSender,
      COPY.promptToday,
      COPY.promptGone,
      COPY.decisionChanged,
      COPY.decisionFailed,
      COPY.decisionNotRun,
    ].map((line) => line(TODAY)),
  ]);

  it("every line a prompt is redrawn with is a COPY line: the gate's own, or the answer's exactly as given", async () => {
    const redraws: Array<{ text: unknown; context: unknown }> = [];
    const lines = [COPY.decisionAllowed, COPY.decisionChanged(TODAY), COPY.decisionDenied];
    for (const line of lines) {
      const w = await world({ answer: () => ({ line, settle: true }) });
      await w.onClick(INSTALL, w.clickOn(w.open(MEL_DM)));
      const update = w.slack.calls.find((c) => c.method === 'updateMessage')!;
      expect(update.args['text']).toBe(line);
      redraws.push({ text: update.args['text'], context: update.args['blocks'] });
    }
    // The gate's own closings: no access, disconnected, nothing to answer with (no answers at all).
    const closings = await world({ answers: {} });
    const offTeam = closings.open(MEL_SUPPORT);
    closings.agents.setRole(SUPPORT_TEAM, 'usr_mel', null);
    await closings.onClick(INSTALL, closings.clickOn(offTeam));
    closings.agents.setRole(SUPPORT_TEAM, 'usr_mel', 'member');
    await closings.onClick(INSTALL, closings.clickOn(closings.open(MEL_DM)));
    await closings.channels.store.remove(INSTALL_ID, SUPPORT, SUPPORT_AGENT.id);
    await closings.onClick(INSTALL, closings.clickOn(closings.open(MEL_SUPPORT)));
    for (const update of closings.slack.calls.filter((c) => c.method === 'updateMessage')) {
      expect(update.args['text']).toBe(COPY.promptClosed);
      redraws.push({ text: update.args['text'], context: update.args['blocks'] });
    }

    expect(redraws).toHaveLength(6);
    for (const r of redraws) {
      expect(COPY_LINES.has(r.text as string), String(r.text)).toBe(true);
      const context = (r.context as Array<{ type: string; elements?: Array<{ text: string }> }>).find(
        (b) => b.type === 'context',
      );
      expect(context?.elements?.map((e) => e.text)).toEqual([r.text]);
    }
  });

  it('logs name the install, the kind, a reason, stage, action or code, and a boolean: never an id, an email, a token or the subject', async () => {
    const lines: Line[] = [];
    // A bystander, a gone prompt, an answer that fails and then lands, and a close.
    const a = await world({
      answer: (n) => {
        if (n === 1) throw fault('fake-decisions');
        return { line: COPY.decisionAllowed, settle: true };
      },
    });
    const prompt = a.open(MEL_SUPPORT);
    await a.onClick(INSTALL, a.clickOn(prompt, { slackUserId: ADA }));
    await a.onClick(INSTALL, a.clickOn(prompt));
    await a.onClick(INSTALL, a.clickOn(prompt));
    await a.onClick(INSTALL, a.clickOn(prompt));
    lines.push(...a.lines);
    // A close: nothing here answers the prompt's subject.
    const e = await world({ answers: {} });
    await e.onClick(INSTALL, e.clickOn(e.open(MEL_DM, { subject: { kind: 'decision', decisionId: 'dec_secret' } })));
    lines.push(...e.lines);
    // Slack briefly away, an email with no account, and a vault that fails.
    const b = await world({ slackUsers: { [MEL]: new SlackApiError('users.info', 'ratelimited', 1_000) } });
    await b.onClick(INSTALL, b.clickOn(b.open(MEL_DM)));
    lines.push(...b.lines);
    const c = await world({ axUsers: { [MEL_EMAIL]: null } });
    await c.onClick(INSTALL, c.clickOn(c.open(MEL_DM)));
    lines.push(...c.lines);
    const d = await world({ botToken: fault('fake-vault') });
    await d.onClick(INSTALL, d.clickOn(d.open(MEL_DM)));
    lines.push(...d.lines);

    expect(new Set(lines.map((l) => l.msg))).toEqual(
      new Set([
        'slack_prompt_declined',
        'slack_prompt_failed',
        'slack_prompt_answered',
        // findSenderUser's own line on a miss.
        'slack_sender_not_mapped',
      ]),
    );
    const allowed = new Set(['installId', 'kind', 'reason', 'stage', 'action', 'code', 'settled']);
    for (const line of lines) {
      for (const [key, value] of Object.entries(line.fields)) {
        expect(allowed.has(key), `${line.msg}.${key}`).toBe(true);
        expect(['string', 'boolean'], `${line.msg}.${key}`).toContain(typeof value);
      }
    }
    const all = JSON.stringify(lines);
    for (const leak of [
      MEL,
      ADA,
      DM_MEL,
      SUPPORT,
      THREAD_TS,
      PROMPT_TS,
      BOT_TOKEN,
      MEL_EMAIL,
      'usr_mel',
      'agt_mel',
      'agt_support',
      'conv_mel',
      'dec_0001',
      'dec_secret',
      SUMMARY,
      prompt.id,
    ]) {
      expect(all, leak).not.toContain(leak);
    }
  });
});
