import {
  DEFAULT_SERVICE_TIMEOUT_MS,
  HookBus,
  PluginError,
  makeAgentContext,
  type AgentContext,
  type Logger,
} from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer } from '../answers.js';
import type { PromptAction } from '../blocks.js';
import { COPY } from '../copy.js';
import { createDecisionAnswer, decisionOutcome, lineAfterMiss, recheckAfterMiss } from '../decision-answer.js';
import { PROMPT_STEP_TIMEOUT_MS } from '../limits.js';
import type { Prompt } from '../prompts.js';
import type { InstallRow } from '../store.js';
import type { ContinuationRequest } from '../turn.js';
import { fakeBotToken } from './fake-slack-tokens.js';

/*
  Answering a held call (decision-answer.ts): what Allow and Deny on a
  decision's prompt do once the click gate (answers.ts) has let the click
  through. Allow approves once, for the prompt's own user, with a
  continuation id it mints, and follows the woken agent's turn only under
  that id, as soon as the approve returns. Deny dismisses for the prompt's
  own user. What the prompt then shows comes from a closed table over what
  decisions handed back: a COPY line, and every one settles the prompt. A
  hook past the bus's deadline holds the answer until it has settled, and
  then the row says what happened.
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const PUBLIC_ORIGIN = 'https://ax.example';
/** Today in the web app, where the decision also waits. */
const TODAY = 'https://ax.example/workspace';
const INSTALL_ID = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const BOT_TOKEN = fakeBotToken('DECISIONANSWERSECRET');

