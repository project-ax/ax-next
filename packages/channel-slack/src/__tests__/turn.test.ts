import { HookBus, makeAgentContext, type AgentContext, type Logger } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { systemClock } from '../reply-stream.js';
import type { SlackApi, StreamChunkOut } from '../slack-api.js';
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

type Method = 'startStream' | 'appendStream' | 'stopStream' | 'postMessage' | 'addReaction' | 'removeReaction';

interface SlackCall {
  method: Method;
  args: Record<string, unknown>;
}

function fakeSlack() {
  const calls: SlackCall[] = [];
  let nextTs = 1;
  const notHere = async (): Promise<never> => {
    throw new Error('a turn must not call this Slack method');
  };
  const record = (method: Method, args: Record<string, unknown>): void => {
    calls.push({ method, args: { ...args } });
  };
  const api: SlackApi = {
    rotateConfigToken: notHere,
    createApp: notHere,
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    usersInfo: notHere,
    postEphemeral: notHere,
    conversationsInfo: notHere,
    conversationsList: notHere,
    conversationsJoin: notHere,
    async postMessage(_token, a) {
      record('postMessage', a);
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

function harness(script: Script = {}) {
  const bus = new HookBus();
  const registry = createTurnRegistry();
  subscribeTurnEvents(bus, registry, '@ax/channel-slack/turn-test');
  const invokes: Array<{ ctx: AgentContext; input: unknown }> = [];
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
  const slack = fakeSlack();

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
    reply: () => replyOf(slack.calls),
    run: (mode: TurnMode) =>
      runTurn(
        { bus, api: slack.api, registry, publicOrigin: PUBLIC_ORIGIN, logger: quiet, clock: systemClock },
        request(mode),
      ),
  };
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
