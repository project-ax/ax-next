import { HookBus, PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';
import {
  CONTINUATION_START_GRACE_MS,
  CONTINUATION_WAKE_MAX_MS,
  PROMPT_MAX,
  PROMPT_TTL_MS,
  TURN_END_GRACE_MS,
  TURN_HARD_CAP_MS,
} from '../limits.js';
import { outcomeBlocks } from '../blocks.js';
import { createPromptRegistry } from '../prompts.js';
import { systemClock } from '../reply-stream.js';
import { SlackApiError, type SlackApi, type StreamChunkOut } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { createTurnRegistry, subscribeTurnEvents } from '../turn-registry.js';
import {
  followContinuation,
  runTurn,
  turnContextFields,
  type ContinuationRequest,
  type TurnMode,
  type TurnRequest,
} from '../turn.js';
import { fakeBotToken } from './fake-slack-tokens.js';

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
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    usersInfo: notHere,
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
    conversationsList: notHere,
    conversationsJoin: notHere,
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
  end?: 'turn-end' | 'turn-error';
}

/** The reply as it stood right after another turn's dark turn-end. */
interface AfterDark {
  /** Turn sinks still registered: 1 while the reply waits for its own turn. */
  sinks: number;
  /** Every Slack call by then but 👀's. */
  methods: string[];
}

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
};

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
}

function harness(script: Script = {}, o: HarnessOptions = {}) {
  const bus = new HookBus();
  const registry = createTurnRegistry();
  subscribeTurnEvents(bus, registry, '@ax/channel-slack/turn-test');
  const invokes: Array<{ ctx: AgentContext; input: unknown }> = [];
  const lookups: Array<{ ctx: AgentContext; input: unknown }> = [];
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
  bus.registerService(
    'agent:invoke',
    'fake-orchestrator',
    async (ctx, input) => {
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

  const request = (mode: TurnMode): TurnRequest => ({
    mode,
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
    lookups,
    prompts,
    afterDark,
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
    run: (mode: TurnMode) =>
      runTurn(
        {
          bus,
          api: slack.api,
          registry,
          prompts,
          publicOrigin: PUBLIC_ORIGIN,
          logger: quiet,
          clock: systemClock,
        },
        request(mode),
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
    const registry = createTurnRegistry();
    subscribeTurnEvents(bus, registry, '@ax/channel-slack/turn-test');
    const slack = fakeSlack(o.updateFails === true ? { updateMessageFails: true } : {});
    const lines: LogLine[] = [];
    const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      lines.push({ level, msg, fields });
    };
    const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
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

  it.each([
    ['nothing at all', []],
    ['only thinking', [{ kind: 'thinking', text: 'They said yes.' }]],
    ['an empty text', [{ kind: 'text', text: '' }]],
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
});