const INSTALL: InstallRow = {
  installId: INSTALL_ID,
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

const DECISION_ID = 'dec_0001';
/** Mel's attended turn in #support held a call: its prompt, as the registry keeps it. */
const PROMPT: Prompt = Object.freeze({
  id: 'AQEBAQEBAQEBAQEBAQEBAQ',
  installId: INSTALL_ID,
  teamId: 'T07ABCDEF12',
  channel: 'C07SUPPORT1',
  threadTs: '1763121600.000100',
  askerSlackId: 'U07MEL00001',
  userId: 'usr_mel',
  agentId: 'agt_support',
  conversationId: 'conv_mel_support',
  mode: 'attended',
  subject: Object.freeze({ kind: 'decision', decisionId: DECISION_ID }),
  subjectText: 'Wants to gain access to a new service or key',
  messageTs: '1763121660.000200',
  expiresAt: Date.parse('2026-11-15T12:00:00.000Z'),
}) as Prompt;
/** When decisions wakes the agent: the undo window's end. */
const PENDING_UNTIL = '2026-11-14T12:00:10.000Z';

/** A decision row as decisions hands one back. Only `status` is read; the rest is there to be ignored. */
function row(status: unknown): Record<string, unknown> {
  return {
    id: DECISION_ID,
    agentId: 'agt_support',
    ownerUserId: 'usr_mel',
    conversationId: 'conv_mel_support',
    status,
    summary: 'Wants to gain access to a new service or key',
    approvedText: 'Done.',
    dismissedText: 'You declined this. Nothing ran.',
  };
}

/** decisions:approve's answer when nothing runs (decisions' `inert`): the stored row, no path, no stream. */
const inert = (status: unknown) => ({
  decision: row(status),
  executed: false,
  path: null,
  error: null,
  pendingUntil: null,
  streamReqId: null,
});

/** decisions:approve's answer on the attended path: handed to the warm agent once the window closes. */
const handedToAgent = (streamReqId: unknown) => ({
  decision: row('executed'),
  executed: false,
  path: 'agent-executes',
  error: null,
  pendingUntil: PENDING_UNTIL,
  streamReqId,
});

/** The line and follow `decisionOutcome` gives for a COPY line that follows nothing. */
const shows = (line: string) => ({ line, follow: false });

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

interface Call {
  ctx: AgentContext;
  input: Record<string, unknown>;
}

interface FakeOptions {
  /** decisions:approve's answer for its n-th call (1-based). A throw is the hook's throw. */
  approve?: (input: Record<string, unknown>, n: number) => unknown;
  /** decisions:dismiss's answer. */
  dismiss?: (input: Record<string, unknown>) => unknown;
  /** decisions:get's answer: the stored row. */
  get?: () => unknown;
  /** The deadline the bus gives approve and dismiss: the bus's default unless set. */
  timeoutMs?: number;
  /** Services this kernel doesn't have. */
  without?: string[];
  /** The follower: records each request unless it is given something to do. */
  follow?: (c: ContinuationRequest) => void;
  /** The message the gate redraws, as it hands it over: the prompt's own unless set. */
  messageTs?: string | null;
}

/** A bus with a fake @ax/decisions on it, the decision answer built on it, and what each hook was asked. */
function fake(o: FakeOptions = {}) {
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
  // The bus never reports a stall of its own: a slow fake is the test's point.
  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const approves: Call[] = [];
  const dismisses: Call[] = [];
  const gets: Call[] = [];
  const has = (hook: string) => !(o.without ?? []).includes(hook);
  const timing = o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs };
  if (has('decisions:approve')) {
    bus.registerService(
      'decisions:approve',
      'fake-decisions',
      async (ctx, input) => {
        approves.push({ ctx, input: { ...(input as Record<string, unknown>) } });
        const rec = input as Record<string, unknown>;
        return o.approve ? o.approve(rec, approves.length) : handedToAgent(rec['continuationReqId']);
      },
      timing,
    );
  }
  if (has('decisions:dismiss')) {
    bus.registerService(
      'decisions:dismiss',
      'fake-decisions',
      async (ctx, input) => {
        dismisses.push({ ctx, input: { ...(input as Record<string, unknown>) } });
        return o.dismiss ? o.dismiss(input as Record<string, unknown>) : { decision: row('dismissed') };
      },
      timing,
    );
  }
  if (has('decisions:get')) {
    bus.registerService('decisions:get', 'fake-decisions', async (ctx, input) => {
      gets.push({ ctx, input: { ...(input as Record<string, unknown>) } });
      return o.get ? o.get() : { decision: row('pending') };
    });
  }

  const follows: ContinuationRequest[] = [];
  const answer = createDecisionAnswer({
    bus,
    publicOrigin: PUBLIC_ORIGIN,
    follow:
      o.follow ??
      ((c) => {
        follows.push(c);
      }),
  });
  /** The ctx the click gate builds for an answer: the prompt's user, agent and conversation. */
  const ctx = makeAgentContext({
    sessionId: 'channel-slack',
    agentId: PROMPT.agentId,
    userId: PROMPT.userId,
    conversationId: PROMPT.conversationId,
    logger,
  });
  return {
    approves,
    dismisses,
    gets,
    follows,
    lines,
    /** The answer to a click on `action`, as the gate hands it over. */
    click(action: PromptAction): Promise<Answer> {
      const messageTs = o.messageTs === undefined ? PROMPT.messageTs : o.messageTs;
      return answer(ctx, PROMPT, action, { install: INSTALL, botToken: BOT_TOKEN, messageTs });
    },
    /** What the prompt says once the thread has stopped waiting for the agent (turn.ts gave up). */
    recheck(timeoutMs = 5_000): Promise<string | null> {
      return recheckAfterMiss(bus, ctx, PROMPT, { todayLink: TODAY, timeoutMs, logger });
    },
    logged(msg: string): Array<Record<string, unknown>> {
      return lines.filter((l) => l.msg === msg).map((l) => l.fields);
    },
  };
}

const fault = () => new PluginError({ code: 'store-unavailable', plugin: 'fake-decisions', message: 'database down' });

afterEach(() => {
  vi.useRealTimers();
});

// ── The table ───────────────────────────────────────────────────────────────

