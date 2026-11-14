import type { Logger } from '@ax/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.js';
import {
  FLUSH_INTERVAL_MS,
  POST_PART_LIMIT,
  STREAM_MAX_AGE_MS,
  REPLY_RATE_LIMIT_RETRIES,
  STREAM_TEXT_LIMIT,
} from '../limits.js';
import { createReplyStream, systemClock, type ReplyStream, type ReplyTarget } from '../reply-stream.js';
import { SlackApiError, type SlackApi, type StreamChunkOut } from '../slack-api.js';
import { fakeBotToken } from './fake-slack-tokens.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const BOT_TOKEN = fakeBotToken('REPLYSTREAMTESTSECRET');
/** The owner's message: in a thread, its own ts differs from the thread's. */
const MESSAGE_TS = '1763035200.000900';
const EYES = { channel: 'D07DMCHANNEL', ts: MESSAGE_TS, name: 'eyes' };
const TARGET: ReplyTarget = {
  channel: 'D07DMCHANNEL',
  threadTs: '1763035200.000100',
  recipientUserId: 'U07ALICE001',
  recipientTeamId: 'T07ABCDEF12',
};
const AGENT_LINK = 'https://ax.example/workspace/agents/agt_alice';
/** Today: where a held call waits. */
const TODAY_LINK = 'https://ax.example/workspace';
const ZWSP = '\u200B';

type Method = 'addReaction' | 'removeReaction' | 'startStream' | 'appendStream' | 'stopStream' | 'postMessage';

interface Call {
  method: Method;
  token: string;
  args: Record<string, unknown>;
  /** The stream's ts: startStream's answer, or the ts an append/stop named. */
  ts?: string;
  ok: boolean;
}

/**
 * A SlackApi that records every reply call. `latencyMs` makes each call take
 * that long on the (fake) clock; `fail(method, n)` returns an error for the
 * n-th call (1-based) of a method, or nothing. Any other method is a failure:
 * a reply never looks anyone up or touches the app.
 */
function fakeSlack(
  o: {
    latencyMs?: number;
    /** Per-method latency in ms (overrides latencyMs for that call). */
    delay?: (method: Method, n: number) => number | undefined;
    fail?: (method: Method, n: number) => Error | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const counts = new Map<Method, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  let nextTs = 1;
  const notHere = async (): Promise<never> => {
    throw new Error('a reply must not call this Slack method');
  };
  async function run<T>(method: Method, token: string, args: Record<string, unknown>, answer: () => T): Promise<T> {
    const n = (counts.get(method) ?? 0) + 1;
    counts.set(method, n);
    const call: Call = { method, token, args, ok: false };
    if (typeof args['ts'] === 'string') call.ts = args['ts'];
    calls.push(call);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const ms = o.delay?.(method, n) ?? o.latencyMs;
      if (ms !== undefined) await new Promise((r) => setTimeout(r, ms));
      const err = o.fail?.(method, n);
      if (err !== undefined) throw err;
      const value = answer();
      call.ok = true;
      return value;
    } finally {
      inFlight -= 1;
    }
  }
  const api: SlackApi = {
    rotateConfigToken: notHere,
    createApp: notHere,
    deleteApp: notHere,
    setAppIcon: notHere,
    oauthAccess: notHere,
    usersInfo: notHere,
    postEphemeral: notHere,
    postMessage: (token, a) => run('postMessage', token, { ...a }, () => undefined),
    addReaction: (token, a) => run('addReaction', token, { ...a }, () => undefined),
    removeReaction: (token, a) => run('removeReaction', token, { ...a }, () => undefined),
    startStream: (token, a) =>
      run('startStream', token, { ...a }, () => {
        const ts = `1763035300.${String(nextTs++).padStart(6, '0')}`;
        calls[calls.length - 1]!.ts = ts;
        return { ts };
      }),
    appendStream: (token, a) => run('appendStream', token, { ...a }, () => undefined),
    stopStream: (token, a) => run('stopStream', token, { ...a }, () => undefined),
  };
  return { api, calls, maxInFlight: () => maxInFlight };
}

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

function chunksOf(call: Call): StreamChunkOut[] {
  const chunks = call.args['chunks'];
  return Array.isArray(chunks) ? (chunks as StreamChunkOut[]) : [];
}

function markdownOf(call: Call): string {
  if (call.method === 'postMessage') return String(call.args['markdownText']);
  return chunksOf(call)
    .map((c) => (c.type === 'markdown_text' ? c.text : ''))
    .join('');
}

function cardsOf(call: Call) {
  return chunksOf(call).filter((c) => c.type === 'task_update');
}

/** Every confirmed stream's markdown, in the order the streams started. */
function streams(calls: readonly Call[]): Array<{ ts: string; text: string }> {
  const out: Array<{ ts: string; text: string }> = [];
  for (const c of calls) {
    if (!c.ok || c.method === 'postMessage') continue;
    if (c.method === 'startStream') out.push({ ts: c.ts!, text: '' });
    const s = out.find((x) => x.ts === c.ts);
    if (s !== undefined) s.text += markdownOf(c);
  }
  return out;
}

/** Everything that reached Slack, streamed or posted, in order. */
function delivered(calls: readonly Call[]): string {
  return calls
    .filter((c) => c.ok)
    .map(markdownOf)
    .join('');
}

let make: (api: SlackApi, logger?: Logger) => ReplyStream;

beforeEach(() => {
  vi.useFakeTimers();
  make = (api, logger = recordingLogger().logger) =>
    createReplyStream({
      api,
      botToken: BOT_TOKEN,
      target: TARGET,
      messageTs: MESSAGE_TS,
      agentLink: AGENT_LINK,
      todayLink: TODAY_LINK,
      logger,
      clock: systemClock,
    });
});

afterEach(() => {
  vi.useRealTimers();
});

const tick = async (ms = FLUSH_INTERVAL_MS): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

