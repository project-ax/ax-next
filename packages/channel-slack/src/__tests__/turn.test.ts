import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HookBus, PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';
import {
  CONTINUATION_START_GRACE_MS,
  CONTINUATION_WAKE_MAX_MS,
  PERMISSION_PROMPTS_PER_TURN_MAX,
  PROMPT_MAX,
  PROMPT_TTL_MS,
  TURN_END_GRACE_MS,
  TURN_HARD_CAP_MS,
} from '../limits.js';
import { linkOnlyBlocks, outcomeBlocks } from '../blocks.js';
import { cleanPromptSubject } from '../format.js';
import { createPromptRegistry } from '../prompts.js';
import { systemClock } from '../reply-stream.js';
import { SlackApiError, type SlackApi, type StreamChunkOut } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { SLACK_NOT_REMEMBERED_LINE } from '../turn-note.js';
import { createTurnRegistry, subscribeTurnEvents } from '../turn-registry.js';
import {
  followContinuation,
  PLUMBING_TOOL_NAMES,
  runTurn,
  turnContextFields,
  type ContinuationRequest,
  type TurnMode,
  type TurnRequest,
} from '../turn.js';
import { fakeBotToken } from './fake-slack-tokens.js';
import { spellsMention } from './lenient-decoder.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const PUBLIC_ORIGIN = 'https://ax.example';
/** Today: where a held call waits for the person the turn runs as. */
const TODAY = 'https://ax.example/workspace';
const BOT_TOKEN = fakeBotToken('TURNTESTSECRET');

const INSTALL: InstallRow = {
  installId: 'q3VtZ0xH4kTn9Wb2LmPa1A',
  status: 'active',
  appId: 'A07QF9ZK2MN',
  clientId: '7512345678901.7598765432109',
  botName: 'canopy-works',
  teamId: 'T07ABCDEF12',
  teamName: 'Canopy Works',
  botUserId: 'U07BOTUSER1',
  connectedByUserId: 'usr_admin',
  createdAt: new Date('2026-11-13T10:00:00Z'),
  configTokenAddedAt: new Date('2026-11-13T10:00:00Z'),
  installedAt: new Date('2026-11-13T10:05:00Z'),
};

const SENDER = 'U07ALICE001';
/** The caller's label, whatever the mode: the turn puts it in front of the text as it is. */
const LABEL = `[Slack · #support · Alice Smith (${SENDER})]`;

// ── A fake Slack: the reply's calls, recorded ───────────────────────────────

type Method =
  | 'startStream'
  | 'appendStream'
  | 'stopStream'
  | 'postMessage'
  | 'postBlocks'
  | 'updateMessage'
  | 'addReaction'
  | 'removeReaction';

interface SlackCall {
  method: Method;
  token: string;
  args: Record<string, unknown>;
}

/** The ts Slack gives a prompt's message. */
const PROMPT_TS = '1763040000.000900';

function fakeSlack(o: { postBlocksFails?: boolean; updateMessageFails?: boolean } = {}) {
  const calls: SlackCall[] = [];
  let nextTs = 1;
  const notHere = async (): Promise<never> => {
    throw new Error('a turn must not call this Slack method');
  };
  const record = (method: Method, args: Record<string, unknown>, token = BOT_TOKEN): void => {
    calls.push({ method, token, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
  };
  const api: SlackApi = {
    rotateConfigToken: notHere,
    createApp: notHere,
    updateApp: notHere,
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    usersInfo: notHere,
    usersLookupByEmail: notHere,
    postDirect: notHere,
    postEphemeral: notHere,
    async postBlocks(token, a) {
      record('postBlocks', a, token);
      if (o.postBlocksFails === true) throw new SlackApiError('chat.postMessage', 'invalid_blocks');
      return { ts: PROMPT_TS };
    },
    // Only a follower that gave up redraws its prompt; a turn never does (its tests' exact call lists show it).
    async updateMessage(token, a) {
      record('updateMessage', a, token);
      if (o.updateMessageFails === true) throw new SlackApiError('chat.update', 'message_not_found');
    },
    conversationsInfo: notHere,
    async postMessage(token, a) {
      record('postMessage', a, token);
    },
    async startStream(_token, a) {
      record('startStream', a);
      return { ts: `1763039999.${String(nextTs++).padStart(6, '0')}` };
    },
    async appendStream(_token, a) {
      record('appendStream', a);
    },
    async stopStream(_token, a) {
      record('stopStream', a);
    },
    async addReaction(_token, a) {
      record('addReaction', a);
    },
    async removeReaction(_token, a) {
      record('removeReaction', a);
    },
  };
  return { api, calls };
}

/** The status card's titles Slack received, in order. */
function cardTitlesOf(calls: readonly SlackCall[]): string[] {
  return calls.flatMap((c) => {
    const chunks = Array.isArray(c.args['chunks']) ? (c.args['chunks'] as StreamChunkOut[]) : [];
    return chunks.flatMap((x) => (x.type === 'task_update' ? [x.title] : []));
  });
}

/** Every word of the reply Slack received, streamed or posted, in order. */
function replyOf(calls: readonly SlackCall[]): string {
  return calls
    .map((c) => {
      if (c.method === 'postMessage') return String(c.args['markdownText']);
      const chunks = Array.isArray(c.args['chunks']) ? (c.args['chunks'] as StreamChunkOut[]) : [];
      return chunks.map((x) => (x.type === 'markdown_text' ? x.text : '')).join('');
    })
    .join('');
}

// ── The fake orchestrator: agent:invoke fires the turn's events on the bus ─

interface Script {
  /**
   * Before anything of its own, another turn in the conversation ends dark
   * (no reqId): a warm agent's reaction to a Deny, still running when the
   * message came. What the reply had done by then is kept (`afterDark`).
   */
  darkEndFirst?: boolean;
  /**
   * And that dark turn-end answers this invoke: chat-orchestrator resolves a
   * session's OLDEST waiting invoke on a turn-end that names no reqId
   * (`resolveWaiterFor`), so the invoke returns complete there, before its
   * own turn has even begun. Its chunks and end then come from the test
   * (`own`), as the runner sends them.
   */
  answeredByDarkEnd?: boolean;
  /** Chunks to fire, in order, each stamped with the invoke's reqId. */
  chunks?: Array<Record<string, unknown>>;
  /**
   * Then cards asking the person's OK, in order. A host card is fired as
   * chat-orchestrator fires the egress wall's: under the egress proxy's ctx,
   * never the turn's, the turn named only by the payload's reqId (the
   * invoke's, unless the card names another). A skill card is fired as
   * @ax/skill-broker fires request_capability's: under the runner's IPC ctx,
   * whose conversation is the turn's, and no reqId at all.
   */
  cards?: Array<Record<string, unknown>>;
  end?: 'turn-end' | 'turn-error';
}

/** The reply as it stood right after another turn's dark turn-end. */
interface AfterDark {
  /** Turn sinks still registered: 1 while the reply waits for its own turn. */
  sinks: number;
  /** Every Slack call by then but 👀's. */
  methods: string[];
}

interface HarnessOptions {
  /**
   * @ax/decisions' read, answering these rows for the turn's conversation.
   * Absent: no decisions service at all.
   */
  decisions?: unknown[];
  /** That read fails instead. */
  lookupFails?: boolean;
  /** Slack refuses a prompt's post. */
  postBlocksFails?: boolean;
  /** credential-proxy's `proxy:add-host` is not on the bus (a kernel booted without it). */
  noProxy?: boolean;
  /** chat-orchestrator's `agent:apply-capability-grant` is not on the bus. */
  noSkillGrant?: boolean;
  /** @ax/conversations' `conversations:get` is not on the bus. */
  noConversationGet?: boolean;
}

/** What Allow on a skill prompt calls (permission-prompts.ts), recorded: a turn never calls either. */
function skillServices(bus: HookBus, o: Pick<HarnessOptions, 'noSkillGrant' | 'noConversationGet'> = {}) {
  const calls: Array<{ hook: string; input: unknown }> = [];
  if (o.noConversationGet !== true) {
    bus.registerService('conversations:get', 'fake-conversations', async (_ctx, input) => {
      calls.push({ hook: 'conversations:get', input });
      throw new Error('a turn must not read its conversation back');
    });
  }
  if (o.noSkillGrant !== true) {
    bus.registerService('agent:apply-capability-grant', 'fake-chat-orchestrator', async (_ctx, input) => {
      calls.push({ hook: 'agent:apply-capability-grant', input });
      throw new Error('a turn must not attach a skill');
    });
  }
  return calls;
}

/** A catalog skill's description, as the card carries it. */
const DESCRIPTION = 'Reads and sends email from your Gmail account.';
/** A slot the person has no key for yet: Slack never collects one, so the card goes to the web app. */
const KEYLESS_SLOT = { slot: 'api_key', kind: 'api-key', service: 'gmail', haveExisting: false };

/** What `skillCard` reaches unless told otherwise: its prompt names it (TASK-1135). */
const GMAIL_REACH = { hosts: ['gmail.googleapis.com'], downloads: false };

/** request_capability's card for `skillId`, as @ax/skill-broker fires it: a skill that needs nothing but a yes, unless `slots` says otherwise. */
function skillCard(
  skillId: string,
  o: { description?: string; slots?: unknown[]; hosts?: string[] } = {},
): Record<string, unknown> {
  return {
    kind: 'skill',
    skillId,
    description: o.description ?? DESCRIPTION,
    hosts: o.hosts ?? GMAIL_REACH.hosts,
    slots: o.slots ?? [],
    packages: { npm: [], pypi: [] },
  };
}

function harness(script: Script = {}, o: HarnessOptions = {}) {
  const bus = new HookBus();
  const lines: LogLine[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, fields });
  };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  const registry = createTurnRegistry({ logger });
  subscribeTurnEvents(bus, registry, '@ax/channel-slack/turn-test');
  const invokes: Array<{ ctx: AgentContext; input: unknown }> = [];
  /** What the registry says the turn's mode is at the moment agent:invoke runs (TASK-1131). */
  const modesAtInvoke: Array<TurnMode | null> = [];
  const lookups: Array<{ ctx: AgentContext; input: unknown }> = [];
  /** proxy:add-host's calls. Only an Allow makes one (permission-prompts.ts): a turn never does. */
  const addHosts: Array<{ ctx: AgentContext; input: unknown }> = [];
  if (o.noProxy !== true) {
    bus.registerService('proxy:add-host', 'fake-credential-proxy', async (ctx, input) => {
      addHosts.push({ ctx, input });
      return { added: true };
    });
  }
  const skillCalls = skillServices(bus, o);
  if (o.decisions !== undefined || o.lookupFails === true) {
    bus.registerService('decisions:recent-for-conversation', 'fake-decisions', async (ctx, input) => {
      lookups.push({ ctx, input });
      // As @ax/decisions guards it: only the turn's own user and agent may read the conversation's decisions.
      const i = input as { userId: unknown; agentId: unknown };
      if (ctx.userId !== i.userId || ctx.agentId !== i.agentId) throw new Error('conversation decision scope mismatch');
      if (o.lookupFails === true) {
        throw new PluginError({ code: 'store-unavailable', plugin: 'fake-decisions', message: 'decisions down' });
      }
      return { decisions: o.decisions ?? [] };
    });
  }
  let minted = 0;
  const prompts = createPromptRegistry({
    now: () => Date.now(),
    // Call n of randomBytes fills every byte with n: one id per prompt.
    randomBytes: (size) => Buffer.alloc(size, ++minted),
    ttlMs: PROMPT_TTL_MS,
    max: PROMPT_MAX,
  });
  const afterDark: AfterDark[] = [];
  // Assigned below, once the fake Slack exists: the fake orchestrator reads it only when invoked.
  let slackCalls: () => SlackCall[] = () => [];
  /** The runner's events as the IPC listener fires them: under its own ctx, the turn named only in the payload. */
  const ipcCtxFor = (ctx: AgentContext): AgentContext =>
    makeAgentContext({
      sessionId: 'sess_live',
      agentId: ctx.agentId,
      userId: ctx.userId,
      ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
    });
  /** The egress proxy's events reach chat-orchestrator under no turn's ctx: no user, agent or conversation. */
  const egressCtx = makeAgentContext({ sessionId: 'credential-proxy', agentId: '', userId: '' });
  bus.registerService(
    'agent:invoke',
    'fake-orchestrator',
    async (ctx, input) => {
      modesAtInvoke.push(registry.modeOf(ctx.reqId, ctx.conversationId));
      invokes.push({ ctx, input });
      // The IPC listener restamps ctx.reqId; only the payload names the turn.
      const ipcCtx = ipcCtxFor(ctx);
      if (script.darkEndFirst === true) {
        await bus.fire('chat:turn-end', ipcCtx, { reason: 'complete' });
        afterDark.push({
          sinks: registry.size(),
          methods: slackCalls()
            .map((c) => c.method)
            .filter((m) => m !== 'addReaction' && m !== 'removeReaction'),
        });
        if (script.answeredByDarkEnd === true) return { kind: 'complete', messages: [] };
      }
      for (const chunk of script.chunks ?? [{ kind: 'text', text: 'ok' }]) {
        await bus.fire('chat:stream-chunk', ipcCtx, { reqId: ctx.reqId, ...chunk });
      }
      for (const card of script.cards ?? []) {
        if (card['kind'] === 'skill') await bus.fire('chat:permission-request', ipcCtx, card);
        else await bus.fire('chat:permission-request', egressCtx, { reqId: ctx.reqId, ...card });
      }
      if (script.end === 'turn-error') {
        await bus.fire('chat:turn-error', ipcCtx, { reqId: ctx.reqId, reason: 'chat-run-timeout' });
      } else {
        await bus.fire('chat:turn-end', ipcCtx, { reqId: ctx.reqId, reason: 'complete' });
      }
      return { kind: 'complete', messages: [] };
    },
    // Like the real one (AGENT_INVOKE_TIMEOUT_MS): no bus deadline, no stall watch.
    { timeoutMs: Number.POSITIVE_INFINITY, stallWarnMs: Number.POSITIVE_INFINITY },
  );
  const slack = fakeSlack(o.postBlocksFails === true ? { postBlocksFails: true } : {});
  slackCalls = () => slack.calls;

  const request = (mode: TurnMode, remembered = true): TurnRequest => ({
    mode,
    remembered,
    label: LABEL,
    install: INSTALL,
    botToken: BOT_TOKEN,
    channel: 'C07SUPPORT1',
    messageTs: '1763035201.000200',
    threadTs: '1763035200.000100',
    senderSlackId: SENDER,
    userId: 'usr_alice',
    agentId: 'agt_support',
    conversationId: 'conv_support_thread',
    // As Slack sends `is x < 3?`.
    text: 'is x &lt; 3?',
  });

  /** The invoked turn's own events, sent by the test: under the first invoke's reqId. */
  const turnOf = () => {
    const invoked = invokes[0];
    if (invoked === undefined) throw new Error('nothing was invoked');
    return { ipcCtx: ipcCtxFor(invoked.ctx), reqId: invoked.ctx.reqId };
  };

  return {
    invokes,
    modesAtInvoke,
    lookups,
    addHosts,
    skillCalls,
    prompts,
    afterDark,
    lines,
    /** The fields of every line logged as `msg`, in order. */
    logged: (msg: string) => lines.filter((l) => l.msg === msg).map((l) => l.fields),
    /** Turn sinks registered now: 1 while a reply waits on its turn. */
    sinks: () => registry.size(),
    own: {
      chunk: async (c: Record<string, unknown>): Promise<void> => {
        const { ipcCtx, reqId } = turnOf();
        await bus.fire('chat:stream-chunk', ipcCtx, { reqId, ...c });
      },
      end: async (): Promise<void> => {
        const { ipcCtx, reqId } = turnOf();
        await bus.fire('chat:turn-end', ipcCtx, { reqId, reason: 'complete' });
      },
    },
    /** Every Slack call but 👀's, in order. */
    calls: () => slack.calls.filter((c) => c.method !== 'addReaction' && c.method !== 'removeReaction'),
    reply: () => replyOf(slack.calls),
    /** The reply's own text: what its stream carried, without any message posted after it. */
    streamed: () => replyOf(slack.calls.filter((c) => c.method.endsWith('Stream'))),
    run: (mode: TurnMode, remembered = true) =>
      runTurn(
        {
          bus,
          api: slack.api,
          registry,
          prompts,
          publicOrigin: PUBLIC_ORIGIN,
          logger,
          clock: systemClock,
        },
        request(mode, remembered),
      ),
  };
}