describe('decisionOutcome: what the prompt says, from what decisions handed back', () => {
  const cases: Array<[string, unknown, { line: string; follow: boolean }]> = [
    // Nothing usable: the prompt can't say anything about it here.
    ['no answer at all', undefined, shows(COPY.promptClosed)],
    ['an answer that is not an object', 'executed', shows(COPY.promptClosed)],
    ['no decision (none by that id for this user)', { ...inert('pending'), decision: null }, shows(COPY.promptClosed)],
    ['a decision that is not an object', { ...inert('pending'), decision: 'executed' }, shows(COPY.promptClosed)],
    // decisions said why this answer didn't do what it looks like it did.
    [
      'an error (an identical request already authorised): not run, try Today',
      { ...inert('pending'), error: 'An identical request is already approved.' },
      shows(COPY.decisionNotRun(TODAY)),
    ],
    [
      'an error beside an executed row: the error decides',
      { ...inert('executed'), path: 'host-replays', error: 'It did not work.' },
      shows(COPY.decisionNotRun(TODAY)),
    ],
    // A failed row says it failed, error or not: a fresh Allow whose host
    // replay threw comes back failed WITH its error, and says what a later
    // read of that row says. The error decides only for any other status.
    [
      'a host replay that threw (failed, with its error): failed, not "not run"',
      { ...inert('failed'), executed: false, path: 'host-replays', error: 'The tool could not finish.' },
      shows(COPY.decisionFailed(TODAY)),
    ],
    // Executed: who runs it, and whether there is a turn to follow.
    ['executed, handed to the warm agent with a stream: followed', handedToAgent('req-0123456789ab'), { line: COPY.decisionAllowed, follow: true }],
    [
      'executed, replayed by the host: done',
      { ...inert('executed'), executed: true, path: 'host-replays' },
      shows(COPY.decisionDone),
    ],
    [
      'executed, its host replay deferred past the undo window',
      { ...inert('executed'), path: 'host-replays', pendingUntil: PENDING_UNTIL },
      shows(COPY.decisionAllowed),
    ],
    ['executed already (an answer that came second)', inert('executed'), shows(COPY.decisionAllowed)],
    ['executed, handed to the agent with no stream to follow', handedToAgent(null), shows(COPY.decisionAllowed)],
    [
      'a stream, but the host replays it: nothing to follow',
      { ...inert('executed'), executed: true, path: 'host-replays', streamReqId: 'req-0123456789ab' },
      shows(COPY.decisionDone),
    ],
    ['a stream that is not a string: nothing to follow', handedToAgent(42), shows(COPY.decisionAllowed)],
    [
      'an `executed` that is not true: not done',
      { ...inert('executed'), executed: 'true', path: 'host-replays' },
      shows(COPY.decisionAllowed),
    ],
    ["a dismiss's answer about a row approved first: Allowed, never Denied", { decision: row('executed') }, shows(COPY.decisionAllowed)],
    // Every other status.
    ['approved, parked for the agent', inert('approved-pending-agent'), shows(COPY.decisionAllowedNextTime)],
    ['dismissed', { decision: row('dismissed') }, shows(COPY.decisionDenied)],
    ['expired', inert('expired'), shows(COPY.decisionExpired)],
    ['stale: things changed', inert('stale'), shows(COPY.decisionChanged(TODAY))],
    ['failed', inert('failed'), shows(COPY.decisionFailed(TODAY))],
    ['still pending', inert('pending'), shows(COPY.decisionNotRun(TODAY))],
    ['a status this build does not know', inert('carrier-pigeon'), shows(COPY.decisionNotRun(TODAY))],
    ['no status', inert(undefined), shows(COPY.decisionNotRun(TODAY))],
    ['a status that is not a string', inert(7), shows(COPY.decisionNotRun(TODAY))],
  ];

  it.each(cases)('%s', (_name, out, want) => {
    expect(decisionOutcome(out, TODAY)).toEqual(want);
  });

  it('follows only a stream decisions is handing to the agent: no other row says follow', () => {
    const following = cases.filter(([, out]) => decisionOutcome(out, TODAY).follow);
    expect(following.map(([name]) => name)).toEqual(['executed, handed to the warm agent with a stream: followed']);
  });
});