async function finishNow(s: ReplyStream, outcome: 'complete' | 'error' | 'busy' = 'complete'): Promise<void> {
  const done = s.finish(outcome);
  await vi.advanceTimersByTimeAsync(3 * 60_000);
  await done;
}

// ── The tests ───────────────────────────────────────────────────────────────

describe('createReplyStream', () => {
  it('no Slack call until there is something to show', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    await tick(10_000);
    s.text('');
    s.artifact();
    await tick(10_000);
    expect(calls).toEqual([]);

    s.text('Hi');
    await tick(FLUSH_INTERVAL_MS - 1);
    expect(calls).toEqual([]);
    await tick(1);
    expect(calls.map((c) => c.method)).toEqual(['startStream']);
    expect(calls[0]!.token).toBe(BOT_TOKEN);
    expect(calls[0]!.args).toEqual({
      channel: TARGET.channel,
      threadTs: TARGET.threadTs,
      recipientUserId: TARGET.recipientUserId,
      recipientTeamId: TARGET.recipientTeamId,
      chunks: [{ type: 'markdown_text', text: 'Hi' }],
    });
  });

  it('deltas within one interval are one append', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('a');
    await tick();
    s.text('b');
    s.text('c');
    await tick(FLUSH_INTERVAL_MS / 2);
    s.text('d');
    await tick(FLUSH_INTERVAL_MS / 2);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream']);
    expect(calls[1]!.args).toEqual({
      channel: TARGET.channel,
      ts: calls[0]!.ts,
      chunks: [{ type: 'markdown_text', text: 'bcd' }],
    });
  });

  it('one call in flight; appended text equals input in order', async () => {
    const slack = fakeSlack({ latencyMs: 2_500 });
    const s = make(slack.api);
    let input = '';
    for (let i = 0; i < 40; i += 1) {
      const delta = `part ${i}; `;
      input += delta;
      s.text(delta);
      await tick(300);
    }
    await finishNow(s);
    expect(slack.maxInFlight()).toBe(1);
    expect(delivered(slack.calls)).toBe(input);
    expect(slack.calls.at(-1)!.method).toBe('stopStream');
  });

  it('status is a single task card updated in place and completed at finish', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.status('Reading your calendar');
    await tick();
    s.status('Searching email');
    await tick();
    s.text('All done.');
    await tick();
    await finishNow(s);

    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'appendStream', 'stopStream']);
    const cards = calls.flatMap(cardsOf);
    expect(new Set(cards.map((c) => c.id))).toEqual(new Set(['status']));
    expect(cards).toEqual([
      { type: 'task_update', id: 'status', title: 'Reading your calendar', status: 'in_progress' },
      { type: 'task_update', id: 'status', title: 'Searching email', status: 'in_progress' },
      { type: 'task_update', id: 'status', title: 'Searching email', status: 'complete' },
    ]);
    expect(calls[3]!.args).toEqual({ channel: TARGET.channel, ts: calls[0]!.ts, chunks: [cards[2]] });
    expect(delivered(calls)).toBe('All done.');
  });

  it('a status that has not changed is not sent again, and one with nothing printable reads "Working"', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.status('  \u202E ');
    await tick();
    s.status(COPY.statusDefault);
    await tick();
    expect(calls.flatMap(cardsOf).map((c) => c.title)).toEqual([COPY.statusDefault]);
  });

  it('text and the card keep the order they arrived in', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Let me check. ');
    s.status('Reading your calendar');
    s.text('Found it.');
    await tick();
    expect(chunksOf(calls[0]!)).toEqual([
      { type: 'markdown_text', text: 'Let me check. ' },
      { type: 'task_update', id: 'status', title: 'Reading your calendar', status: 'in_progress' },
      { type: 'markdown_text', text: 'Found it.' },
    ]);
  });

  it('25,000 characters span three streams, each ≤ 11,000, concatenation equals input', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    let input = '';
    for (let i = 0; input.length < 25_000; i += 1) {
      const delta = `Line ${i} of a long answer, written out in words so it can wrap.`.padEnd(99, '.') + '\n';
      input += delta;
      s.text(delta);
      if (i % 7 === 0) await tick(400);
    }
    await finishNow(s);

    const all = streams(calls);
    // Each stream is filled to the limit (cut at a line end) before the next starts.
    expect(all.map((st) => st.text.length)).toEqual([STREAM_TEXT_LIMIT, STREAM_TEXT_LIMIT, 25_000 - 2 * STREAM_TEXT_LIMIT]);
    expect(all.map((st) => st.text).join('')).toBe(input);
    // Every stream was stopped, each in the same thread.
    expect(calls.filter((c) => c.method === 'stopStream').map((c) => c.ts)).toEqual(all.map((st) => st.ts));
    for (const c of calls.filter((x) => x.method === 'startStream')) expect(c.args['threadTs']).toBe(TARGET.threadTs);
    expect(calls.some((c) => c.method === 'postMessage')).toBe(false);
  });

  it('a single delta past the limit is cut into streams of at most 11,000 too', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    const input = 'word '.repeat(5_000); // 25,000 characters, no newline
    s.text(input);
    await finishNow(s);
    const all = streams(calls);
    expect(all.map((st) => st.text.length)).toEqual([STREAM_TEXT_LIMIT, STREAM_TEXT_LIMIT, 25_000 - 2 * STREAM_TEXT_LIMIT]);
    // Cut after a space, never inside a word.
    for (const st of all.slice(0, -1)) expect(st.text.endsWith(' ')).toBe(true);
    expect(all.map((st) => st.text).join('')).toBe(input);
  });

  it('a delta that crosses the limit sends what fits into the old stream first, cut at a space', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('a'.repeat(STREAM_TEXT_LIMIT - 10));
    await tick();
    s.text('hello world, the rest');
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'stopStream', 'startStream']);
    expect(markdownOf(calls[1]!)).toBe('hello ');
    await finishNow(s);
    expect(streams(calls).map((st) => st.text)).toEqual([
      `${'a'.repeat(STREAM_TEXT_LIMIT - 10)}hello `,
      'world, the rest',
    ]);
  });

  it('a stream 9 minutes old is closed and a new one started in the same thread', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('first');
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['startStream']);
    const first = calls[0]!.ts;

    await tick(STREAM_MAX_AGE_MS - 1);
    expect(calls.map((c) => c.method)).toEqual(['startStream']);
    await tick(1);
    expect(calls.map((c) => [c.method, c.ts])).toEqual([
      ['startStream', first],
      ['stopStream', first],
    ]);

    s.text('second');
    await tick();
    await finishNow(s);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream', 'startStream', 'stopStream']);
    const second = calls[2]!.ts;
    expect(second).not.toBe(first);
    expect(calls[2]!.args['threadTs']).toBe(TARGET.threadTs);
    expect(streams(calls)).toEqual([
      { ts: first, text: 'first' },
      { ts: second, text: 'second' },
    ]);
  });

  it('a turn still working at 9 minutes carries its status card into the new message', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.status('Running the report');
    await tick();
    await tick(STREAM_MAX_AGE_MS);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream', 'startStream']);
    expect(cardsOf(calls[1]!)).toEqual([
      { type: 'task_update', id: 'status', title: 'Running the report', status: 'complete' },
    ]);
    expect(cardsOf(calls[2]!)).toEqual([
      { type: 'task_update', id: 'status', title: 'Running the report', status: 'in_progress' },
    ]);
    s.text('Here is the report.');
    await finishNow(s);
    expect(calls.at(-1)!.method).toBe('stopStream');
    expect(calls.at(-1)!.ts).toBe(calls[2]!.ts);
  });

  it('ratelimited pauses then resumes with nothing lost', async () => {
    const { api, calls } = fakeSlack({
      fail: (method, n) =>
        method === 'appendStream' && n === 1 ? new SlackApiError('chat.appendStream', 'ratelimited', 3_000) : undefined,
    });
    const s = make(api);
    s.text('a');
    await tick();
    s.text('b');
    await tick();
    expect(calls.map((c) => [c.method, c.ok])).toEqual([
      ['startStream', true],
      ['appendStream', false],
    ]);
    s.text('c');
    await tick(2_000);
    // Still waiting out the limit: no call during the pause.
    expect(calls).toHaveLength(2);
    await tick(1_000);
    expect(calls.map((c) => [c.method, c.ok, markdownOf(c)])).toEqual([
      ['startStream', true, 'a'],
      ['appendStream', false, 'b'],
      ['appendStream', true, 'bc'],
    ]);
    await finishNow(s);
    expect(delivered(calls)).toBe('abc');
    expect(calls.some((c) => c.method === 'postMessage')).toBe(false);
  });

  it(`a rate limit that outlasts ${REPLY_RATE_LIMIT_RETRIES} retries falls back to posting`, async () => {
    const { api, calls } = fakeSlack({
      fail: (method) => (method === 'startStream' ? new SlackApiError('chat.startStream', 'ratelimited', 1_000) : undefined),
    });
    const s = make(api);
    s.text('Hello');
    await finishNow(s);
    expect(calls.filter((c) => c.method === 'startStream')).toHaveLength(REPLY_RATE_LIMIT_RETRIES + 1);
    expect(calls.filter((c) => c.method === 'postMessage').map(markdownOf)).toEqual(['Hello']);
  });

  it('an append failure posts exactly the unconfirmed text via postMessage and makes no further stream call', async () => {
    const { api, calls } = fakeSlack({
      fail: (method, n) =>
        method === 'appendStream' && n === 1
          ? new SlackApiError('chat.appendStream', 'message_not_in_streaming_state')
          : undefined,
    });
    const { logger, lines } = recordingLogger();
    const s = make(api, logger);
    s.text('Hello ');
    await tick();
    s.text('world');
    await tick();
    s.text(', again.');
    s.status('Still working');
    await tick(5_000);
    await finishNow(s);

    expect(calls.map((c) => [c.method, c.ok])).toEqual([
      ['startStream', true],
      ['appendStream', false],
      ['postMessage', true],
    ]);
    expect(calls[2]!.args).toEqual({ channel: TARGET.channel, threadTs: TARGET.threadTs, markdownText: 'world, again.' });
    expect(delivered(calls)).toBe('Hello world, again.');
    expect(lines).toEqual([
      { level: 'warn', msg: 'slack_reply_failed', fields: { stage: 'append', code: 'message_not_in_streaming_state' } },
    ]);
  });

  it('startStream failure → whole reply posted at finish', async () => {
    const { api, calls } = fakeSlack({
      fail: (method) => (method === 'startStream' ? new SlackApiError('chat.startStream', 'invalid_thread_ts') : undefined),
    });
    const s = make(api);
    s.status('Reading');
    s.text('Hello');
    await tick();
    s.text(' world');
    await tick(5_000);
    s.artifact();
    await finishNow(s, 'error');
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'postMessage']);
    expect(markdownOf(calls[1]!)).toBe(`Hello world\n\n${COPY.artifactLink(AGENT_LINK)}\n\n${COPY.turnFailed}`);
  });

  it('a long reply that falls back to posting goes out in parts of at most 11,000', async () => {
    const { api, calls } = fakeSlack({
      fail: (method) => (method === 'startStream' ? new SlackApiError('chat.startStream', 'internal_error') : undefined),
    });
    const s = make(api);
    const input = 'All work and no play.\n'.repeat(1_200); // 26,400 characters
    s.text(input);
    await finishNow(s);
    const posts = calls.filter((c) => c.method === 'postMessage');
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const p of posts) expect(markdownOf(p).length).toBeLessThanOrEqual(POST_PART_LIMIT);
    expect(posts.map(markdownOf).join('')).toBe(input);
  });

  it('a stop that fails during rotation posts only the text that never reached Slack', async () => {
    const { api, calls } = fakeSlack({
      fail: (method, n) =>
        method === 'stopStream' && n === 1 ? new SlackApiError('chat.stopStream', 'internal_error') : undefined,
    });
    const s = make(api);
    s.text('before');
    await tick();
    await tick(STREAM_MAX_AGE_MS);
    s.text('after');
    await finishNow(s);
    expect(calls.map((c) => [c.method, c.ok])).toEqual([
      ['startStream', true],
      ['stopStream', false],
      ['postMessage', true],
    ]);
    expect(delivered(calls)).toBe('beforeafter');
  });

  it('a revoked token mid-reply: the post fails too, both are logged by code, and nothing more is tried', async () => {
    const revoked = (method: string) => new SlackApiError(method, 'token_revoked');
    const { api, calls } = fakeSlack({
      fail: (method, n) =>
        method === 'appendStream' ? revoked('chat.appendStream') : method === 'postMessage' && n >= 1 ? revoked('chat.postMessage') : undefined,
    });
    const { logger, lines } = recordingLogger();
    const s = make(api, logger);
    s.text('one');
    await tick();
    s.text('two');
    await tick();
    s.text('\n'.repeat(3) + 'x'.repeat(POST_PART_LIMIT + 10));
    await finishNow(s);
    expect(calls.map((c) => [c.method, c.ok])).toEqual([
      ['startStream', true],
      ['appendStream', false],
      ['postMessage', false],
    ]);
    expect(lines).toEqual([
      { level: 'warn', msg: 'slack_reply_failed', fields: { stage: 'append', code: 'token_revoked' } },
      { level: 'warn', msg: 'slack_reply_failed', fields: { stage: 'post', code: 'token_revoked' } },
    ]);
    expect(JSON.stringify(lines)).not.toContain(BOT_TOKEN);
  });

  it("finish('error') adds the failure line and marks the card error", async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.status('Reading your calendar');
    s.text('Let me look.');
    await tick();
    await finishNow(s, 'error');
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'stopStream']);
    expect(delivered(calls)).toBe(`Let me look.\n\n${COPY.turnFailed}`);
    expect(calls[2]!.args).toEqual({
      channel: TARGET.channel,
      ts: calls[0]!.ts,
      chunks: [{ type: 'task_update', id: 'status', title: 'Reading your calendar', status: 'error' }],
    });
  });

  it("finish('busy') says the agent is busy, alone when nothing else was said", async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    await finishNow(s, 'busy');
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(delivered(calls)).toBe(COPY.busy);
    expect(calls[1]!.args).toEqual({ channel: TARGET.channel, ts: calls[0]!.ts });
  });

  it("finish('complete') with nothing → one postMessage of emptyReply", async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    await finishNow(s, 'complete');
    expect(calls).toEqual([
      {
        method: 'postMessage',
        token: BOT_TOKEN,
        args: { channel: TARGET.channel, threadTs: TARGET.threadTs, markdownText: COPY.emptyReply },
        ok: true,
      },
    ]);
  });

  it("working() puts 👀 on the owner's message and takes it off once the reply has shown; no card", async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.working();
    await tick();
    expect(calls).toEqual([{ method: 'addReaction', token: BOT_TOKEN, args: EYES, ok: true, ts: MESSAGE_TS }]);
    s.text('Hi.');
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'removeReaction']);
    expect(calls[2]!.args).toEqual(EYES);
    await finishNow(s);
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'removeReaction', 'stopStream']);
    expect(calls.flatMap(cardsOf)).toEqual([]);
    expect(delivered(calls)).toBe('Hi.');
  });

  it("the agent's own status card is the first thing shown: 👀 comes off once it is up", async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.working();
    s.status('Searching email');
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'removeReaction']);
    await finishNow(s);
  });

  it('working() then nothing: 👀 comes off once the emptyReply post is up', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.working();
    await tick();
    await finishNow(s, 'complete');
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'postMessage', 'removeReaction']);
    expect(delivered(calls)).toBe(COPY.emptyReply);
  });

  it('a turn that fails: 👀 comes off once the failure line is up, exactly once', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.working();
    await tick();
    await finishNow(s, 'error');
    const methods = calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'removeReaction')).toHaveLength(1);
    expect(methods.indexOf('removeReaction')).toBeGreaterThan(methods.indexOf('startStream'));
    expect(delivered(calls)).toBe(COPY.turnFailed);
  });

  it('the reply never waits on 👀: a slow add holds back nothing, and the remove still comes strictly after it', async () => {
    const { api, calls } = fakeSlack({ delay: (m) => (m === 'addReaction' ? 8_000 : undefined) });
    const s = make(api);
    s.working();
    s.text('Hi.');
    await tick();
    // The add hasn't answered, and the reply is already out.
    expect(calls.map((c) => [c.method, c.ok])).toEqual([
      ['addReaction', false],
      ['startStream', true],
    ]);
    await tick(8_000);
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'removeReaction']);
    await finishNow(s);
  });

  it('the reply never waits on 👀 coming off: a slow remove holds back nothing', async () => {
    const { api, calls } = fakeSlack({ delay: (m) => (m === 'removeReaction' ? 8_000 : undefined) });
    const s = make(api);
    s.working();
    s.text('Hi.');
    await tick();
    s.text(' More.');
    await tick();
    expect(calls.map((c) => [c.method, c.ok])).toEqual([
      ['addReaction', true],
      ['startStream', true],
      ['removeReaction', false],
      ['appendStream', true],
    ]);
    await finishNow(s);
  });

  it('a 👀 Slack refuses is logged by code, and the Working card shows instead (nothing to take off)', async () => {
    const { api, calls } = fakeSlack({
      fail: (m) => (m === 'addReaction' ? new SlackApiError('reactions.add', 'missing_scope') : undefined),
    });
    const rec = recordingLogger();
    const s = make(api, rec.logger);
    s.working();
    await tick();
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream']);
    expect(calls.flatMap(cardsOf)).toEqual([{ type: 'task_update', id: 'status', title: 'Working', status: 'in_progress' }]);
    expect(rec.lines).toContainEqual(
      expect.objectContaining({ msg: 'slack_reply_failed', fields: { stage: 'react', code: 'missing_scope' } }),
    );
    // Only the card was shown: the same message says emptyReply, never a second post.
    await finishNow(s, 'complete');
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'appendStream', 'stopStream']);
    expect(delivered(calls)).toBe(COPY.emptyReply);
  });

  it('a refusal that lands after the text is out adds no card under it', async () => {
    const { api, calls } = fakeSlack({
      delay: (m) => (m === 'addReaction' ? 3_000 : undefined),
      fail: (m) => (m === 'addReaction' ? new SlackApiError('reactions.add', 'missing_scope') : undefined),
    });
    const s = make(api);
    s.working();
    s.text('Hi.');
    await tick();
    await tick(3_000);
    await finishNow(s);
    expect(calls.flatMap(cardsOf)).toEqual([]);
    expect(delivered(calls)).toBe('Hi.');
  });

  it.each([
    'timeout',
    'network',
    'bad-response',
    'http-503',
    'internal_error',
    'fatal_error',
    'service_unavailable',
    'request_timeout',
  ])('an add that failed with %s may have landed: card shown, and it still comes off', async (code) => {
    const { api, calls } = fakeSlack({
      fail: (m) => (m === 'addReaction' ? new SlackApiError('reactions.add', code) : undefined),
    });
    const s = make(api);
    s.working();
    await tick();
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'removeReaction']);
    expect(calls.flatMap(cardsOf)).toEqual([{ type: 'task_update', id: 'status', title: 'Working', status: 'in_progress' }]);
    await finishNow(s);
  });

  it('a refusal Slack gives for good (missing_scope) is not taken off: there is nothing to take off', async () => {
    const { api, calls } = fakeSlack({
      fail: (m) => (m === 'addReaction' ? new SlackApiError('reactions.add', 'missing_scope') : undefined),
    });
    const s = make(api);
    s.working();
    s.text('Hi.');
    await finishNow(s);
    await tick();
    expect(calls.filter((c) => c.method === 'removeReaction')).toEqual([]);
  });

  it('a start that is rate-limited, then lands: 👀 stays on through the wait and comes off once, after it', async () => {
    const { api, calls } = fakeSlack({
      fail: (m, n) => (m === 'startStream' && n === 1 ? new SlackApiError('chat.startStream', 'ratelimited', 3_000) : undefined),
    });
    const s = make(api);
    s.working();
    s.text('Hi.');
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream']);
    await tick(3_000);
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'startStream', 'removeReaction']);
    await finishNow(s);
    expect(calls.filter((c) => c.method === 'removeReaction')).toHaveLength(1);
  });

  it('nothing could be shown (stream and post both refused): 👀 still comes off at the end, once', async () => {
    const { api, calls } = fakeSlack({
      fail: (m) =>
        m === 'startStream'
          ? new SlackApiError('chat.startStream', 'internal_error')
          : m === 'postMessage'
            ? new SlackApiError('chat.postMessage', 'channel_not_found')
            : undefined,
    });
    const s = make(api);
    s.working();
    s.text('Hi.');
    await finishNow(s);
    await tick();
    const methods = calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'removeReaction')).toHaveLength(1);
    expect(methods.indexOf('removeReaction')).toBeGreaterThan(methods.indexOf('addReaction'));
    expect(calls.filter((c) => (c.method === 'startStream' || c.method === 'postMessage') && c.ok)).toEqual([]);
  });

  it("the fallback card never replaces the agent's own status, and adds no empty line to its reply", async () => {
    const { api, calls } = fakeSlack({
      fail: (m) => (m === 'addReaction' ? new SlackApiError('reactions.add', 'internal_error') : undefined),
    });
    const s = make(api);
    s.working();
    s.status('Reading your calendar');
    await tick();
    await tick();
    expect(calls.flatMap(cardsOf)).toEqual([
      { type: 'task_update', id: 'status', title: 'Reading your calendar', status: 'in_progress' },
    ]);
    await finishNow(s);
    expect(delivered(calls)).toBe('');
  });

  it('already_reacted counts as on (it still comes off), and no_reaction on the way off is no failure', async () => {
    const { api, calls } = fakeSlack({
      fail: (m) =>
        m === 'addReaction'
          ? new SlackApiError('reactions.add', 'already_reacted')
          : m === 'removeReaction'
            ? new SlackApiError('reactions.remove', 'no_reaction')
            : undefined,
    });
    const rec = recordingLogger();
    const s = make(api, rec.logger);
    s.working();
    s.text('Hi.');
    await finishNow(s);
    expect(calls.map((c) => c.method).filter((m) => m.endsWith('Reaction'))).toEqual(['addReaction', 'removeReaction']);
    expect(calls.flatMap(cardsOf)).toEqual([]);
    expect(rec.lines).toEqual([]);
  });

  it('a 👀 that will not come off is logged by code once, and never tried again: not per posted part', async () => {
    let starts = 0;
    const { api, calls } = fakeSlack({
      fail: (m) => {
        if (m === 'removeReaction') return new SlackApiError('reactions.remove', 'internal_error');
        if (m === 'startStream') {
          starts += 1;
          return new SlackApiError('chat.startStream', 'internal_error');
        }
        return undefined;
      },
    });
    const rec = recordingLogger();
    const s = make(api, rec.logger);
    s.working();
    // Past one post part: the reply falls back to posting, in two parts.
    s.text(`${'a'.repeat(POST_PART_LIMIT)} ${'b'.repeat(100)}`);
    await finishNow(s);
    expect(starts).toBe(1);
    expect(calls.filter((c) => c.method === 'postMessage' && c.ok)).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'removeReaction')).toHaveLength(1);
    expect(rec.lines.filter((l) => (l.fields as { stage?: string } | undefined)?.stage === 'unreact')).toEqual([
      expect.objectContaining({ fields: { stage: 'unreact', code: 'internal_error' } }),
    ]);
  });

  it('artifact() twice → one link line at the end', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Here is your chart.');
    s.artifact();
    await tick();
    s.artifact();
    s.text(' It covers the quarter.');
    await finishNow(s);
    const text = delivered(calls);
    expect(text).toBe(`Here is your chart. It covers the quarter.\n\n${COPY.artifactLink(AGENT_LINK)}`);
    expect(text.split(COPY.artifactLink(AGENT_LINK))).toHaveLength(2);
  });

  it('model text is neutralized before it leaves, across deltas and calls', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    const parts = ['<!channel> look <@U07BOB0001>', ' and <', '!here> and <', '#C07GENERAL1>'];
    s.text(parts[0]!);
    s.text(parts[1]!);
    await tick();
    s.text(parts[2]!);
    await tick();
    s.text(parts[3]!);
    s.status('<!everyone> ping');
    await finishNow(s);

    const text = delivered(calls);
    expect(/<[!@#]/.test(text)).toBe(false);
    expect(text.split(ZWSP).join('')).toBe(parts.join(''));
    for (const c of calls) {
      for (const chunk of chunksOf(c)) {
        const value = chunk.type === 'markdown_text' ? chunk.text : chunk.title;
        expect(/<[!@#]/.test(value), value).toBe(false);
      }
    }
  });

  it('finish twice is a no-op, and nothing said after finish is sent', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('hi');
    const first = s.finish('complete');
    const second = s.finish('error');
    // Said once finish was asked for, before it settled: none of it is sent.
    s.text(' more');
    s.status('late');
    s.artifact();
    s.held('sender');
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([first, second]);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);

    // A hold after the reply ended adds no line anywhere, and no message of its own.
    s.held('owner');
    s.held('sender');
    await finishNow(s, 'error');
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(delivered(calls)).toBe('hi');
    expect(delivered(calls)).not.toContain(COPY.heldForOwner);
    expect(delivered(calls)).not.toContain(COPY.heldForSender(TODAY_LINK));
  });

  it('a failure is logged by stage and code only, never with text or the token', async () => {
    const { api } = fakeSlack({
      fail: (method) => (method === 'startStream' ? new Error(`boom ${BOT_TOKEN} secret text`) : undefined),
    });
    const { logger, lines } = recordingLogger();
    const s = make(api, logger);
    s.text('private words');
    await finishNow(s);
    expect(lines).toEqual([{ level: 'warn', msg: 'slack_reply_failed', fields: { stage: 'start', code: 'unknown' } }]);
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('finish never rejects, even when the logger throws', async () => {
    const { api } = fakeSlack({
      fail: (method) => new SlackApiError(`chat.${method}`, 'internal_error'),
    });
    const { logger } = recordingLogger();
    const throwing: Logger = { ...logger, warn: () => { throw new Error('stdout closed'); } };
    const s = make(api, throwing);
    s.text('hello');
    await tick();
    await expect(finishNow(s)).resolves.toBeUndefined();
  });
});

describe('createReplyStream: a call held for approval', () => {
  it.each([
    // A DM, or a channel member who can use the agent: it waits in their own Today.
    ['sender', () => COPY.heldForSender(TODAY_LINK)],
    // An outsider's turn: it waits for the agent's owner, whom they can't reach.
    ['owner', () => COPY.heldForOwner],
  ] as const)('held(%j): the reply ends with the line that says who must approve', async (who, line) => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Let me send that.');
    await tick();
    s.held(who);
    await finishNow(s);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'stopStream']);
    expect(delivered(calls)).toBe(`Let me send that.\n\n${line()}`);
  });

  it('however many calls are held, the line is said once', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Two things need an OK.');
    s.held('sender');
    await tick();
    s.held('sender');
    s.held('sender');
    await finishNow(s);
    expect(delivered(calls)).toBe(`Two things need an OK.\n\n${COPY.heldForSender(TODAY_LINK)}`);
  });

  it.each([
    [['owner', 'sender'], COPY.heldForOwner],
    [['sender', 'owner'], COPY.heldForSender(TODAY_LINK)],
  ] as const)('holds for different people (%j): the first decides whose line, said once', async (order, line) => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Two things need an OK.');
    s.held(order[0]);
    await tick();
    s.held(order[1]);
    await finishNow(s);
    expect(delivered(calls)).toBe(`Two things need an OK.\n\n${line}`);
  });

  it('an artifact and a hold: the link first, then the held line, whichever came first', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Here is the draft.');
    s.held('owner');
    s.artifact();
    await finishNow(s);
    expect(delivered(calls)).toBe(`Here is the draft.\n\n${COPY.artifactLink(AGENT_LINK)}\n\n${COPY.heldForOwner}`);
  });

  it('a hold with nothing else said: the held line alone, never emptyReply', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.held('owner');
    await finishNow(s);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(delivered(calls)).toBe(COPY.heldForOwner);
  });

  it('a hold when only the Working card showed: the line goes in that message, never emptyReply', async () => {
    const { api, calls } = fakeSlack({
      fail: (m) => (m === 'addReaction' ? new SlackApiError('reactions.add', 'missing_scope') : undefined),
    });
    const s = make(api);
    s.working();
    await tick();
    await tick();
    s.held('sender');
    await finishNow(s);
    expect(calls.map((c) => c.method)).toEqual(['addReaction', 'startStream', 'appendStream', 'stopStream']);
    expect(delivered(calls)).toBe(COPY.heldForSender(TODAY_LINK));
  });

  it('a hold, then the turn fails: the held line, then the failure line', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Sending it now.');
    s.held('sender');
    await finishNow(s, 'error');
    expect(delivered(calls)).toBe(`Sending it now.\n\n${COPY.heldForSender(TODAY_LINK)}\n\n${COPY.turnFailed}`);
  });

  it('a reply that fell back to posting ends the same way: link, held line, failure line', async () => {
    const { api, calls } = fakeSlack({
      fail: (method) => (method === 'startStream' ? new SlackApiError('chat.startStream', 'invalid_thread_ts') : undefined),
    });
    const s = make(api);
    s.text('Hello');
    s.artifact();
    s.held('owner');
    await finishNow(s, 'error');
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'postMessage']);
    expect(markdownOf(calls[1]!)).toBe(
      `Hello\n\n${COPY.artifactLink(AGENT_LINK)}\n\n${COPY.heldForOwner}\n\n${COPY.turnFailed}`,
    );
  });
});