/**
 * A decision as `decisions:recent-for-conversation` answers one
 * (decisions/src/types.ts `DecisionSchema`): every field, a pending hold of
 * `callId` in the turn's conversation, as Alice, unless `over` says otherwise.
 */
function decisionRow(id: string, callId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agentId: 'agt_support',
    ownerUserId: 'usr_alice',
    conversationId: 'conv_support_thread',
    kind: 'action',
    attendance: 'attended',
    status: 'pending',
    call: { id: callId, name: 'mcp__gmail__send_email', input: { to: 'bob@partner.example' } },
    callFingerprint: 'a'.repeat(64),
    ruleId: 'gmail-send',
    irreversible: true,
    freshness: null,
    summary: SUMMARY,
    detail: 'It stopped before doing this. Nothing has happened yet.',
    preview: null,
    primaryLabel: 'Yes, go ahead',
    secondaryLabel: 'Show me the details',
    ghostLabel: "No, I'll handle it",
    approvedText: 'Sent.',
    dismissedText: 'You declined this. Nothing was sent.',
    createdAt: '2026-11-14T12:00:00.000Z',
    expiresAt: '2026-11-15T12:00:00.000Z',
    resolvedAt: null,
    staleReason: null,
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayedAt: null,
    replayAbandonedAt: null,
    replayError: null,
    deliveryDueAt: null,
    deliveredAt: null,
    approvalScope: 'once',
    consentExpectedRevision: null,
    consentDeliveryState: 'none',
    consentGranted: null,
    consentDeliveryClaimedAt: null,
    routineReleaseAt: null,
    routineAuthorizationId: null,
    routineExecutionFingerprint: null,
    routineOutcome: null,
    routineFailureCode: null,
    routineFailureField: null,
    ...over,
  };
}

/** A decision's host-authored summary (decisions/src/templates.ts): the prompt's subject. */
const SUMMARY = 'Wants to use Gmail: Send email';

/** The `value` both of a posted prompt's buttons carry (they must agree). */
function promptIdOf(call: SlackCall): string {
  const blocks = call.args['blocks'] as Array<{ type: string; elements?: Array<Record<string, unknown>> }>;
  const values = blocks.filter((b) => b.type === 'actions').flatMap((b) => (b.elements ?? []).map((e) => e['value']));
  expect(values).toHaveLength(2);
  expect(values[0]).toBe(values[1]);
  return values[0] as string;
}

// ── The tests ───────────────────────────────────────────────────────────────

describe("turnContextFields: the one place a Slack turn's source and audience come from", () => {
  it.each([
    // The owner, in a 1:1 DM with their own personal agent.
    ['dm', { source: 'user', audience: 'private' }],
    // A channel member who can use the team agent: present, in a room.
    ['attended', { source: 'user', audience: 'shared' }],
    // Anyone else the channel admits, run as whoever connected the channel.
    ['external', { source: 'external', audience: 'shared' }],
  ] as const)('%s → %o', (mode, fields) => {
    expect(turnContextFields(mode)).toEqual(fields);
  });

  it.each(['DM', 'Attended', 'user', 'private', 'routine', '', undefined, null])(
    'a mode it does not know (%j) gets the most restricted context: an outsider, in a shared room',
    (mode) => {
      expect(turnContextFields(mode as unknown as TurnMode)).toEqual({ source: 'external', audience: 'shared' });
    },
  );
});

describe("runTurn: the agent runs as the request says, under its mode's context", () => {
  it.each([
    ['dm', 'user', 'private'],
    ['attended', 'user', 'shared'],
    ['external', 'external', 'shared'],
  ] as const)('a %s turn runs with source %s and audience %s', async (mode, source, audience) => {
    const h = harness();
    await h.run(mode);
    expect(h.invokes).toHaveLength(1);
    expect(h.modesAtInvoke).toEqual([mode]);
    const { ctx, input } = h.invokes[0]!;
    expect([ctx.userId, ctx.agentId, ctx.conversationId, ctx.source, ctx.audience]).toEqual([
      'usr_alice',
      'agt_support',
      'conv_support_thread',
      source,
      audience,
    ]);
    // The caller's label as it is, then the text as its sender typed it.
    expect(input).toEqual({ message: { role: 'user', content: `${LABEL}: is x < 3?` } });
    expect(h.reply()).toBe('ok');
  });
});

describe("runTurn: a conversation memory won't learn from says so before the label (TASK-1191)", () => {
  /*
    Walk TASK-1189, check 4: in a private channel the agent answered "I'll
    have it on hand next time" to "remember that my favorite fruit is
    mango", in a thread memory never learns from. Nothing in its input said
    so. The line is fixed text, on its own line before the label, where
    nothing the sender types can land.
  */
  it.each(['attended', 'external', 'dm'] as const)('%s, not remembered: the line, then the label and the words', async (mode) => {
    const h = harness();
    await h.run(mode, false);
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0]!.input).toEqual({
      message: { role: 'user', content: `This conversation isn't remembered: don't say you'll remember it.\n${LABEL}: is x < 3?` },
    });
  });

  it.each(['attended', 'external', 'dm'] as const)('%s, remembered: no line, the label first', async (mode) => {
    const h = harness();
    await h.run(mode, true);
    const content = (h.invokes[0]!.input as { message: { content: string } }).message.content;
    expect(content).toBe(`${LABEL}: is x < 3?`);
    expect(content).not.toContain('remember');
  });

  it('the line is the one the note exports, in plain words, naming no channel', () => {
    expect(SLACK_NOT_REMEMBERED_LINE).toBe("This conversation isn't remembered: don't say you'll remember it.");
    expect(SLACK_NOT_REMEMBERED_LINE).not.toMatch(/[#<@\n]/);
  });
});