// ── After a continuation that never came ────────────────────────────────────

/** decisions:get's answer: the stored row, every marker the line reads null unless `over` says otherwise. */
const stored = (status: unknown, over: Record<string, unknown> = {}) => ({
  decision: {
    ...row(status),
    consumedAt: null,
    replayDueAt: null,
    replayClaimedAt: null,
    replayedAt: null,
    routineReleaseAt: null,
    routineOutcome: null,
    ...over,
  },
});
const AT = '2026-11-14T12:00:11.000Z';

describe("lineAfterMiss: what an answered prompt says once the thread stopped waiting for the agent, read off decisions' row as Today's receipt reads it", () => {
  const cases: Array<[string, unknown, string | null]> = [
    // Nothing better to say than what the prompt says now: it stays.
    ['no answer at all', undefined, null],
    ['no decision (none by that id for this user)', { decision: null }, null],
    ['a decision that is not an object', { decision: 'executed' }, null],
    ['a status this build does not know', stored('carrier-pigeon'), null],
    ['no status', stored(undefined), null],
    // Made: the host replayed it, or the agent took the yes up at the gate.
    ['executed, replayed by the host (the agent was gone by the wake-up)', stored('executed', { replayedAt: AT }), COPY.decisionDone],
    ['executed, taken up by the agent', stored('executed', { consumedAt: AT }), COPY.decisionDone],
    ['parked, then taken up by the agent', stored('approved-pending-agent', { consumedAt: AT }), COPY.decisionDone],
    // Not made, and nothing on the host side holds it: the yes waits at the gate for the agent's next ask.
    ['executed, the agent woken but silent', stored('executed'), COPY.decisionAllowedNextTime],
    ['parked for the agent (a connector call, no agent by the wake-up)', stored('approved-pending-agent'), COPY.decisionAllowedNextTime],
    // The host holds it: its replay is due, or running. What the prompt says still stands.
    ['executed, its host replay due', stored('executed', { replayDueAt: AT }), null],
    ['executed, its host replay running', stored('executed', { replayClaimedAt: AT }), null],
    ['executed, with markers it cannot read', { decision: row('executed') }, null],
    // A routine change is made only once its own outcome says so.
    ['a routine change taken up, its outcome not in', stored('executed', { routineReleaseAt: AT, consumedAt: AT }), COPY.decisionAllowedNextTime],
    [
      'a routine change that succeeded',
      stored('executed', { routineReleaseAt: AT, consumedAt: AT, routineOutcome: 'succeeded' }),
      COPY.decisionDone,
    ],
    // Every other status, as the Allow's own table reads it.
    ['failed, whatever else the row says', stored('failed', { replayClaimedAt: AT, replayedAt: AT }), COPY.decisionFailed(TODAY)],
    ['dismissed (undone, then denied, in Today)', stored('dismissed'), COPY.decisionDenied],
    ['expired', stored('expired'), COPY.decisionExpired],
    ['stale: things changed', stored('stale'), COPY.decisionChanged(TODAY)],
    ['pending again (undone in Today)', stored('pending'), COPY.decisionNotRun(TODAY)],
  ];

  it.each(cases)('%s', (_name, out, want) => {
    expect(lineAfterMiss(out, TODAY)).toBe(want);
  });

  it('never says the line the prompt already says', () => {
    expect(cases.map(([, out]) => lineAfterMiss(out, TODAY))).not.toContain(COPY.decisionAllowed);
  });
});

