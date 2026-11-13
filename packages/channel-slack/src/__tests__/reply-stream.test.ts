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
const TARGET: ReplyTarget = {
  channel: 'D07DMCHANNEL',
  threadTs: '1763035200.000100',
  recipientUserId: 'U07ALICE001',
  recipientTeamId: 'T07ABCDEF12',
};
const AGENT_LINK = 'https://ax.example/workspace/agents/agt_alice';
const ZWSP = '\u200B';

type Method = 'startStream' | 'appendStream' | 'stopStream' | 'postMessage';

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
function fakeSlack(o: { latencyMs?: number; fail?: (method: Method, n: number) => Error | undefined } = {}) {
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
      if (o.latencyMs !== undefined) await new Promise((r) => setTimeout(r, o.latencyMs));
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
    createReplyStream({ api, botToken: BOT_TOKEN, target: TARGET, agentLink: AGENT_LINK, logger, clock: systemClock });
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

  it('working() shows the Working card at the first flush, before any text, and it completes at finish', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.working();
    await tick();
    expect(calls.map((c) => c.method)).toEqual(['startStream']);
    expect(calls.flatMap(cardsOf)).toEqual([{ type: 'task_update', id: 'status', title: 'Working', status: 'in_progress' }]);
    s.text('Hi.');
    await tick();
    await finishNow(s);
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'stopStream']);
    expect(calls.flatMap(cardsOf).at(-1)).toEqual({ type: 'task_update', id: 'status', title: 'Working', status: 'complete' });
    expect(delivered(calls)).toBe('Hi.');
  });

  it('working() then nothing: the same message says emptyReply, never a second post', async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.working();
    await tick();
    await finishNow(s, 'complete');
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'appendStream', 'stopStream']);
    expect(delivered(calls)).toBe(COPY.emptyReply);
  });

  it("working() never replaces the agent's own status", async () => {
    const { api, calls } = fakeSlack();
    const s = make(api);
    s.status('Reading your calendar');
    s.working();
    await tick();
    expect(calls.flatMap(cardsOf)).toEqual([
      { type: 'task_update', id: 'status', title: 'Reading your calendar', status: 'in_progress' },
    ]);
    await finishNow(s);
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
    s.text(' more');
    s.status('late');
    s.artifact();
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([first, second]);
    await finishNow(s, 'error');
    expect(calls.map((c) => c.method)).toEqual(['startStream', 'stopStream']);
    expect(delivered(calls)).toBe('hi');
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