describe("runTurn: another turn's dark turn-end is not this one's (TASK-1095)", () => {
  /*
    A Deny in Slack wakes the warm agent with no continuation id
    (decisions:dismiss takes none), so its reaction runs dark and its
    turn-end names no turn. The person's next message, sent right after the
    Deny, has its turn registered by then. Ending it there gave them "I
    didn't have anything to add." and dropped their real answer.
  */
  it.each(['dm', 'attended', 'external'] as const)(
    'a %s turn: a dark turn-end before its first chunk leaves the reply waiting, and its own chunks and end finish it',
    async (mode) => {
      const h = harness({ darkEndFirst: true, chunks: [{ kind: 'text', text: 'Here is what I found.' }] });
      await h.run(mode);
      // Right after the dark turn-end: still waiting for its own turn, nothing said.
      expect(h.afterDark).toEqual([{ sinks: 1, methods: [] }]);
      // Then the person's real answer, ended by its own turn-end.
      expect(h.reply()).toBe('Here is what I found.');
      expect(h.calls().map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    },
  );

  describe("when that dark turn-end also answers the turn's agent:invoke", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("its own turn streaming for longer than the invoke's grace: every word reaches the thread, and its own turn-end ends it", async () => {
      vi.useFakeTimers();
      const h = harness({ darkEndFirst: true, answeredByDarkEnd: true });
      const done = h.run('dm');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.afterDark).toEqual([{ sinks: 1, methods: [] }]);
      // Its own turn, after the dark one: twice the grace long, a chunk every half of it.
      for (const part of ['One. ', 'Two. ', 'Three. ', 'Four.']) {
        await vi.advanceTimersByTimeAsync(TURN_END_GRACE_MS / 2);
        await h.own.chunk({ kind: 'text', text: part });
      }
      expect(h.sinks()).toBe(1);
      await h.own.end();
      await done;
      expect(h.reply()).toBe('One. Two. Three. Four.');
      expect(h.sinks()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("the SDK loading a tool (ToolSearch) keeps its own turn alive too: plumbing shows nothing, but the grace runs from it (TASK-1130)", async () => {
      vi.useFakeTimers();
      const h = harness({ darkEndFirst: true, answeredByDarkEnd: true });
      const done = h.run('dm');
      await vi.advanceTimersByTimeAsync(0);
      const parts = [
        { kind: 'text', text: 'One. ' },
        { kind: 'tool-use', toolCallId: 'toolu_ts', toolName: 'ToolSearch', input: { query: 'select:mcp__ax-host-tools__routine_create' } },
        { kind: 'text', text: 'Three. ' },
        { kind: 'text', text: 'Four.' },
      ] as const;
      for (const part of parts) {
        await vi.advanceTimersByTimeAsync(TURN_END_GRACE_MS / 2);
        await h.own.chunk(part);
      }
      expect(h.sinks()).toBe(1);
      await h.own.end();
      await done;
      expect(h.reply()).toBe('One. \n\nThree. Four.');
      expect(cardTitlesOf(h.calls())).toEqual([]);
      expect(h.sinks()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('its own turn going quiet: the grace still finishes the reply, TURN_END_GRACE_MS after its last chunk', async () => {
      vi.useFakeTimers();
      const h = harness({ darkEndFirst: true, answeredByDarkEnd: true });
      const done = h.run('dm');
      await vi.advanceTimersByTimeAsync(TURN_END_GRACE_MS / 2);
      await h.own.chunk({ kind: 'text', text: 'Partly done.' });
      await vi.advanceTimersByTimeAsync(TURN_END_GRACE_MS - 1);
      expect(h.sinks()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(h.sinks()).toBe(0);
      expect(h.reply()).toBe('Partly done.');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('runTurn: a call held for approval ends the reply with one line saying who must approve', () => {
  /** A connector call the policy held: the runner marks its result held, then ends the turn. */
  const heldCall = (id: string): Array<Record<string, unknown>> => [
    { kind: 'tool-use', toolCallId: id, toolName: 'mcp__gmail__send_email', input: { to: 'bob@partner.example' } },
    { kind: 'tool-result', toolCallId: id, output: 'Held for approval: send_email to bob@partner.example', held: true },
  ];

  it.each([
    // Attended (a DM, or a channel member who can use the agent): decisions
    // files the hold under the person who wrote, so they approve it in Today.
    ['dm', 'sender', () => COPY.heldForSender(TODAY)],
    ['attended', 'sender', () => COPY.heldForSender(TODAY)],
    // External: the turn runs as whoever connected the channel, and the call
    // waits for them; the person who wrote can't approve it.
    ['external', 'owner', () => COPY.heldForOwner],
  ] as const)('a %s turn: the %s must approve', async (mode, _who, line) => {
    const h = harness({ chunks: [{ kind: 'text', text: 'Let me send that.' }, ...heldCall('c1')] });
    await h.run(mode);
    // The agent's words, then the line: nothing about the tool, its
    // connector, what it was asked to do, or whose approval it waits for.
    expect(h.reply()).toBe(`Let me send that.\n\n${line()}`);
  });

  it('two calls held in one turn: the line is said once', async () => {
    const h = harness({ chunks: [...heldCall('c1'), ...heldCall('c2')] });
    await h.run('external');
    expect(h.reply()).toBe(COPY.heldForOwner);
  });

  it('a held call, then the turn fails: the held line, then the failure line', async () => {
    const h = harness({ chunks: heldCall('c1'), end: 'turn-error' });
    await h.run('attended');
    expect(h.reply()).toBe(`${COPY.heldForSender(TODAY)}\n\n${COPY.turnFailed}`);
  });

  /*
    `held` is read before anything that drops a result: a runner may mark the
    held call's result as an error too (it never ran), and a result may come
    without its call's id. Dropped as a failed call, the reply would end
    without saying anything was waiting.
  */
  it.each([
    ['also marked as an error', { toolCallId: 'c1', isError: true }],
    ['with no call id', {}],
  ] as const)('a held result %s: still the held line', async (_name, extra) => {
    const h = harness({
      chunks: [
        { kind: 'text', text: 'Let me send that.' },
        { kind: 'tool-use', toolCallId: 'c1', toolName: 'mcp__gmail__send_email', input: {} },
        { kind: 'tool-result', output: 'Held for approval', held: true, ...extra },
      ],
    });
    await h.run('attended');
    expect(h.reply()).toBe(`Let me send that.\n\n${COPY.heldForSender(TODAY)}`);
  });
});

describe('runTurn: a held call the person who wrote can answer gets a prompt after the reply (TASK-1095)', () => {
  /** A connector call the policy held: the runner marks its result held, then ends the turn. */
  const heldCall = (id: string): Array<Record<string, unknown>> => [
    { kind: 'tool-use', toolCallId: id, toolName: 'mcp__gmail__send_email', input: { to: 'bob@partner.example' } },
    { kind: 'tool-result', toolCallId: id, output: 'Held for approval', held: true },
  ];
  const SAID = { kind: 'text', text: 'Let me send that.' };
  const CHANNEL = 'C07SUPPORT1';
  const THREAD = '1763035200.000100';

  it.each(['dm', 'attended'] as const)(
    'a %s turn: the reply ends asking, then one prompt for the held call follows in its thread',
    async (mode) => {
      const h = harness(
        { chunks: [SAID, ...heldCall('toolu_held')] },
        { decisions: [decisionRow('dec_other', 'toolu_other'), decisionRow('dec_held', 'toolu_held')] },
      );
      await h.run(mode);

      // The ask ends the reply: no Today line in it, since the prompt below carries the link.
      expect(h.streamed()).toBe(`Let me send that.\n\n${COPY.heldAsked}`);
      // Then exactly one prompt, in the reply's thread, once the reply's stream has stopped.
      const methods = h.calls().map((c) => c.method);
      expect(methods.filter((m) => m === 'postBlocks')).toHaveLength(1);
      expect(methods.at(-1)).toBe('postBlocks');
      expect(methods.indexOf('postBlocks')).toBeGreaterThan(methods.lastIndexOf('stopStream'));
      expect(methods).not.toContain('postMessage');
      const post = h.calls().at(-1)!;
      expect(post.token).toBe(BOT_TOKEN);
      expect(post.args).toMatchObject({ channel: CHANNEL, threadTs: THREAD, text: COPY.heldAsked });
      // Its subject is the decision's own summary.
      expect((post.args['blocks'] as Array<{ text?: { text?: string } }>)[0]!.text!.text).toBe(SUMMARY);

      // Its buttons name an open prompt: for that decision, answerable only by the sender, run as the turn ran.
      const id = promptIdOf(post);
      expect(h.prompts.claim(id, 'U07SOMEONE1')).toMatchObject({ ok: false, reason: 'not-asker' });
      const claim = h.prompts.claim(id, SENDER);
      expect(claim.ok).toBe(true);
      expect(claim.ok && claim.prompt).toMatchObject({
        installId: INSTALL.installId,
        teamId: INSTALL.teamId,
        channel: CHANNEL,
        threadTs: THREAD,
        askerSlackId: SENDER,
        userId: 'usr_alice',
        agentId: 'agt_support',
        conversationId: 'conv_support_thread',
        mode,
        subject: { kind: 'decision', decisionId: 'dec_held' },
        subjectText: SUMMARY,
        messageTs: PROMPT_TS,
      });
      expect(h.prompts.size()).toBe(1);

      // Found by asking @ax/decisions once, as the turn, for the turn's conversation.
      expect(h.lookups.map((l) => l.input)).toEqual([
        { userId: 'usr_alice', agentId: 'agt_support', conversationId: 'conv_support_thread' },
      ]);
      expect(h.lookups[0]!.ctx.reqId).toBe(h.invokes[0]!.ctx.reqId);
      expect(h.lookups[0]!.ctx).toMatchObject({ userId: 'usr_alice', agentId: 'agt_support', source: 'user' });
    },
  );

  it.each(['dm', 'attended'] as const)(
    'a %s turn whose held call has no pending decision: the Today line, and no prompt',
    async (mode) => {
      const h = harness(
        { chunks: [SAID, ...heldCall('toolu_held')] },
        // Another call's, and this call's own but already answered (a hold it reused links Today instead).
        { decisions: [decisionRow('dec_other', 'toolu_other'), decisionRow('dec_done', 'toolu_held', { status: 'executed' })] },
      );
      await h.run(mode);
      expect(h.reply()).toBe(`Let me send that.\n\n${COPY.heldForSender(TODAY)}`);
      expect(h.calls().map((c) => c.method)).not.toContain('postBlocks');
      expect(h.lookups).toHaveLength(1);
      expect(h.prompts.size()).toBe(0);
    },
  );

  it('the lookup fails: the Today line, and no prompt', async () => {
    const h = harness({ chunks: [SAID, ...heldCall('toolu_held')] }, { lookupFails: true });
    await h.run('attended');
    expect(h.reply()).toBe(`Let me send that.\n\n${COPY.heldForSender(TODAY)}`);
    expect(h.calls().map((c) => c.method)).not.toContain('postBlocks');
    expect(h.lookups).toHaveLength(1);
  });

  it.each(['dm', 'attended'] as const)(
    'a %s turn: Slack refuses the prompt, so the Today line follows as a message of its own, and nothing is left open',
    async (mode) => {
      const h = harness(
        { chunks: [SAID, ...heldCall('toolu_held')] },
        { decisions: [decisionRow('dec_held', 'toolu_held')], postBlocksFails: true },
      );
      await h.run(mode);
      expect(h.streamed()).toBe(`Let me send that.\n\n${COPY.heldAsked}`);
      const calls = h.calls();
      expect(calls.slice(-2).map((c) => c.method)).toEqual(['postBlocks', 'postMessage']);
      expect(calls.at(-1)!.args).toEqual({ channel: CHANNEL, threadTs: THREAD, markdownText: COPY.heldForSender(TODAY) });
      expect(h.prompts.size()).toBe(0);
    },
  );

  // Card acceptance: an outsider's turn never shows buttons.
  it("an outsider's turn: its owner's line, no lookup and no prompt, even with the call's decision pending", async () => {
    const h = harness({ chunks: [SAID, ...heldCall('toolu_held')] }, { decisions: [decisionRow('dec_held', 'toolu_held')] });
    await h.run('external');
    expect(h.reply()).toBe(`Let me send that.\n\n${COPY.heldForOwner}`);
    expect(h.lookups).toEqual([]);
    expect(h.calls().map((c) => c.method)).not.toContain('postBlocks');
    expect(h.prompts.size()).toBe(0);
  });

  it('two calls held in one turn: one prompt, for the first', async () => {
    const h = harness(
      { chunks: [...heldCall('toolu_first'), ...heldCall('toolu_second')] },
      { decisions: [decisionRow('dec_second', 'toolu_second'), decisionRow('dec_first', 'toolu_first')] },
    );
    await h.run('dm');
    expect(h.streamed()).toBe(COPY.heldAsked);
    const posts = h.calls().filter((c) => c.method === 'postBlocks');
    expect(posts).toHaveLength(1);
    const claim = h.prompts.claim(promptIdOf(posts[0]!), SENDER);
    expect(claim.ok && claim.prompt.subject).toEqual({ kind: 'decision', decisionId: 'dec_first' });
    expect(h.lookups).toHaveLength(1);
  });

  it('a held result with no call id: no lookup, the Today line, and no prompt', async () => {
    const h = harness(
      {
        chunks: [
          SAID,
          { kind: 'tool-use', toolCallId: 'toolu_held', toolName: 'mcp__gmail__send_email', input: {} },
          { kind: 'tool-result', output: 'Held for approval', held: true },
        ],
      },
      { decisions: [decisionRow('dec_held', 'toolu_held')] },
    );
    await h.run('dm');
    expect(h.reply()).toBe(`Let me send that.\n\n${COPY.heldForSender(TODAY)}`);
    expect(h.lookups).toEqual([]);
    expect(h.calls().map((c) => c.method)).not.toContain('postBlocks');
  });

  it('a held call, then the turn fails: the ask, then the failure line, then the prompt', async () => {
    const h = harness(
      { chunks: [SAID, ...heldCall('toolu_held')], end: 'turn-error' },
      { decisions: [decisionRow('dec_held', 'toolu_held')] },
    );
    await h.run('attended');
    expect(h.streamed()).toBe(`Let me send that.\n\n${COPY.heldAsked}\n\n${COPY.turnFailed}`);
    expect(h.calls().at(-1)!.method).toBe('postBlocks');
    expect(h.prompts.size()).toBe(1);
  });
});

describe('runTurn: a host the sandbox was refused gets a prompt after the reply, when the person who wrote can allow it (TASK-1095)', () => {
  const SAID = { kind: 'text', text: 'I could not reach that site.' };
  const CHANNEL = 'C07SUPPORT1';
  const THREAD = '1763035200.000100';
  /** The turn's live sandbox session, as the egress proxy names it on the card. */
  const SESSION = 'sess_live';
  /** The egress wall's card for `host`: chat-orchestrator fires it while the turn runs. */
  const hostCard = (host: string): Record<string, unknown> => ({ kind: 'host', host, sessionId: SESSION });
  const heldCall = (id: string): Array<Record<string, unknown>> => [
    { kind: 'tool-use', toolCallId: id, toolName: 'mcp__gmail__send_email', input: {} },
    { kind: 'tool-result', toolCallId: id, output: 'Held for approval', held: true },
  ];
  type Block = { type: string; text?: { text?: string } };
  const posts = (calls: readonly SlackCall[]): SlackCall[] => calls.filter((c) => c.method === 'postBlocks');
  /** What each posted prompt asks: its section's text. */
  const subjects = (calls: readonly SlackCall[]): string[] =>
    posts(calls).map((c) => (c.args['blocks'] as Block[])[0]!.text!.text!);

  it.each(['dm', 'attended'] as const)(
    "a %s turn: after the reply, one prompt to connect to the host, for the turn's own live session, linking nowhere",
    async (mode) => {
      const h = harness({ chunks: [SAID], cards: [hostCard('api.example.com')] });
      await h.run(mode);

      // The reply is the agent's own words; the prompt follows it, once its stream has stopped.
      expect(h.streamed()).toBe('I could not reach that site.');
      const methods = h.calls().map((c) => c.method);
      expect(methods.filter((m) => m === 'postBlocks')).toHaveLength(1);
      expect(methods.at(-1)).toBe('postBlocks');
      expect(methods.indexOf('postBlocks')).toBeGreaterThan(methods.lastIndexOf('stopStream'));
      expect(methods).not.toContain('postMessage');
      const post = h.calls().at(-1)!;
      expect(post.token).toBe(BOT_TOKEN);
      expect(post.args).toMatchObject({ channel: CHANNEL, threadTs: THREAD, text: COPY.heldAsked });
      const blocks = post.args['blocks'] as Block[];
      // The host is shown only as the subject: plain_text.
      expect(blocks[0]).toEqual({
        type: 'section',
        text: { type: 'plain_text', text: COPY.hostSubject('api.example.com'), emoji: false },
      });
      // Nothing about a blocked host waits in Today (channel-web keeps host cards out of it): no Today line.
      expect(blocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: COPY.promptOnlyAsker }] });
      expect(JSON.stringify(post.args)).not.toContain(TODAY);

      // Its buttons name an open prompt for that host and that session, answerable only by the sender, run as the turn ran.
      const id = promptIdOf(post);
      expect(h.prompts.claim(id, 'U07SOMEONE1')).toMatchObject({ ok: false, reason: 'not-asker' });
      const claim = h.prompts.claim(id, SENDER);
      expect(claim.ok && claim.prompt).toMatchObject({
        installId: INSTALL.installId,
        teamId: INSTALL.teamId,
        channel: CHANNEL,
        threadTs: THREAD,
        askerSlackId: SENDER,
        userId: 'usr_alice',
        agentId: 'agt_support',
        conversationId: 'conv_support_thread',
        mode,
        subject: { kind: 'host', host: 'api.example.com', sessionId: SESSION },
        subjectText: COPY.hostSubject('api.example.com'),
        messageTs: PROMPT_TS,
      });
      expect(h.prompts.size()).toBe(1);
      // The turn only asks: nothing is let through until the person answers.
      expect(h.addHosts).toEqual([]);
      expect(h.logged('slack_permission_skipped')).toEqual([]);
    },
  );

  it('a host the proxy would never take is never shown: no prompt, counted in the log without it', async () => {
    const tooLong = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    expect(tooLong).toHaveLength(254);
    const refused = ['<!channel>', 'a b', 'EXAMPLE.com', tooLong];
    const h = harness({ chunks: [SAID], cards: refused.map(hostCard) });
    await h.run('attended');
    expect(posts(h.calls())).toEqual([]);
    expect(h.prompts.size()).toBe(0);
    expect(h.logged('slack_permission_skipped')).toEqual([
      { installId: INSTALL.installId, reason: 'invalid-host', count: refused.length },
    ]);
    const all = JSON.stringify(h.lines) + JSON.stringify(h.calls());
    for (const host of ['<!channel>', 'EXAMPLE.com', tooLong]) expect(all, host).not.toContain(host);
  });

  it('two cards for one host: one prompt', async () => {
    const h = harness({ chunks: [SAID], cards: [hostCard('api.example.com'), hostCard('api.example.com')] });
    await h.run('dm');
    expect(subjects(h.calls())).toEqual([COPY.hostSubject('api.example.com')]);
    expect(h.prompts.size()).toBe(1);
    expect(h.logged('slack_permission_skipped')).toEqual([]);
  });

  it(`more hosts than PERMISSION_PROMPTS_PER_TURN_MAX: prompts for the first ones, in the order they came; the rest counted, a repeat not`, async () => {
    const hosts = ['one.example.com', 'two.example.com', 'three.example.com', 'four.example.com'];
    expect(hosts).toHaveLength(PERMISSION_PROMPTS_PER_TURN_MAX + 1);
    // A repeat of one already asked about, once the cap is reached: the same prompt, not one over the cap.
    const cards = [...hosts.slice(0, -1), hosts[0]!, hosts.at(-1)!].map(hostCard);
    const h = harness({ chunks: [SAID], cards });
    await h.run('attended');
    expect(subjects(h.calls())).toEqual(hosts.slice(0, PERMISSION_PROMPTS_PER_TURN_MAX).map((x) => COPY.hostSubject(x)));
    expect(h.prompts.size()).toBe(PERMISSION_PROMPTS_PER_TURN_MAX);
    expect(h.logged('slack_permission_skipped')).toEqual([{ installId: INSTALL.installId, reason: 'cap', count: 1 }]);
  });

  // Card acceptance: an outsider's turn never shows buttons.
  it("an outsider's turn: no prompt and nothing opened, counted as an outsider's", async () => {
    const h = harness({ chunks: [SAID], cards: [hostCard('api.example.com')] });
    await h.run('external');
    expect(h.reply()).toBe('I could not reach that site.');
    expect(posts(h.calls())).toEqual([]);
    expect(h.prompts.size()).toBe(0);
    expect(h.addHosts).toEqual([]);
    expect(h.logged('slack_permission_skipped')).toEqual([{ installId: INSTALL.installId, reason: 'outsider', count: 1 }]);
  });

  it("a held call and a refused host in one turn: the held call's prompt first, then the host's; only the first links Today", async () => {
    const h = harness(
      { chunks: [SAID, ...heldCall('toolu_held')], cards: [hostCard('api.example.com')] },
      { decisions: [decisionRow('dec_held', 'toolu_held')] },
    );
    await h.run('attended');
    expect(subjects(h.calls())).toEqual([SUMMARY, COPY.hostSubject('api.example.com')]);
    const [held, host] = posts(h.calls()).map((c) => JSON.stringify(c.args['blocks']));
    expect(held).toContain(TODAY);
    expect(host).not.toContain(TODAY);
    expect(h.prompts.size()).toBe(2);
  });

  it('without proxy:add-host on the bus, a refused host is not offered: no prompt, counted as unavailable', async () => {
    const h = harness({ chunks: [SAID], cards: [hostCard('api.example.com')] }, { noProxy: true });
    await h.run('dm');
    expect(posts(h.calls())).toEqual([]);
    expect(h.prompts.size()).toBe(0);
    expect(h.logged('slack_permission_skipped')).toEqual([
      { installId: INSTALL.installId, reason: 'unavailable', count: 1 },
    ]);
  });

  it("another turn's host card is not this one's", async () => {
    const h = harness({ chunks: [SAID], cards: [{ ...hostCard('api.example.com'), reqId: 'req-0ther0000001' }] });
    await h.run('dm');
    expect(posts(h.calls())).toEqual([]);
    expect(h.prompts.size()).toBe(0);
    expect(h.logged('slack_permission_skipped')).toEqual([]);
  });

  it("another turn's host card beside this turn's own: only this turn's is asked", async () => {
    const h = harness({
      chunks: [SAID],
      cards: [{ ...hostCard('api.example.com'), reqId: 'req-0ther0000001' }, hostCard('files.example.org')],
    });
    await h.run('dm');
    expect(subjects(h.calls())).toEqual([COPY.hostSubject('files.example.org')]);
    expect(h.prompts.size()).toBe(1);
    expect(h.logged('slack_permission_skipped')).toEqual([]);
  });

  it('Slack refuses the prompt: nothing is left open, and nothing else is posted', async () => {
    const h = harness({ chunks: [SAID], cards: [hostCard('api.example.com')] }, { postBlocksFails: true });
    await h.run('attended');
    expect(posts(h.calls())).toHaveLength(1);
    expect(h.calls().map((c) => c.method)).not.toContain('postMessage');
    expect(h.prompts.size()).toBe(0);
    expect(h.logged('slack_reply_failed')).toEqual([
      { installId: INSTALL.installId, stage: 'prompt', code: 'invalid_blocks' },
    ]);
  });

  it('a refused host, then the turn fails: the failure line, then the prompt', async () => {
    const h = harness({ chunks: [SAID], cards: [hostCard('api.example.com')], end: 'turn-error' });
    await h.run('dm');
    expect(h.streamed()).toBe(`I could not reach that site.\n\n${COPY.turnFailed}`);
    expect(h.calls().at(-1)!.method).toBe('postBlocks');
    expect(subjects(h.calls())).toEqual([COPY.hostSubject('api.example.com')]);
    expect(h.prompts.size()).toBe(1);
  });
});

describe('runTurn: a catalog skill the agent asked to use gets a prompt after the reply, when the person who wrote can connect it (TASK-1095)', () => {
  const SAID = { kind: 'text', text: 'I need one more thing for that.' };
  const CHANNEL = 'C07SUPPORT1';
  const THREAD = '1763035200.000100';
  const SUBJECT = COPY.skillSubject('gmail-sender', DESCRIPTION, GMAIL_REACH);
  type Block = { type: string; text?: { text?: string } };
  const posts = (calls: readonly SlackCall[]): SlackCall[] => calls.filter((c) => c.method === 'postBlocks');
  const subjects = (calls: readonly SlackCall[]): string[] =>
    posts(calls).map((c) => (c.args['blocks'] as Block[])[0]!.text!.text!);
  /** A skill that needs a key first, posted the way it must be: its subject and the web app, nothing to click. */
  const toTheWebApp = (subject: string = SUBJECT) =>
    JSON.parse(
      JSON.stringify({ channel: CHANNEL, threadTs: THREAD, ...linkOnlyBlocks({ subject, line: COPY.skillNeedsWeb(TODAY) }) }),
    ) as Record<string, unknown>;

  it.each(['dm', 'attended'] as const)(
    "a %s turn: after the reply, one prompt to connect the skill, linking Today, where the same request waits",
    async (mode) => {
      const h = harness({ chunks: [SAID], cards: [skillCard('gmail-sender')] });
      await h.run(mode);

      expect(h.streamed()).toBe('I need one more thing for that.');
      const methods = h.calls().map((c) => c.method);
      expect(methods.filter((m) => m === 'postBlocks')).toHaveLength(1);
      expect(methods.at(-1)).toBe('postBlocks');
      expect(methods.indexOf('postBlocks')).toBeGreaterThan(methods.lastIndexOf('stopStream'));
      expect(methods).not.toContain('postMessage');
      const post = h.calls().at(-1)!;
      expect(post.token).toBe(BOT_TOKEN);
      expect(post.args).toMatchObject({ channel: CHANNEL, threadTs: THREAD, text: COPY.heldAsked });
      const blocks = post.args['blocks'] as Block[];
      // The catalog's description, shown only as the subject: plain_text.
      expect(blocks[0]).toEqual({ type: 'section', text: { type: 'plain_text', text: SUBJECT, emoji: false } });
      // A skill card waits in Today too (channel-web keeps it there): the prompt links it.
      expect(blocks.at(-1)).toEqual({
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: COPY.promptOnlyAsker },
          { type: 'mrkdwn', text: COPY.promptToday(TODAY) },
        ],
      });

      // Its buttons name an open prompt for that skill, answerable only by the sender, run as the turn ran.
      const id = promptIdOf(post);
      expect(h.prompts.claim(id, 'U07SOMEONE1')).toMatchObject({ ok: false, reason: 'not-asker' });
      const claim = h.prompts.claim(id, SENDER);
      expect(claim.ok && claim.prompt).toMatchObject({
        installId: INSTALL.installId,
        teamId: INSTALL.teamId,
        channel: CHANNEL,
        threadTs: THREAD,
        askerSlackId: SENDER,
        userId: 'usr_alice',
        agentId: 'agt_support',
        conversationId: 'conv_support_thread',
        mode,
        subject: { kind: 'skill', skillId: 'gmail-sender' },
        subjectText: SUBJECT,
        messageTs: PROMPT_TS,
      });
      expect(h.prompts.size()).toBe(1);
      // The turn only asks: nothing is read back and nothing attached until the person answers.
      expect(h.skillCalls).toEqual([]);
      expect(h.logged('slack_permission_skipped')).toEqual([]);
    },
  );

  it('a skill that needs a key: its subject and a link to the web app, with nothing to click and nothing opened', async () => {
    const h = harness({ chunks: [SAID], cards: [skillCard('gmail-sender', { slots: [KEYLESS_SLOT] })] });
    await h.run('attended');

    const sent = posts(h.calls());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args).toEqual(toTheWebApp());
    const payload = JSON.stringify(sent[0]!.args);
    for (const clickable of ['"actions"', '"button"', '"action_id"', '"value"']) expect(payload).not.toContain(clickable);
    expect(h.prompts.size()).toBe(0);
    expect(h.calls().map((c) => c.method)).not.toContain('postMessage');
    expect(h.skillCalls).toEqual([]);
  });

  it('the prompt names the host the skill reaches (TASK-1135)', async () => {
    const h = harness({ chunks: [SAID], cards: [skillCard('gmail-sender', { hosts: ['api.open-meteo.com'] })] });
    await h.run('dm');
    expect(subjects(h.calls())[0]).toBe(
      cleanPromptSubject(COPY.skillSubject('gmail-sender', DESCRIPTION, { hosts: ['api.open-meteo.com'], downloads: false })),
    );
    expect(subjects(h.calls())[0]).toContain('which needs to reach api.open-meteo.com.');
    // Named whole, so it is asked with Allow and Deny: a prompt is open for it.
    expect(h.prompts.size()).toBe(1);
  });

  /** The card without `hosts` and `packages`, as an older (or broken) producer might fire it. */
  const withoutReach = (card: Record<string, unknown>): Record<string, unknown> => {
    const { hosts: _hosts, packages: _packages, ...rest } = card;
    return rest;
  };

  it.each([
    ['no hosts or packages on it', withoutReach(skillCard('gmail-sender'))],
    ['a host the egress proxy would refuse', skillCard('gmail-sender', { hosts: ['API.example.com'] })],
  ])(
    "a card whose reach can't be named whole (%s): the link to the web app, naming no host, with nothing opened (TASK-1135)",
    async (_name, card) => {
      const h = harness({ chunks: [SAID], cards: [card] });
      await h.run('dm');
      expect(posts(h.calls()).map((c) => c.args)).toEqual([toTheWebApp(COPY.skillSubject('gmail-sender', DESCRIPTION))]);
      expect(h.prompts.size()).toBe(0);
      expect(h.skillCalls).toEqual([]);
    },
  );

  it.each([
    ['the grant', { noSkillGrant: true }],
    ['the ownership read the grant needs first', { noConversationGet: true }],
  ] as const)('without %s on the bus, a skill is not answered here: a link to the web app instead', async (_name, o) => {
    const h = harness({ chunks: [SAID], cards: [skillCard('gmail-sender')] }, o);
    await h.run('dm');
    expect(posts(h.calls()).map((c) => c.args)).toEqual([toTheWebApp()]);
    expect(h.prompts.size()).toBe(0);
    expect(h.logged('slack_permission_skipped')).toEqual([]);
  });

  // Card acceptance: an outsider's turn never shows buttons.
  it("an outsider's turn: nothing posted and nothing opened, not even a link, counted as an outsider's", async () => {
    const h = harness({
      chunks: [SAID],
      cards: [skillCard('gmail-sender'), skillCard('drive-reader', { slots: [KEYLESS_SLOT] })],
    });
    await h.run('external');
    expect(h.reply()).toBe('I need one more thing for that.');
    expect(posts(h.calls())).toEqual([]);
    expect(h.prompts.size()).toBe(0);
    expect(h.skillCalls).toEqual([]);
    expect(h.logged('slack_permission_skipped')).toEqual([{ installId: INSTALL.installId, reason: 'outsider', count: 2 }]);
  });

  it('two cards for one skill: one prompt', async () => {
    const h = harness({ chunks: [SAID], cards: [skillCard('gmail-sender'), skillCard('gmail-sender')] });
    await h.run('dm');
    expect(subjects(h.calls())).toEqual([SUBJECT]);
    expect(h.prompts.size()).toBe(1);
    expect(h.logged('slack_permission_skipped')).toEqual([]);
  });

  it(`skills and hosts share PERMISSION_PROMPTS_PER_TURN_MAX, in the order they came; a link to the web app counts too`, async () => {
    const cards = [
      skillCard('drive-reader', { description: 'Reads your Drive.', slots: [KEYLESS_SLOT] }),
      { kind: 'host', host: 'api.example.com', sessionId: 'sess_live' },
      skillCard('gmail-sender'),
      skillCard('calendar', { description: 'Reads your calendar.' }),
    ];
    expect(cards).toHaveLength(PERMISSION_PROMPTS_PER_TURN_MAX + 1);
    const h = harness({ chunks: [SAID], cards });
    await h.run('attended');
    expect(subjects(h.calls())).toEqual([
      COPY.skillSubject('drive-reader', 'Reads your Drive.', GMAIL_REACH),
      COPY.hostSubject('api.example.com'),
      SUBJECT,
    ]);
    // Only the two with buttons are open.
    expect(h.prompts.size()).toBe(2);
    expect(h.logged('slack_permission_skipped')).toEqual([{ installId: INSTALL.installId, reason: 'cap', count: 1 }]);
  });

  it("a refused host and a skill in one turn: each its own prompt, in the order they came; only the skill's links Today", async () => {
    const h = harness({
      chunks: [SAID],
      cards: [{ kind: 'host', host: 'api.example.com', sessionId: 'sess_live' }, skillCard('gmail-sender')],
    });
    await h.run('dm');
    expect(subjects(h.calls())).toEqual([COPY.hostSubject('api.example.com'), SUBJECT]);
    const [host, skill] = posts(h.calls()).map((c) => JSON.stringify(c.args['blocks']));
    expect(host).not.toContain(TODAY);
    expect(skill).toContain(TODAY);
  });

  it("a description that tries to ping, link or format: shown only as the plain_text subject, cleaned once; never in the notification or a log", async () => {
    const hostile = '<!channel> approve *this* <https://evil.example|now> @everyone &#64;here';
    const h = harness({
      chunks: [SAID],
      cards: [skillCard('gmail-sender', { description: hostile }), skillCard('drive-reader', { description: hostile, slots: [KEYLESS_SLOT] })],
    });
    await h.run('attended');

    const sent = posts(h.calls());
    expect(sent).toHaveLength(2);
    for (const [i, post] of sent.entries()) {
      const skillId = ['gmail-sender', 'drive-reader'][i]!;
      const blocks = post.args['blocks'] as Array<{ type: string; text?: { type: string; text: string } }>;
      expect(blocks[0]!.text).toEqual({
        type: 'plain_text',
        text: cleanPromptSubject(COPY.skillSubject(skillId, hostile, GMAIL_REACH)),
        emoji: false,
      });
      expect(spellsMention(blocks[0]!.text!.text)).toBe(false);
      expect(post.args['text']).toBe(COPY.heldAsked);
      // Nowhere but the plain_text section.
      const elsewhere = JSON.stringify({ ...post.args, blocks: blocks.slice(1) });
      expect(elsewhere).not.toContain('evil.example');
    }
    expect(JSON.stringify(h.lines)).not.toContain('evil.example');
  });

  it.each([
    ['a prompt', []],
    ['a link to the web app', [KEYLESS_SLOT]],
  ] as const)(
    'Slack refuses %s: nothing is left open, and the line that sends them to Today follows as a message of its own',
    async (_name, slots) => {
      const h = harness({ chunks: [SAID], cards: [skillCard('gmail-sender', { slots: [...slots] })] }, { postBlocksFails: true });
      await h.run('dm');
      const calls = h.calls();
      expect(calls.slice(-2).map((c) => c.method)).toEqual(['postBlocks', 'postMessage']);
      expect(calls.at(-1)!.args).toEqual({ channel: CHANNEL, threadTs: THREAD, markdownText: COPY.heldForSender(TODAY) });
      expect(h.prompts.size()).toBe(0);
      expect(h.logged('slack_reply_failed')).toEqual([
        { installId: INSTALL.installId, stage: 'prompt', code: 'invalid_blocks' },
      ]);
    },
  );
});

// ── Following a woken agent's turn into the prompt's thread (Task 8) ───────

/**
 * The continuation's reqId: the Allow minted it, @ax/decisions echoed it as
 * `streamReqId`, and the woken runner stamps the turn's chunks and its end
 * with it.
 */
const CONTINUATION = 'req-c0ffee000001';
/** Another turn running meanwhile. */
const ELSEWHERE = 'req-0ther0000001';

interface LogLine {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

describe("followContinuation: after Allow, the agent's next turn is followed into the prompt's thread (TASK-1095)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const CHANNEL = 'C07SUPPORT1';
  const THREAD = '1763035200.000100';
  /**
   * The answered prompt's turn, and every prompt a continuation of it asks.
   * Its install and workspace differ from INSTALL's on purpose: the follower
   * takes both from the prompt (host-recorded when it was posted).
   */
  const CONTEXT = {
    installId: 'Pr0mptInstall0Id000001',
    teamId: 'T07PROMPTTM1',
    channel: CHANNEL,
    threadTs: THREAD,
    askerSlackId: SENDER,
    userId: 'usr_alice',
    agentId: 'agt_support',
    conversationId: 'conv_support_thread',
  } as const;

  function follower(
    o: {
      mode?: 'dm' | 'attended';
      decisions?: unknown[];
      /** decisions:get's answer (the row read back when the follower gives up); a throw is the hook's. Absent: no such service. */
      get?: () => unknown;
      /** The prompt's message as the gate redrew it: PROMPT_TS unless set. */
      messageTs?: string | null;
      /** Slack refuses the prompt's redraw. */
      updateFails?: boolean;
    } = {},
  ) {
    const bus = new HookBus();
    const slack = fakeSlack(o.updateFails === true ? { updateMessageFails: true } : {});
    const lines: LogLine[] = [];
    const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      lines.push({ level, msg, fields });
    };
    const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
    const registry = createTurnRegistry({ logger });
    subscribeTurnEvents(bus, registry, '@ax/channel-slack/turn-test');
    const lookups: Array<{ ctx: AgentContext; input: unknown }> = [];
    if (o.decisions !== undefined) {
      const rows = o.decisions;
      bus.registerService('decisions:recent-for-conversation', 'fake-decisions', async (ctx, input) => {
        lookups.push({ ctx, input });
        // As @ax/decisions guards it: only the turn's own user and agent may read the conversation's decisions.
        const i = input as { userId: unknown; agentId: unknown };
        if (ctx.userId !== i.userId || ctx.agentId !== i.agentId) throw new Error('conversation decision scope mismatch');
        return { decisions: rows };
      });
    }
    const gets: Array<{ ctx: AgentContext; input: unknown }> = [];
    if (o.get !== undefined) {
      const get = o.get;
      bus.registerService('decisions:get', 'fake-decisions', async (ctx, input) => {
        gets.push({ ctx, input });
        return get();
      });
    }
    // chat-orchestrator's `agent:interrupt`: `{ conversationId, userId }` in, `{ interrupted }` out.
    const interrupts: Array<{ ctx: AgentContext; input: unknown }> = [];
    bus.registerService('agent:interrupt', 'fake-orchestrator', async (ctx, input) => {
      interrupts.push({ ctx, input });
      return { interrupted: true };
    });
    // What a skill prompt's Allow calls: a follower never calls either.
    const skillCalls = skillServices(bus);
    let minted = 0;
    const prompts = createPromptRegistry({
      now: () => Date.now(),
      randomBytes: (size) => Buffer.alloc(size, ++minted),
      ttlMs: PROMPT_TTL_MS,
      max: PROMPT_MAX,
    });
    // The prompt Alice answered: posted after her turn, then settled by her Allow (answers.ts).
    const prompt = prompts.add({ ...CONTEXT, mode: o.mode ?? 'attended' }, { kind: 'decision', decisionId: 'dec_held' }, SUMMARY);
    prompts.posted(prompt.id, PROMPT_TS);
    prompts.settle(prompt.id);
    // The woken runner's events as the IPC listener fires them: under its own
    // ctx (it restamps the reqId), the turn named only in the payload.
    const ipcCtx = makeAgentContext({
      sessionId: 'sess_live',
      agentId: 'agt_support',
      userId: 'usr_alice',
      conversationId: 'conv_support_thread',
    });
    const request = (pendingUntil: string | null): ContinuationRequest => ({
      prompt,
      botToken: BOT_TOKEN,
      reqId: CONTINUATION,
      pendingUntil,
      messageTs: o.messageTs === undefined ? PROMPT_TS : o.messageTs,
    });
    return {
      registry,
      prompts,
      lines,
      lookups,
      gets,
      interrupts,
      skillCalls,
      /** Every Slack call, 👀 included. */
      all: () => slack.calls,
      reply: () => replyOf(slack.calls),
      follow: (pendingUntil: string | null) =>
        followContinuation(
          { bus, api: slack.api, registry, prompts, publicOrigin: PUBLIC_ORIGIN, logger, clock: systemClock },
          request(pendingUntil),
        ),
      chunk: (c: Record<string, unknown>, reqId: string = CONTINUATION) =>
        bus.fire('chat:stream-chunk', ipcCtx, { reqId, ...c }),
      end: (reqId: string = CONTINUATION) => bus.fire('chat:turn-end', ipcCtx, { reqId, reason: 'user-message-wait' }),
      error: () => bus.fire('chat:turn-error', ipcCtx, { reqId: CONTINUATION, reason: 'chat-run-timeout' }),
      /** A card as @ax/skill-broker fires request_capability's: under the runner's IPC ctx, the conversation's, no reqId. */
      card: (c: Record<string, unknown>) => bus.fire('chat:permission-request', ipcCtx, c),
    };
  }

  /** When @ax/decisions wakes the agent: the end of the approval's undo window, 10 s after the click. */
  const inTenSeconds = (): string => new Date(Date.now() + 10_000).toISOString();

  it("streams the woken turn into the prompt's thread, for the person who answered it, until its turn-end", async () => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.chunk({ kind: 'tool-use', toolCallId: 'toolu_again', toolName: 'mcp__gmail__send_email', activityPhrase: 'Sending' });
    await h.chunk({ kind: 'tool-result', toolCallId: 'toolu_again', output: 'sent' });
    await h.chunk({ kind: 'text', text: 'Sent it to Bob.' });
    await h.end();
    await done;

    const calls = h.all();
    // No 👀: there is no message of theirs to put it on.
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(calls[0]!.token).toBe(BOT_TOKEN);
    expect(calls[0]!.args).toMatchObject({
      channel: CHANNEL,
      threadTs: THREAD,
      recipientUserId: SENDER,
      recipientTeamId: CONTEXT.teamId,
    });
    expect(h.reply()).toBe('Sent it to Bob.');
    expect(h.registry.size()).toBe(0);
    expect(h.lines).toEqual([]);
  });

  it('the sink is registered by the time the call returns, before anything is awaited', async () => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    expect(done).toBeInstanceOf(Promise);
    expect(h.registry.size()).toBe(1);
    await h.chunk({ kind: 'text', text: 'Right away.' });
    await h.end();
    await done;
    expect(h.reply()).toBe('Right away.');
  });

  // Review Focus 3: the session ended inside the undo window, or the wake-up was refused.
  it('nothing arrives: at the start deadline the thread hears nothing, the sink is gone, and the miss is logged by code', async () => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(inTenSeconds());
    await vi.advanceTimersByTimeAsync(10_000 + CONTINUATION_START_GRACE_MS - 1);
    expect(h.registry.size()).toBe(1);
    expect(h.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(vi.getTimerCount()).toBe(0);

    // Not a word: no "I didn't have anything to add".
    expect(h.all()).toEqual([]);
    expect(h.registry.size()).toBe(0);
    expect(h.lines).toEqual([
      { level: 'info', msg: 'slack_continuation_missed', fields: { installId: CONTEXT.installId, reason: 'not-started' } },
    ]);

    // A turn that starts after all is not followed.
    await h.chunk({ kind: 'text', text: 'too late' });
    await h.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.all()).toEqual([]);
  });

  it('the deadline runs from the wake-up: a turn starting past the grace alone, but within it of the wake-up, is followed', async () => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(inTenSeconds());
    await vi.advanceTimersByTimeAsync(CONTINUATION_START_GRACE_MS + 5_000);
    await h.chunk({ kind: 'text', text: 'On it.' });
    await h.end();
    await done;
    expect(h.reply()).toBe('On it.');
    expect(h.lines).toEqual([]);
    // The start deadline, the hard cap and the reply's own timers: all gone.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a turn followed to its end on time leaves no timer behind', async () => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(inTenSeconds());
    await vi.advanceTimersByTimeAsync(10_000);
    await h.chunk({ kind: 'text', text: 'Sent it to Bob.' });
    await h.end();
    await done;
    expect(h.reply()).toBe('Sent it to Bob.');
    expect(h.lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a wake-up too far out to be real is waited for no longer than the cap, then the grace', async () => {
    // A far-future pendingUntil would otherwise overflow the timer (past
    // 2^31-1 ms a timer fires at once) or hold a sink for months.
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(new Date(Date.now() + 2 ** 31 + 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(CONTINUATION_WAKE_MAX_MS + CONTINUATION_START_GRACE_MS - 1);
    expect(h.registry.size()).toBe(1);
    expect(h.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.registry.size()).toBe(0);
    expect(h.all()).toEqual([]);
    expect(h.lines.map((l) => [l.msg, l.fields?.['reason']])).toEqual([['slack_continuation_missed', 'not-started']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a dark turn-end (no reqId) in the prompt's conversation before the continuation began is another turn's: the follower keeps waiting, and follows its own", async () => {
    // A warm agent's turn run dark (its reaction to a Deny on another prompt,
    // say) used to end this wait too, and the continuation then streamed to nobody.
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.end('');
    expect(h.registry.size()).toBe(1);
    expect(h.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await h.chunk({ kind: 'text', text: 'Sent it to Bob.' });
    await h.end();
    await done;
    expect(h.reply()).toBe('Sent it to Bob.');
    expect(h.lines).toEqual([]);
    expect(h.registry.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a dark turn-end once the continuation has begun ends it, as its own', async () => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.chunk({ kind: 'text', text: 'Sent it to Bob.' });
    await h.end('');
    await done;
    expect(h.reply()).toBe('Sent it to Bob.');
    expect(h.registry.size()).toBe(0);
  });

  it.each([
    ['no wake-up time', () => null],
    ['one that cannot be read', () => 'shortly'],
    ['one already past', () => new Date(Date.now() - 30_000).toISOString()],
  ] as const)('%s: the deadline is the grace alone', async (_name, pendingUntil) => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(pendingUntil());
    await vi.advanceTimersByTimeAsync(CONTINUATION_START_GRACE_MS - 1);
    expect(h.registry.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.registry.size()).toBe(0);
    expect(h.all()).toEqual([]);
    expect(h.lines.map((l) => [l.msg, l.fields?.['reason']])).toEqual([['slack_continuation_missed', 'not-started']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a turn that has started is not given up at the start deadline', async () => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(inTenSeconds());
    await vi.advanceTimersByTimeAsync(5_000);
    await h.chunk({ kind: 'text', text: 'Working on it. ' });
    await vi.advanceTimersByTimeAsync(10_000 + CONTINUATION_START_GRACE_MS);
    expect(h.registry.size()).toBe(1);
    await h.chunk({ kind: 'text', text: 'Done.' });
    await h.end();
    await done;
    expect(h.reply()).toBe('Working on it. Done.');
    expect(h.lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a turn whose first chunk is the SDK loading a tool (ToolSearch) has started: plumbing shows nothing, but it still counts (TASK-1130)', async () => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(inTenSeconds());
    await vi.advanceTimersByTimeAsync(5_000);
    await h.chunk({ kind: 'tool-use', toolCallId: 'toolu_ts', toolName: 'ToolSearch', input: { query: 'select:mcp__ax-host-tools__routine_create' } });
    await vi.advanceTimersByTimeAsync(10_000 + CONTINUATION_START_GRACE_MS);
    expect(h.registry.size()).toBe(1);
    await h.chunk({ kind: 'text', text: 'Done.' });
    await h.end();
    await done;
    expect(h.reply()).toBe('Done.');
    expect(cardTitlesOf(h.all())).toEqual([]);
    expect(h.lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['nothing at all', []],
    ['only thinking', [{ kind: 'thinking', text: 'They said yes.' }]],
    ['an empty text', [{ kind: 'text', text: '' }]],
    // The SDK's ToolSearch is plumbing (TASK-1130): loading a tool's schema says nothing, and nor does its summary.
    [
      'only a ToolSearch schema load and its step summary',
      [
        { kind: 'tool-use', toolCallId: 'toolu_ts', toolName: 'ToolSearch', input: { query: 'select:mcp__ax-host-tools__routine_create' } },
        { kind: 'step-summary', toolCallId: 'toolu_ts', text: 'Loading the routine creation tool schema.' },
        { kind: 'tool-result', toolCallId: 'toolu_ts', output: 'loaded' },
      ],
    ],
  ] as const)('a turn-end after %s: no message, and the quiet end is logged by code', async (_name, chunks) => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    for (const c of chunks) await h.chunk(c);
    await h.end();
    await done;
    expect(h.all()).toEqual([]);
    expect(h.registry.size()).toBe(0);
    expect(h.lines).toEqual([
      { level: 'info', msg: 'slack_continuation_missed', fields: { installId: CONTEXT.installId, reason: 'said-nothing' } },
    ]);
  });

  // ── Giving up: the prompt says what its decision says now ──
  // "Allowed. I'll pick it up in a moment." went unkept when the agent never
  // carried on in the thread. The follower reads the decision back and
  // redraws the prompt with it, and still posts nothing in the thread.

  /** decisions:get's answer: the prompt's own row, as `over` leaves it. */
  const storedRow = (status: string, over: Record<string, unknown> = {}) => ({
    decision: decisionRow('dec_held', 'toolu_held', { status, ...over }),
  });
  /** The prompt redrawn with `line`: its subject, then the line, and nothing to click (blocks.ts `outcomeBlocks`). */
  const redrawnWith = (line: string) => ({
    method: 'updateMessage',
    token: BOT_TOKEN,
    args: JSON.parse(JSON.stringify({ channel: CHANNEL, ts: PROMPT_TS, ...outcomeBlocks({ subject: SUMMARY, line }) })) as Record<string, unknown>,
  });
  const missed = (reason: string): LogLine => ({
    level: 'info',
    msg: 'slack_continuation_missed',
    fields: { installId: CONTEXT.installId, reason },
  });

  it("not started by the deadline (parked for the agent's next ask): the prompt is redrawn with what its decision says, and nothing is posted in the thread", async () => {
    vi.useFakeTimers();
    const h = follower({ get: () => storedRow('approved-pending-agent') });
    const done = h.follow(inTenSeconds());
    await vi.advanceTimersByTimeAsync(10_000 + CONTINUATION_START_GRACE_MS);
    await done;

    expect(h.all()).toEqual([redrawnWith(COPY.decisionAllowedNextTime)]);
    // The prompt's own decision, read as the prompt's own user.
    expect(h.gets.map((g) => g.input)).toEqual([{ decisionId: 'dec_held', userId: 'usr_alice' }]);
    expect(h.lines).toEqual([missed('not-started')]);
    expect(h.registry.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('said nothing (the host replayed the call meanwhile): the prompt is redrawn as done, and nothing is posted in the thread', async () => {
    const h = follower({ get: () => storedRow('executed', { replayedAt: '2026-11-14T12:00:11.000Z' }) });
    const done = h.follow(inTenSeconds());
    await h.chunk({ kind: 'thinking', text: 'They said yes.' });
    await h.end();
    await done;

    expect(h.all()).toEqual([redrawnWith(COPY.decisionDone)]);
    expect(h.lines).toEqual([missed('said-nothing')]);
  });

  it('a decision that says nothing new (its host replay still running): the prompt is left as it is', async () => {
    const h = follower({ get: () => storedRow('executed', { replayClaimedAt: '2026-11-14T12:00:11.000Z' }) });
    const done = h.follow(inTenSeconds());
    await h.end();
    await done;

    expect(h.gets).toHaveLength(1);
    expect(h.all()).toEqual([]);
    expect(h.lines).toEqual([missed('said-nothing')]);
  });

  it('a read that fails: the prompt is left as it is, logged by code', async () => {
    const h = follower({
      get: () => {
        throw new PluginError({ code: 'store-unavailable', plugin: 'fake-decisions', message: 'decisions down' });
      },
    });
    const done = h.follow(inTenSeconds());
    await h.end();
    await done;

    expect(h.all()).toEqual([]);
    expect(h.lines).toEqual([
      missed('said-nothing'),
      {
        level: 'warn',
        msg: 'slack_prompt_failed',
        fields: { installId: CONTEXT.installId, kind: 'decision', stage: 'recheck', code: 'store-unavailable' },
      },
    ]);
  });

  it('a redraw Slack refuses: logged by code, and still nothing is posted', async () => {
    const h = follower({ get: () => storedRow('approved-pending-agent'), updateFails: true });
    const done = h.follow(inTenSeconds());
    await h.end();
    await done;

    expect(h.all().map((c) => c.method)).toEqual(['updateMessage']);
    expect(h.lines).toEqual([
      missed('said-nothing'),
      {
        level: 'warn',
        msg: 'slack_prompt_failed',
        fields: { installId: CONTEXT.installId, kind: 'decision', stage: 'update', code: 'message_not_found' },
      },
    ]);
  });

  it('no message to redraw (the gate had none either): nothing is read', async () => {
    const h = follower({ get: () => storedRow('approved-pending-agent'), messageTs: null });
    const done = h.follow(inTenSeconds());
    await h.end();
    await done;

    expect(h.gets).toEqual([]);
    expect(h.all()).toEqual([]);
  });

  it('a continuation that said something: nothing is read back, and the prompt keeps its line', async () => {
    const h = follower({ get: () => storedRow('approved-pending-agent') });
    const done = h.follow(inTenSeconds());
    await h.chunk({ kind: 'text', text: 'Sent it to Bob.' });
    await h.end();
    await done;

    expect(h.gets).toEqual([]);
    expect(h.all().map((c) => c.method)).toEqual(['startStream', 'stopStream']);
  });

  it.each([
    ['a status', { kind: 'tool-use', toolCallId: 'toolu_look', toolName: 'mcp__gmail__search', activityPhrase: 'Looking' }],
    ['a step summary', { kind: 'step-summary', text: 'Read the inbox' }],
  ] as const)('a turn-end after only %s: the reply shows it', async (_name, chunk) => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.chunk(chunk);
    await h.end();
    await done;
    expect(h.all().map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(h.lines).toEqual([]);
  });

  it('a turn-end after only a held call: the reply ends with the held line', async () => {
    // No decisions service here, so no prompt: the line that sends them to Today.
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.chunk({ kind: 'tool-result', toolCallId: 'toolu_again', output: 'Held for approval', held: true });
    await h.end();
    await done;
    expect(h.reply()).toBe(COPY.heldForSender(TODAY));
    expect(h.lines).toEqual([]);
  });

  it('a turn-error ends it with the failure line', async () => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.chunk({ kind: 'text', text: 'Sending.' });
    await h.error();
    await done;
    expect(h.reply()).toBe(`Sending.\n\n${COPY.turnFailed}`);
    expect(h.lines).toEqual([
      { level: 'warn', msg: 'slack_turn_failed', fields: { installId: CONTEXT.installId, reason: 'turn-error' } },
    ]);
    expect(h.registry.size()).toBe(0);
  });

  it("another turn's chunks and turn-end are not this one's", async () => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.chunk({ kind: 'text', text: 'Not this turn.' }, ELSEWHERE);
    await h.end(ELSEWHERE);
    expect(h.registry.size()).toBe(1);
    expect(h.all()).toEqual([]);
    await h.chunk({ kind: 'text', text: 'This one.' });
    await h.end();
    await done;
    expect(h.reply()).toBe('This one.');
  });

  it("another turn's chunk doesn't start this one: its start deadline still holds", async () => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(null);
    await h.chunk({ kind: 'text', text: 'Not this turn.' }, ELSEWHERE);
    await vi.advanceTimersByTimeAsync(CONTINUATION_START_GRACE_MS);
    await done;
    expect(h.all()).toEqual([]);
    expect(h.lines.map((l) => [l.msg, l.fields?.['reason']])).toEqual([['slack_continuation_missed', 'not-started']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the hard cap runs from the turn's first chunk: the failure line, and the prompt's conversation is asked to stop, as its person", async () => {
    vi.useFakeTimers();
    const h = follower();
    const done = h.follow(inTenSeconds());
    await vi.advanceTimersByTimeAsync(30_000);
    // Any chunk starts it, even one that shows nothing.
    await h.chunk({ kind: 'thinking', text: 'Checking.' });
    // Past the start deadline meanwhile: started, so not given up.
    await vi.advanceTimersByTimeAsync(TURN_HARD_CAP_MS - 1);
    expect(h.interrupts).toEqual([]);
    expect(h.all()).toEqual([]);
    expect(h.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(h.reply()).toBe(COPY.turnFailed);
    expect(h.interrupts.map((i) => i.input)).toEqual([{ conversationId: 'conv_support_thread', userId: 'usr_alice' }]);
    expect(h.interrupts[0]!.ctx).toMatchObject({
      reqId: CONTINUATION,
      userId: 'usr_alice',
      agentId: 'agt_support',
      conversationId: 'conv_support_thread',
    });
    expect(h.lines).toHaveLength(2);
    expect(h.lines).toEqual(
      expect.arrayContaining([
        { level: 'warn', msg: 'slack_turn_failed', fields: { installId: CONTEXT.installId, reason: 'timeout' } },
        { level: 'info', msg: 'slack_turn_interrupted', fields: { installId: CONTEXT.installId, reason: 'timeout', interrupted: true } },
      ]),
    );
    expect(h.registry.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['DM', 'dm'],
    ['channel', 'attended'],
  ] as const)(
    'a prompt answered in a %s: a call held inside the continuation gets a prompt of its own, for the same person, in the same thread',
    async (_where, mode) => {
      const h = follower({ mode, decisions: [decisionRow('dec_other', 'toolu_other'), decisionRow('dec_again', 'toolu_again')] });
      const done = h.follow(inTenSeconds());
      await h.chunk({ kind: 'text', text: 'Let me try that again.' });
      await h.chunk({ kind: 'tool-use', toolCallId: 'toolu_again', toolName: 'mcp__gmail__send_email' });
      await h.chunk({ kind: 'tool-result', toolCallId: 'toolu_again', output: 'Held for approval', held: true });
      await h.end();
      await done;

      // The ask ends the reply, and the prompt follows it.
      expect(replyOf(h.all().filter((c) => c.method.endsWith('Stream')))).toBe(`Let me try that again.\n\n${COPY.heldAsked}`);
      const posts = h.all().filter((c) => c.method === 'postBlocks');
      expect(posts).toHaveLength(1);
      expect(h.all().at(-1)!.method).toBe('postBlocks');
      expect(posts[0]!.args).toMatchObject({ channel: CHANNEL, threadTs: THREAD, text: COPY.heldAsked });
      const claim = h.prompts.claim(promptIdOf(posts[0]!), SENDER);
      expect(claim.ok).toBe(true);
      expect(claim.ok && claim.prompt).toMatchObject({
        ...CONTEXT,
        mode,
        subject: { kind: 'decision', decisionId: 'dec_again' },
        subjectText: SUMMARY,
        messageTs: PROMPT_TS,
      });
      expect(h.prompts.size()).toBe(1);

      // Looked up as the prompt's person, under the continuation's reqId and the prompt's mode.
      expect(h.lookups.map((l) => l.input)).toEqual([
        { userId: 'usr_alice', agentId: 'agt_support', conversationId: 'conv_support_thread' },
      ]);
      expect(h.lookups[0]!.ctx).toMatchObject({
        reqId: CONTINUATION,
        userId: 'usr_alice',
        agentId: 'agt_support',
        conversationId: 'conv_support_thread',
        ...turnContextFields(mode),
      });
      expect(h.lines).toEqual([]);
    },
  );

  // ── A skill card in a continuation ──
  // The agent a held call's Allow woke can ask for a skill too: the broker
  // fires request_capability's card under the runner's ctx, in the
  // conversation the continuation streams into.

  /** The skill prompt the continuation posted: its subject, its Today line, and the open prompt its buttons name. */
  const skillPromptIn = (h: ReturnType<typeof follower>, mode: 'dm' | 'attended' = 'attended') => {
    const posts = h.all().filter((c) => c.method === 'postBlocks');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args).toMatchObject({ channel: CHANNEL, threadTs: THREAD, text: COPY.heldAsked });
    const blocks = posts[0]!.args['blocks'] as Array<{ type: string; text?: { text?: string }; elements?: unknown[] }>;
    expect(blocks[0]!.text!.text).toBe(COPY.skillSubject('gmail-sender', DESCRIPTION, GMAIL_REACH));
    expect(blocks.at(-1)!.elements).toContainEqual({ type: 'mrkdwn', text: COPY.promptToday(TODAY) });
    const claim = h.prompts.claim(promptIdOf(posts[0]!), SENDER);
    expect(claim.ok && claim.prompt).toMatchObject({
      ...CONTEXT,
      mode,
      subject: { kind: 'skill', skillId: 'gmail-sender' },
      subjectText: COPY.skillSubject('gmail-sender', DESCRIPTION, GMAIL_REACH),
      messageTs: PROMPT_TS,
    });
    expect(h.prompts.size()).toBe(1);
  };

  it.each(['dm', 'attended'] as const)(
    "a skill card in a continuation of a %s prompt: after its reply, a prompt to connect the skill in the same thread, for the same person",
    async (mode) => {
      const h = follower({ mode });
      const done = h.follow(inTenSeconds());
      await h.chunk({ kind: 'tool-use', toolCallId: 'toolu_cap', toolName: 'request_capability', activityPhrase: 'Asking to connect a service' });
      await h.card(skillCard('gmail-sender'));
      await h.chunk({ kind: 'tool-result', toolCallId: 'toolu_cap', output: '{"status":"requested"}' });
      await h.end();
      await done;

      expect(h.all().map((c) => c.method)).toEqual(['startStream', 'stopStream', 'postBlocks']);
      skillPromptIn(h, mode);
      expect(h.skillCalls).toEqual([]);
      expect(h.lines).toEqual([]);
    },
  );

  it(
    "a continuation whose only output is a skill card: no reply of its own (no \"I didn't have anything to add.\"); " +
      'the answered prompt is redrawn with what its decision says, then the skill is asked about',
    async () => {
      const h = follower({ get: () => storedRow('executed', { consumedAt: '2026-11-14T12:00:11.000Z' }) });
      const done = h.follow(inTenSeconds());
      await h.card(skillCard('gmail-sender'));
      await h.end();
      await done;

      expect(h.all().map((c) => c.method)).toEqual(['updateMessage', 'postBlocks']);
      expect(h.all()[0]).toEqual(redrawnWith(COPY.decisionDone));
      expect(h.reply()).toBe('');
      skillPromptIn(h);
      expect(h.lines).toEqual([missed('said-nothing')]);
    },
  );

  it('a continuation that never began: a skill card heard in its conversation is still asked about once it is given up, and nothing else is said', async () => {
    vi.useFakeTimers();
    const h = follower({ get: () => storedRow('approved-pending-agent') });
    const done = h.follow(inTenSeconds());
    await h.card(skillCard('gmail-sender'));
    await vi.advanceTimersByTimeAsync(10_000 + CONTINUATION_START_GRACE_MS);
    await done;

    expect(h.all().map((c) => c.method)).toEqual(['updateMessage', 'postBlocks']);
    expect(h.all()[0]).toEqual(redrawnWith(COPY.decisionAllowedNextTime));
    skillPromptIn(h);
    expect(h.lines).toEqual([missed('not-started')]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a skill that needs a key, in a continuation that said nothing else: the link to the web app, and nothing to click', async () => {
    const h = follower();
    const done = h.follow(inTenSeconds());
    await h.card(skillCard('gmail-sender', { slots: [KEYLESS_SLOT] }));
    await h.end();
    await done;

    const posts = h.all().filter((c) => c.method === 'postBlocks');
    expect(posts.map((c) => c.args)).toEqual([
      JSON.parse(
        JSON.stringify({
          channel: CHANNEL,
          threadTs: THREAD,
          ...linkOnlyBlocks({
            subject: COPY.skillSubject('gmail-sender', DESCRIPTION, GMAIL_REACH),
            line: COPY.skillNeedsWeb(TODAY),
          }),
        }),
      ),
    ]);
    expect(h.prompts.size()).toBe(0);
    expect(h.reply()).toBe('');
  });
});

/** channel-web's PLUMBING_TOOL_NAMES as its source spells it: read from the file, never imported (invariant 2). */
function webPlumbingToolNames(): string[] {
  const file = fileURLToPath(new URL('../../../channel-web/src/lib/workspace-steps.ts', import.meta.url));
  const found = /^[ \t]*(?:export[ \t]+)?const[ \t]+PLUMBING_TOOL_NAMES\b[^=\n]*=[ \t]*new Set\(\[([^\]]*)\]\)/m.exec(
    readFileSync(file, 'utf8'),
  );
  if (found === null) {
    throw new Error('channel-web/src/lib/workspace-steps.ts no longer spells PLUMBING_TOOL_NAMES the way this test reads it');
  }
  // Only quoted names, commas and whitespace: a spread or a constant (`...BASE`) would be skipped silently.
  // Strip the names, then look at what's left (one nested-quantifier regex here backtracks exponentially).
  if (!/^[\s,]*$/.test(found[1]!.replace(/'[^']*'|"[^"]*"/g, ''))) {
    throw new Error("channel-web's PLUMBING_TOOL_NAMES holds something besides quoted names; this test can't read it");
  }
  const names = [...found[1]!.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]!);
  if (names.length === 0) throw new Error("read no names from channel-web's PLUMBING_TOOL_NAMES");
  return names;
}

describe("PLUMBING_TOOL_NAMES: channel-web's twin (TASK-1130)", () => {
  it("names exactly the calls the web's step panel hides", () => {
    expect([...PLUMBING_TOOL_NAMES].sort()).toEqual(webPlumbingToolNames().sort());
  });
});