describe('recheckAfterMiss: the row read back once the thread stopped waiting', () => {
  it("reads the prompt's own decision, for the prompt's own user, and gives its line", async () => {
    const f = fake({ get: () => stored('approved-pending-agent') });

    expect(await f.recheck()).toBe(COPY.decisionAllowedNextTime);
    expect(f.gets.map((g) => g.input)).toEqual([{ decisionId: DECISION_ID, userId: 'usr_mel' }]);
    expect(f.lines).toEqual([]);
  });

  it('without decisions:get: no line, and nothing is read', async () => {
    const f = fake({ without: ['decisions:get'], get: () => stored('approved-pending-agent') });

    expect(await f.recheck()).toBeNull();
    expect(f.lines).toEqual([]);
  });

  it('a read that fails: no line, logged by code', async () => {
    const f = fake({
      get: () => {
        throw fault();
      },
    });

    expect(await f.recheck()).toBeNull();
    expect(f.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'recheck', code: 'store-unavailable' },
    ]);
  });

  it('a read that outlasts its deadline: no line once the deadline passes, logged as a timeout', async () => {
    vi.useFakeTimers();
    const f = fake({ get: () => new Promise<never>(() => {}) });
    let settled = false;
    let line: unknown = 'not yet';
    void f.recheck(5_000).then((value) => {
      settled = true;
      line = value;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toBe(true);
    expect(line).toBeNull();
    expect(f.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'recheck', code: 'timeout' },
    ]);
  });

  it('a read answered in time leaves no timer behind', async () => {
    vi.useFakeTimers();
    const f = fake({ get: () => stored('dismissed') });

    expect(await f.recheck()).toBe(COPY.decisionDenied);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Allow ───────────────────────────────────────────────────────────────────

describe('Allow: decisions:approve, once, for the prompt\'s own user', () => {
  it('approves with exactly the decision, the prompt\'s user, a continuation id it minted, and the request not shown in full: no scope (once)', async () => {
    const f = fake();

    await f.click('allow');

    expect(f.approves).toHaveLength(1);
    const { ctx, input } = f.approves[0]!;
    expect(Object.keys(input).sort()).toEqual(['continuationReqId', 'decisionId', 'requestShownInFull', 'userId']);
    expect(input).toMatchObject({ decisionId: DECISION_ID, userId: 'usr_mel', requestShownInFull: false });
    expect(typeof input['continuationReqId']).toBe('string');
    expect((input['continuationReqId'] as string).length).toBeGreaterThan(0);
    // decisions:approve refuses a ctx whose user isn't the input's: it is the prompt's own.
    expect({ userId: ctx.userId, agentId: ctx.agentId, conversationId: ctx.conversationId }).toEqual({
      userId: input['userId'],
      agentId: 'agt_support',
      conversationId: 'conv_mel_support',
    });
    expect(f.dismisses).toEqual([]);
  });

  it('mints a new continuation id for every Allow', async () => {
    const f = fake();

    await f.click('allow');
    await f.click('allow');

    const ids = f.approves.map((c) => c.input['continuationReqId']);
    expect(new Set(ids).size).toBe(2);
  });

  it('follows the woken turn under the id it minted, with decisions\' pendingUntil, as soon as the approve returns: not left to the gate', async () => {
    const f = fake();

    const answer = await f.click('allow');

    const minted = f.approves[0]!.input['continuationReqId'];
    expect(f.follows).toEqual([
      { prompt: PROMPT, botToken: BOT_TOKEN, reqId: minted, pendingUntil: PENDING_UNTIL, messageTs: PROMPT.messageTs },
    ]);
    // Started here, before the answer is handed back to be drawn: the gate's
    // follow-up would start only after the redraw, which can take as long as
    // the undo window.
    expect(answer).toEqual({ line: COPY.decisionAllowed, settle: true });
    expect('follow' in answer).toBe(false);
  });

  it("the follower gets the message the gate redraws: the clicked one when the click beat the prompt's own post", async () => {
    const clicked = '1763121661.000300';
    const f = fake({ messageTs: clicked });

    await f.click('allow');

    expect(f.follows.map((c) => c.messageTs)).toEqual([clicked]);
  });

  it('a pendingUntil that is not a string reaches the follower as null', async () => {
    const f = fake({ approve: (input) => ({ ...handedToAgent(input['continuationReqId']), pendingUntil: 1_763_121_610_000 }) });

    await f.click('allow');

    expect(f.follows.map((c) => c.pendingUntil)).toEqual([null]);
  });

  it("a stream echoed under another id isn't followed: that turn isn't this Allow's, and following it would take its events away. Logged by code", async () => {
    const f = fake({ approve: () => handedToAgent('req-someoneelse1') });

    const answer = await f.click('allow');

    expect(f.follows).toEqual([]);
    expect(answer).toEqual({ line: COPY.decisionAllowed, settle: true });
    expect(f.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'follow', code: 'other-stream' },
    ]);
  });

  it.each([
    ['the host made the call', { ...inert('executed'), executed: true, path: 'host-replays' }, COPY.decisionDone],
    ['it parked for the agent', inert('approved-pending-agent'), COPY.decisionAllowedNextTime],
    ['the host replays it after the window', { ...inert('executed'), path: 'host-replays', pendingUntil: PENDING_UNTIL }, COPY.decisionAllowed],
    ['it changed since', inert('stale'), COPY.decisionChanged(TODAY)],
  ])('follows nothing when %s, and says so', async (_name, out, line) => {
    const f = fake({ approve: () => out });

    const answer = await f.click('allow');

    expect(answer).toEqual({ line, settle: true });
    expect(f.follows).toEqual([]);
  });

  it('a follower that throws is logged by code, and the answer stands', async () => {
    const f = fake({
      follow: () => {
        throw new PluginError({ code: 'registry-full', plugin: 'channel-slack', message: 'no room for usr_mel' });
      },
    });

    const answer = await f.click('allow');

    expect(answer).toEqual({ line: COPY.decisionAllowed, settle: true });
    expect(f.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'follow', code: 'registry-full' },
    ]);
  });

  it('a follower that hands back a promise that rejects is logged the same way: nothing goes unhandled', async () => {
    const f = fake({
      follow: (() =>
        Promise.reject(
          new PluginError({ code: 'registry-full', plugin: 'channel-slack', message: 'no room' }),
        )) as unknown as (c: ContinuationRequest) => void,
    });

    const answer = await f.click('allow');

    expect(answer).toEqual({ line: COPY.decisionAllowed, settle: true });
    await vi.waitFor(() =>
      expect(f.logged('slack_prompt_failed')).toEqual([
        { installId: INSTALL_ID, kind: 'decision', stage: 'follow', code: 'registry-full' },
      ]),
    );
  });

  it("a second Allow, which decisions answers with the row it already approved, reads as Allowed and follows nothing", async () => {
    // What this pins is the channel's reading of decisions' answer to a
    // second approve. That nothing is approved twice is decisions' own
    // guarantee (it absorbs a second answer), modelled by this fake: the
    // first approve claims the row and then fails on its way out; any after
    // that hands back what is stored.
    let status = 'pending';
    let claims = 0;
    const f = fake({
      approve: () => {
        if (status !== 'pending') return inert(status);
        status = 'executed';
        claims += 1;
        throw fault();
      },
    });

    await expect(f.click('allow')).rejects.toMatchObject({ code: 'store-unavailable' });
    const retry = await f.click('allow');

    expect(retry).toEqual({ line: COPY.decisionAllowed, settle: true });
    expect(claims).toBe(1);
    expect(f.follows).toEqual([]);
  });

  it('a throw from the approve goes to the gate as it is (which says "try again" and opens the prompt)', async () => {
    const f = fake({
      approve: () => {
        throw fault();
      },
    });

    await expect(f.click('allow')).rejects.toMatchObject({ code: 'store-unavailable' });
    expect(f.gets).toEqual([]);
    expect(f.follows).toEqual([]);
  });
});

