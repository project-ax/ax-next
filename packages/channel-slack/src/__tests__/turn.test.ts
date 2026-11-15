import { HookBus, PluginError, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { PROMPT_MAX, PROMPT_TTL_MS } from '../limits.js';
import { createPromptRegistry } from '../prompts.js';
import { systemClock } from '../reply-stream.js';
import { SlackApiError, type SlackApi, type StreamChunkOut } from '../slack-api.js';
import type { InstallRow } from '../store.js';
import { createTurnRegistry, subscribeTurnEvents } from '../turn-registry.js';
import { runTurn, turnContextFields, type TurnMode, type TurnRequest } from '../turn.js';
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
  | 'addReaction'
  | 'removeReaction';

interface SlackCall {
  method: Method;
  token: string;
  args: Record<string, unknown>;
}

/** The ts Slack gives a prompt's message. */
const PROMPT_TS = '1763040000.000900';

function fakeSlack(o: { postBlocksFails?: boolean } = {}) {
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
    updateMessage: notHere,
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
  /** Chunks to fire, in order, each stamped with the invoke's reqId. */
  chunks?: Array<Record<string, unknown>>;
  end?: 'turn-end' | 'turn-error';
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
  /** The turn's deps carry no prompt registry (nothing has wired one in). */
  noPrompts?: boolean;
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
  bus.registerService(
    'agent:invoke',
    'fake-orchestrator',
    async (ctx, input) => {
      invokes.push({ ctx, input });
      // The IPC listener restamps ctx.reqId; only the payload names the turn.
      const ipcCtx = makeAgentContext({
        sessionId: 'sess_live',
        agentId: ctx.agentId,
        userId: ctx.userId,
        ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
      });
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

  return {
    invokes,
    lookups,
    prompts,
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
          ...(o.noPrompts === true ? {} : { prompts }),
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

  it('no prompt registry in the turn: the Today line, and nothing is looked up', async () => {
    const h = harness(
      { chunks: [SAID, ...heldCall('toolu_held')] },
      { decisions: [decisionRow('dec_held', 'toolu_held')], noPrompts: true },
    );
    await h.run('dm');
    expect(h.reply()).toBe(`Let me send that.\n\n${COPY.heldForSender(TODAY)}`);
    expect(h.lookups).toEqual([]);
    expect(h.calls().map((c) => c.method)).not.toContain('postBlocks');
  });
});