// ── Bare broadcast words ────────────────────────────────────────────────────

/** A bare broadcast word as Slack could read it: an `@` after no letter or digit, the word followed by none. */
const BROADCAST = /(?<![A-Za-z0-9])@(?:here|channel|everyone)(?![A-Za-z0-9])/i;

/** Slack refuses every stream, so the whole reply is posted. */
const POSTING = {
  fail: (method: Method) =>
    method === 'startStream' ? new SlackApiError('chat.startStream', 'internal_error') : undefined,
};

/** Each Slack message's text, in order: one per stream, or one per post when the reply was posted. */
function messages(calls: readonly Call[]): string[] {
  return calls.some((c) => c.method === 'postMessage')
    ? calls.filter((c) => c.ok && c.method === 'postMessage').map(markdownOf)
    : streams(calls).map((st) => st.text);
}

/**
 * Slack takes the stream's start, then refuses to add to it: the text the
 * start carried stays in that message, and the rest is posted at finish.
 */
const FALLS_BACK = {
  fail: (method: Method) =>
    method === 'appendStream' ? new SlackApiError('chat.appendStream', 'internal_error') : undefined,
};

/**
 * The runs of text Slack may judge on their own, in order: each message's
 * text, cut where its status card sits (Slack may render the card between
 * them), and each post. A word is live if it is live in any one of them.
 */