// ── Deny ────────────────────────────────────────────────────────────────────

describe("Deny: decisions:dismiss for the prompt's own user", () => {
  it('dismisses exactly the decision for the prompt\'s user, and never approves', async () => {
    const f = fake();

    const answer = await f.click('deny');

    expect(f.dismisses).toHaveLength(1);
    expect(f.dismisses[0]!.input).toEqual({ decisionId: DECISION_ID, userId: 'usr_mel' });
    expect(f.dismisses[0]!.ctx.userId).toBe('usr_mel');
    expect(f.approves).toEqual([]);
    expect(answer).toEqual({ line: COPY.decisionDenied, settle: true });
  });

  it.each([
    ['approved first: Allowed, never Denied', { decision: row('executed') }, COPY.decisionAllowed],
    ['parked for the agent first', { decision: row('approved-pending-agent') }, COPY.decisionAllowedNextTime],
    ['expired first', { decision: row('expired') }, COPY.decisionExpired],
    ['gone', { decision: null }, COPY.promptClosed],
  ])('a Deny on a decision %s says what happened', async (_name, out, line) => {
    const f = fake({ dismiss: () => out });

    expect(await f.click('deny')).toEqual({ line, settle: true });
  });

  it('never follows, even when what comes back looks like a stream to follow', async () => {
    const f = fake({ dismiss: () => handedToAgent('req-0123456789ab') });

    const answer = await f.click('deny');

    expect(answer).toEqual({ line: COPY.decisionAllowed, settle: true });
    expect(f.follows).toEqual([]);
  });

  it('a throw from the dismiss goes to the gate as it is', async () => {
    const f = fake({
      dismiss: () => {
        throw fault();
      },
    });

    await expect(f.click('deny')).rejects.toMatchObject({ code: 'store-unavailable' });
  });
});

