/**
 * `streamReply` reconnects a dropped reply stream on the same reqId (TASK-27).
 *
 * The bug this pins: on an iPhone, switching apps mid-reply kills Safari's open
 * connections. The turn carried on on the host, but the reader treated the dead
 * connection as a dead reply and put up "That reply didn't finish" — over an
 * answer that was, by then, sitting finished in the transcript.
 *
 * Every test here fails against the pre-TASK-27 reader, which never opened the
 * stream a second time: it reported `WORKSPACE_STREAM_LOST` on the first drop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi, WORKSPACE_STREAM_LOST, STREAM_RECONNECT_DELAYS_MS } from '../workspace-api';

const enc = new TextEncoder();
const line = (f: unknown) => enc.encode(`data: ${JSON.stringify(f)}\n\n`);

/** A body that delivers these frames, then ends the way `end` says. */
function body(frames: unknown[], end: 'close' | 'drop' | 'hang'): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        for (const f of frames) controller.enqueue(line(f));
        return undefined;
      }
      if (end === 'hang') return new Promise<void>(() => {});
      // What iOS does to a backgrounded page's connection: the read throws.
      if (end === 'drop') controller.error(new TypeError('Load failed'));
      else controller.close();
      return undefined;
    },
  });
  return new Response(stream, { status: 200 });
}

type Step = Response | number | Error;

/** `fetch` that answers each open with the next scripted step. */
function script(steps: Step[]): { opens: () => number } {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      if (typeof step === 'number') return new Response(JSON.stringify({ error: 'x' }), { status: step });
      return step;
    }),
  );
  return { opens: () => i };
}

async function run(
  opts: { reconnectDelaysMs?: number[]; signal?: AbortSignal } = {},
): Promise<{ text: string; error: string | null; done: boolean }> {
  let text = '';
  let error: string | null = null;
  let done = false;
  await workspaceApi.streamReply('r1', {
    reconnectDelaysMs: opts.reconnectDelaysMs ?? [0, 0, 0],
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    onText: (t) => {
      text += t;
    },
    onDone: () => {
      done = true;
    },
    onError: (m) => {
      error = m;
    },
  });
  return { text, error, done };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('streamReply — same-reqId reconnect (TASK-27)', () => {
  it('picks the reply up where it dropped, rendering the replayed tail once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = script([
      body(
        [
          { reqId: 'r1', kind: 'text', text: 'Here is', seq: 1 },
          { reqId: 'r1', kind: 'text', text: ' your', seq: 2 },
        ],
        'drop',
      ),
      // The host replays its whole buffered tail on a reopen.
      body(
        [
          { reqId: 'r1', kind: 'text', text: 'Here is', seq: 1 },
          { reqId: 'r1', kind: 'text', text: ' your', seq: 2 },
          { reqId: 'r1', kind: 'text', text: ' calculator.', seq: 3 },
          { reqId: 'r1', done: true },
        ],
        'close',
      ),
    ]);

    const { text, error, done } = await run();

    expect(s.opens()).toBe(2);
    expect(text).toBe('Here is your calculator.');
    expect(error).toBeNull();
    expect(done).toBe(true);
  });

  it('a 404 on reopen means the turn finished while we were away: done, not an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The host clears the conversation's active reqId at turn end, so the
    // stream route stops recognising it. The answer is in the transcript, and
    // onDone is what makes the caller re-read it.
    script([body([{ reqId: 'r1', kind: 'text', text: 'Working', seq: 1 }], 'drop'), 404]);

    const { error, done } = await run();

    expect(error).toBeNull();
    expect(done).toBe(true);
  });

  it('keeps trying through failed reopens, then shows the banner once they are all spent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = script([
      body([{ reqId: 'r1', kind: 'text', text: 'Working', seq: 1 }], 'drop'),
      new TypeError('Load failed'),
    ]);

    const { error, done } = await run({ reconnectDelaysMs: [0, 0, 0] });

    expect(s.opens()).toBe(4); // the first open + three reconnects
    expect(error).toBe(WORKSPACE_STREAM_LOST);
    expect(done).toBe(false);
  });

  it('a host error mid-turn (5xx) is retried; it may be restarting under us', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    script([
      body([{ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }], 'drop'),
      503,
      body([{ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }, { reqId: 'r1', done: true }], 'close'),
    ]);

    const { text, error, done } = await run();

    expect(text).toBe('ab');
    expect(error).toBeNull();
    expect(done).toBe(true);
  });

  it('a reopen refused for a reason retrying cannot fix (401) is reported at once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = script([body([{ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }], 'drop'), 401]);

    const { error, done } = await run({ reconnectDelaysMs: [0, 0, 0] });

    expect(s.opens()).toBe(2);
    expect(error).not.toBeNull();
    expect(error).not.toBe(WORKSPACE_STREAM_LOST);
    expect(done).toBe(false);
  });

  it('a reconnect that brings new content resets the retry budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Three drops, each after progress, with a budget of ONE retry: a reader
    // that never reset would give up at the second drop.
    script([
      body([{ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }], 'drop'),
      body([{ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }], 'drop'),
      body([{ reqId: 'r1', kind: 'text', text: 'c', seq: 3 }], 'drop'),
      body([{ reqId: 'r1', kind: 'text', text: 'd', seq: 4 }, { reqId: 'r1', done: true }], 'close'),
    ]);

    const { text, error, done } = await run({ reconnectDelaysMs: [0] });

    expect(text).toBe('abcd');
    expect(error).toBeNull();
    expect(done).toBe(true);
  });

  it('a stream that closes without a terminator is reconnected too', async () => {
    script([
      body([{ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }], 'close'),
      body([{ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }, { reqId: 'r1', done: true }], 'close'),
    ]);

    const { text, done } = await run();

    expect(text).toBe('ab');
    expect(done).toBe(true);
  });

  it('a FIRST open that fails is still reported at once — there is no reply on screen to rescue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = script([new TypeError('Failed to fetch')]);

    const { error } = await run();

    expect(s.opens()).toBe(1);
    expect(error).toBe(WORKSPACE_STREAM_LOST);
  });

  it('waits for the page to be visible again before reconnecting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const s = script([
      body([{ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }], 'drop'),
      body([{ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }, { reqId: 'r1', done: true }], 'close'),
    ]);

    const pending = run();
    // Long enough for a reconnect to have gone out if it did not wait.
    await new Promise((r) => setTimeout(r, 30));
    expect(s.opens()).toBe(1);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    const { text, done } = await pending;

    expect(s.opens()).toBe(2);
    expect(text).toBe('ab');
    expect(done).toBe(true);
  });

  it('an abort while waiting to reconnect ends quietly, with no callback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ac = new AbortController();
    const s = script([body([{ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }], 'drop')]);

    const pending = run({ signal: ac.signal, reconnectDelaysMs: [60_000] });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const { error, done } = await pending;

    expect(s.opens()).toBe(1);
    expect(error).toBeNull();
    expect(done).toBe(false);
  });

  it('gives up only after about fifteen seconds of visible retrying by default', () => {
    // The budget is a product decision, so it is pinned: long enough to ride
    // out a phone waking its radio, short enough that a dead host is reported.
    const total = STREAM_RECONNECT_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(STREAM_RECONNECT_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    expect(total).toBeGreaterThanOrEqual(5_000);
    expect(total).toBeLessThanOrEqual(30_000);
  });
});