function segments(calls: readonly Call[]): string[] {
  const runsByTs = new Map<string, string[]>();
  const out: string[][] = [];
  for (const c of calls) {
    if (!c.ok) continue;
    if (c.method === 'postMessage') {
      out.push([markdownOf(c)]);
      continue;
    }
    if (c.method === 'startStream') {
      const fresh = [''];
      runsByTs.set(c.ts!, fresh);
      out.push(fresh);
    }
    const runs = c.ts === undefined ? undefined : runsByTs.get(c.ts);
    if (runs === undefined) continue;
    for (const chunk of chunksOf(c)) {
      if (chunk.type === 'task_update') runs.push('');
      else if (chunk.type === 'markdown_text') runs[runs.length - 1] += chunk.text;
    }
  }
  return out.flat().filter((text) => text.length > 0);
}

describe('createReplyStream: a bare @here, @channel or @everyone', () => {
  it.each(['streamed', 'streamed, then posted'] as const)(
    "'ping @channel now' split at every point across two text() calls, a flush between (%s): Slack never gets a live @channel",
    async (how) => {
      const input = 'ping @channel now';
      const expected = `ping @${ZWSP}channel now`;
      for (let k = 0; k <= input.length; k += 1) {
        const { api, calls } = fakeSlack(how === 'streamed' ? {} : FALLS_BACK);
        const s = make(api);
        s.text(input.slice(0, k));
        await tick();
        const flushed = calls.filter((c) => c.ok).map(markdownOf).join('');
        s.text(input.slice(k));
        await finishNow(s);

        const sent = calls.filter((c) => c.ok).map(markdownOf);
        for (const text of sent) expect(BROADCAST.test(text), `split at ${k}: ${JSON.stringify(text)}`).toBe(false);
        expect(sent.join(''), `split at ${k}`).toBe(expected);
        // The flush between sent no part of the word: `@`, `@c` … `@channel` waited for what came next.
        expect(flushed, `split at ${k}`).toBe(k <= 5 ? input.slice(0, k) : k <= 13 ? 'ping ' : expected.slice(0, k + 1));
        // Posted: the stream's message keeps what that flush sent and the rest is a post of its own, so
        // posting can't re-join the word for its own check (postRest judges only what it posts): what the
        // first message holds is the holdback's doing alone.
        if (how !== 'streamed' && k > 0 && k < input.length) {
          expect(segments(calls), `split at ${k}`).toEqual([flushed, expected.slice(flushed.length)]);
        }
      }
    },
  );

  // Where the reply's text goes on in a new Slack message, or past the status card, right after a letter:
  // `me` makes an `@` that follows it an address in the reply, but not in the run Slack judges next.
  // `say` sends `first`, crosses the edge and sends `piece`, the word's start.
  const FULL = `${'a'.repeat(STREAM_TEXT_LIMIT - 2)}me`;
  it.each<[string, string, (s: ReplyStream, first: string, piece: string) => Promise<void>]>([
    [
      'the status card',
      'Write to me',
      async (s, first, piece) => {
        s.text(first);
        s.status('Looking it up');
        s.text(piece);
      },
    ],
    [
      'an age rotation',
      'Write to me',
      async (s, first, piece) => {
        s.text(first);
        await tick();
        await tick(STREAM_MAX_AGE_MS);
        s.text(piece);
      },
    ],
    [
      'a full stream',
      FULL,
      async (s, first, piece) => {
        s.text(first);
        s.text(piece);
      },
    ],
    [
      'a full stream cut inside one delta',
      FULL,
      async (s, first, piece) => {
        s.text(first + piece);
      },
    ],
  ])(
    "a letter, then %s, then '@channel now' split at every point: the word starts the next run whole and is caught",
    async (_edge, first, say) => {
      const rest = '@channel now';
      for (let k = 1; k < rest.length; k += 1) {
        const { api, calls } = fakeSlack();
        const s = make(api);
        await say(s, first, rest.slice(0, k));
        await tick();
        s.text(rest.slice(k));
        await finishNow(s);

        const runs = segments(calls);
        for (const text of runs) expect(BROADCAST.test(text), `split at ${k}: ${JSON.stringify(text)}`).toBe(false);
        expect(runs, `split at ${k}`).toEqual([first, `@${ZWSP}channel now`]);
      }
    },
  );

  it.each<[string, string, (s: ReplyStream) => void, string[]]>([
    ['in the same message', 'ping ', () => {}, ['ping @channels now']],
    ['right after the status card', 'Write to me', (s) => s.status('Looking it up'), ['Write to me', '@channels now']],
  ])(
    'a whole word waits for the character after it (%s): `@channel` then `s` is the name `@channels`, kept as typed, and nothing live went out between',
    async (_where, first, cross, runs) => {
      const { api, calls } = fakeSlack();
      const s = make(api);
      s.text(first);
      cross(s);
      s.text('@channel');
      await tick();
      // The flush sent what came before the word, and nothing of the word.
      expect(segments(calls)).toEqual([first]);
      s.text('s now');
      await finishNow(s);
      expect(segments(calls)).toEqual(runs);
      expect(delivered(calls)).not.toContain(ZWSP);
    },
  );

  it('word-sized deltas, a flush after each: an address keeps its @ as typed, and a broadcast word is still caught', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    for (const delta of ['Write to ', 'support', '@channel', '.io', ' or tell ', '@', 'every', 'one', ', ', 'team', '@here', 's.']) {
      s.text(delta);
      await tick();
    }
    await finishNow(s);
    expect(delivered(calls)).toBe(`Write to support@channel.io or tell @${ZWSP}everyone, team@heres.`);
  });

  it('a status that arrives while an @ waits goes out first, and the word after it is still caught', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('ping @chan');
    s.status('Reading your calendar');
    await tick();
    expect(chunksOf(calls[0]!)).toEqual([
      { type: 'markdown_text', text: 'ping ' },
      { type: 'task_update', id: 'status', title: 'Reading your calendar', status: 'in_progress' },
    ]);
    s.text('nel now');
    await finishNow(s);
    expect(delivered(calls)).toBe(`ping @${ZWSP}channel now`);
  });

  it('text after the status card is judged as starting there: a letter before the card exempts nothing', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Write to me');
    s.status('Looking it up');
    s.text('@channel.com');
    await finishNow(s);
    expect(chunksOf(calls[0]!)).toEqual([
      { type: 'markdown_text', text: 'Write to me' },
      { type: 'task_update', id: 'status', title: 'Looking it up', status: 'in_progress' },
      { type: 'markdown_text', text: `@${ZWSP}channel.com` },
    ]);
  });

  it.each(['streamed', 'posted'] as const)(
    'a full message cut right before an @ (%s): the next message starts with the word, and it is caught',
    async (how) => {
      const limit = how === 'streamed' ? STREAM_TEXT_LIMIT : POST_PART_LIMIT;
      const { api, calls } = fakeSlack(how === 'posted' ? POSTING : {});
      const s = make(api);
      // One letter before the @ makes it an address, until the cut takes the letter away.
      s.text(`${'a'.repeat(limit)}@channel hi`);
      await finishNow(s);
      expect(messages(calls)).toEqual(['a'.repeat(limit), `@${ZWSP}channel hi`]);
    },
  );

  it.each(['streamed', 'posted'] as const)(
    'a full message cut right after a whole word (%s): the message that ends with it is caught',
    async (how) => {
      const limit = how === 'streamed' ? STREAM_TEXT_LIMIT : POST_PART_LIMIT;
      const { api, calls } = fakeSlack(how === 'posted' ? POSTING : {});
      const s = make(api);
      // `@channels` is a name; cut after `@channel`, the first message would end in a broadcast.
      s.text(`${'a'.repeat(limit - 9)}(@channels)`);
      await finishNow(s);
      expect(messages(calls)).toEqual([`${'a'.repeat(limit - 9)}(@${ZWSP}channel`, 's)']);
    },
  );

  it('after a stream rotates by age, the new message starts fresh: an @ that followed a letter in the old one is caught', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text('Write to me');
    await tick();
    await tick(STREAM_MAX_AGE_MS);
    s.text('@channel.com');
    await finishNow(s);
    expect(messages(calls)).toEqual(['Write to me', `@${ZWSP}channel.com`]);
  });

  it('a reply that falls back to posting: its first post is a message of its own, so its start is judged alone', async () => {
    const { api, calls } = fakeSlack({
      fail: (method, n) =>
        method === 'appendStream' && n === 1 ? new SlackApiError('chat.appendStream', 'internal_error') : undefined,
    });
    const s = make(api);
    s.text('Write to me');
    await tick();
    s.text('@channel.com');
    await tick();
    await finishNow(s);
    expect(calls.filter((c) => c.ok).map((c) => [c.method, markdownOf(c)])).toEqual([
      ['startStream', 'Write to me'],
      ['postMessage', `@${ZWSP}channel.com`],
    ]);
  });

  it.each<[string, string]>([
    ['Ping @here', `Ping @${ZWSP}here`],
    ['Ping @every', 'Ping @every'],
    ['@', '@'],
  ])('text still waiting when the reply ends (%j) goes out with it, before the closing lines', async (said, sent) => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.text(said);
    s.held('sender');
    await finishNow(s);
    expect(delivered(calls)).toBe(`${sent}\n\n${COPY.heldForSender(TODAY_LINK)}`);
  });
});