// ── Past the bus's deadline ─────────────────────────────────────────────────

describe("a decisions hook past the bus's deadline: the answer waits for it to settle, then reads the row", () => {
  /** A hook that lands only when the test says, past the bus's 1 s deadline for it. */
  function slow(action: PromptAction, lands: () => void, o: FakeOptions = {}) {
    vi.useFakeTimers();
    const landing = deferred();
    const hook = async () => {
      await landing.promise;
      lands();
      return { decision: row('ignored: the bus stopped waiting') };
    };
    const f = fake({ timeoutMs: 1_000, ...(action === 'allow' ? { approve: hook } : { dismiss: hook }), ...o });
    let settled: Answer | Error | undefined;
    const answering = f.click(action).then(
      (a) => {
        settled = a;
        return a;
      },
      (err: Error) => {
        settled = err;
        throw err;
      },
    );
    return { f, answering, land: landing.release, settled: () => settled };
  }

  it('an Allow whose approve outlives the deadline: no answer until the approve has settled, then the row says Allowed; nothing followed', async () => {
    let status = 'pending';
    const s = slow('allow', () => {
      status = 'executed';
    }, { get: () => ({ decision: row(status) }) });

    await vi.advanceTimersByTimeAsync(1_000);
    // The bus has given up on the approve. The approve hasn't, so neither has the answer.
    expect(s.settled()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DEFAULT_SERVICE_TIMEOUT_MS);
    expect(s.settled()).toBeUndefined();
    expect(s.f.gets).toEqual([]);

    s.land();

    expect(await s.answering).toEqual({ line: COPY.decisionAllowed, settle: true });
    expect(s.f.gets.map((g) => g.input)).toEqual([{ decisionId: DECISION_ID, userId: 'usr_mel' }]);
    expect(s.f.gets[0]!.ctx.userId).toBe('usr_mel');
    // Its echo was lost with the deadline: nothing to follow by.
    expect(s.f.follows).toEqual([]);
    expect(s.f.approves).toHaveLength(1);
    expect(s.f.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'approve', code: 'timeout' },
    ]);
  });

  it('a Deny whose dismiss outlives the deadline: the same, and the row says Denied', async () => {
    let status = 'pending';
    const s = slow('deny', () => {
      status = 'dismissed';
    }, { get: () => ({ decision: row(status) }) });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.settled()).toBeUndefined();

    s.land();

    expect(await s.answering).toEqual({ line: COPY.decisionDenied, settle: true });
    expect(s.f.approves).toEqual([]);
    expect(s.f.logged('slack_prompt_failed')).toEqual([
      { installId: INSTALL_ID, kind: 'decision', stage: 'dismiss', code: 'timeout' },
    ]);
  });

  it('a hook that settled without answering leaves the decision waiting: "try again from Today", and the prompt is settled', async () => {
    const s = slow('allow', () => undefined, { get: () => ({ decision: row('pending') }) });

    await vi.advanceTimersByTimeAsync(1_000);
    s.land();

    expect(await s.answering).toEqual({ line: COPY.decisionNotRun(TODAY), settle: true });
  });

  it('a row that is gone by then: the prompt closes', async () => {
    const s = slow('allow', () => undefined, { get: () => ({ decision: null }) });

    await vi.advanceTimersByTimeAsync(1_000);
    s.land();

    expect(await s.answering).toEqual({ line: COPY.promptClosed, settle: true });
  });

  it('with nothing to read the row back from, the deadline goes to the gate: only once the hook has settled', async () => {
    const s = slow('allow', () => undefined, { without: ['decisions:get'] });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.settled()).toBeUndefined();
    s.land();

    await expect(s.answering).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a read-back that fails goes to the gate as it is', async () => {
    const s = slow('allow', () => undefined, {
      get: () => {
        throw fault();
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    s.land();

    await expect(s.answering).rejects.toMatchObject({ code: 'store-unavailable' });
  });

  it("the gate's step deadline comes first: decisions' hooks run on the bus's default deadline (they set none), which is longer", () => {
    // So the asker hears it's still going (answers.ts) before the bus stops
    // waiting; past both, the joined call still holds the prompt.
    expect(PROMPT_STEP_TIMEOUT_MS).toBeLessThan(DEFAULT_SERVICE_TIMEOUT_MS);
  });
});

// ── Without decisions ───────────────────────────────────────────────────────

describe('a kernel without decisions', () => {
  it.each([
    ['allow', 'decisions:approve'],
    ['deny', 'decisions:dismiss'],
  ] as const)('%s with no %s: the prompt closes, and nothing is called or followed', async (action, hook) => {
    const f = fake({ without: [hook] });

    expect(await f.click(action)).toEqual({ line: COPY.promptClosed, settle: true });
    expect([...f.approves, ...f.dismisses, ...f.gets]).toEqual([]);
    expect(f.follows).toEqual([]);
  });
});

// ── Logs ────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('name the install, the kind, a stage and a code: never an id, a token, the subject or a reqId', async () => {
    vi.useFakeTimers();
    const lines: Line[] = [];
    const a = fake({ approve: () => handedToAgent('req-someoneelse1') });
    await a.click('allow');
    lines.push(...a.lines);
    const b = fake({
      follow: () => {
        throw fault();
      },
    });
    await b.click('allow');
    lines.push(...b.lines);
    const landing = deferred();
    const c = fake({
      timeoutMs: 1_000,
      dismiss: async () => {
        await landing.promise;
        return { decision: row('dismissed') };
      },
    });
    const late = c.click('deny');
    await vi.advanceTimersByTimeAsync(1_000);
    landing.release();
    await late;
    lines.push(...c.lines);

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.msg).toBe('slack_prompt_failed');
      expect(Object.keys(line.fields).sort()).toEqual(['code', 'installId', 'kind', 'stage']);
    }
    const all = JSON.stringify(lines);
    for (const leak of [
      'usr_mel',
      'agt_support',
      'conv_mel_support',
      DECISION_ID,
      PROMPT.id,
      PROMPT.askerSlackId,
      PROMPT.channel,
      BOT_TOKEN,
      PROMPT.subjectText,
      'req-someoneelse1',
    ]) {
      expect(all, leak).not.toContain(leak);
    }
  });
});
