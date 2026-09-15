/**
 * `streamReply` and the TASK-23 sequence cursor — behaviour this surface did
 * not have until TASK-349.
 *
 * Chat has deduped replayed frames and refused to render past a contiguity gap
 * since TASK-23. The workspace never did, because it read the same wire through
 * its own parser, written when chat's was module-private and inseparable from
 * assistant-ui chunk emission. Putting both readers on `lib/sse-frames` closed
 * that: the parsing is shared, the rendering is not.
 *
 * What each test would do against the OLD reader is stated where it is not
 * obvious, because a test that passes either way would be pinning nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi, WORKSPACE_STREAM_LOST } from '../workspace-api';

/**
 * One SSE response carrying exactly these frames. `openEnded` leaves the body
 * open after the last frame — the state a real stream is in when the client
 * detects a gap and hangs up on it.
 */
function sseResponse(frames: unknown[], { openEnded = false } = {}): Response {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        for (const f of frames) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        }
        return undefined;
      }
      if (openEnded) return new Promise<void>(() => {});
      controller.close();
      return undefined;
    },
  });
  return new Response(body, { status: 200 });
}

/** Drive `streamReply` over those frames and collect everything it reports. */
async function run(
  frames: unknown[],
  opts: { openEnded?: boolean } = {},
): Promise<{ text: string[]; error: string | null; done: boolean }> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => sseResponse(frames, opts)),
  );
  const text: string[] = [];
  let error: string | null = null;
  let done = false;
  await workspaceApi.streamReply('r1', {
    onText: (t) => {
      text.push(t);
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

describe('streamReply — seq dedup', () => {
  it('drops a replayed duplicate instead of rendering it twice', async () => {
    // Against the old reader this was `['one', ' two', ' two', ' three']` —
    // the bounded per-reqId buffer replays its tail on a reconnect, and this
    // surface had no way to tell a replay from new content.
    const { text, done } = await run([
      { reqId: 'r1', kind: 'text', text: 'one', seq: 1 },
      { reqId: 'r1', kind: 'text', text: ' two', seq: 2 },
      { reqId: 'r1', kind: 'text', text: ' two', seq: 2 },
      { reqId: 'r1', kind: 'text', text: ' three', seq: 3 },
      { reqId: 'r1', done: true },
    ]);

    expect(text.join('')).toBe('one two three');
    expect(done).toBe(true);
  });

  it('still streams a server build that stamps no seq at all', async () => {
    // Forward-compat: no cursor to advance, so nothing is ever deduped.
    const { text, done } = await run([
      { reqId: 'r1', kind: 'text', text: 'a' },
      { reqId: 'r1', kind: 'text', text: 'b' },
      { reqId: 'r1', kind: 'text', text: 'c' },
      { reqId: 'r1', done: true },
    ]);

    expect(text).toEqual(['a', 'b', 'c']);
    expect(done).toBe(true);
  });
});

describe('streamReply — a gap is a visible loss, not a short answer', () => {
  it('stops at a mid-stream hole rather than rendering past it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // seq 3 never arrives. The OLD reader rendered 'after-the-hole' straight
    // into the thread, so the person read a reply with a piece missing and no
    // indication anything was gone — that missing-text assertion is the one
    // that fails against it.
    const { text, error, done } = await run(
      [
        { reqId: 'r1', kind: 'text', text: 'before', seq: 1 },
        { reqId: 'r1', kind: 'text', text: '-the-hole', seq: 2 },
        { reqId: 'r1', kind: 'text', text: 'after-the-hole', seq: 4 },
      ],
      { openEnded: true },
    );

    expect(text.join('')).toBe('before-the-hole');
    expect(text.join('')).not.toContain('after-the-hole');
    expect(error).toBe(WORKSPACE_STREAM_LOST);
    expect(done).toBe(false);
    warn.mockRestore();
  });

  it('refuses a truncated head — a first content frame above seq 1', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The host mints from 1, so a stream opening at seq 7 is proof the buffer
    // dropped 1..6 before this client connected. The old reader rendered the
    // tail as though it were the whole reply.
    const { text, error } = await run(
      [{ reqId: 'r1', kind: 'text', text: 'the tail of an answer', seq: 7 }],
      { openEnded: true },
    );

    expect(text).toEqual([]);
    expect(error).toBe(WORKSPACE_STREAM_LOST);
    warn.mockRestore();
  });

  it('says in the console which kind of loss it was, without putting it on screen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { error } = await run(
      [{ reqId: 'r1', kind: 'text', text: 'tail', seq: 7 }],
      { openEnded: true },
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated-head'));
    // The diagnosis is for us. The reader gets the authored sentence.
    expect(error).toBe(WORKSPACE_STREAM_LOST);
    expect(error).not.toContain('truncated-head');
    warn.mockRestore();
  });
});

describe('streamReply — the cursor governs content frames only', () => {
  it('lets a decision card through between two content frames', async () => {
    // A `decisionRaised` frame carries no top-level `kind`, so it is never a
    // dedup candidate. If it were, a card raised during a replayed tail would
    // be swallowed and the turn would park with nothing to answer.
    const raised: { decisionId: string; summary: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          { reqId: 'r1', kind: 'text', text: 'working', seq: 1 },
          { reqId: 'r1', decisionRaised: { decisionId: 'd1', summary: 'Send it?' } },
          { reqId: 'r1', kind: 'text', text: ' on it', seq: 2 },
          { reqId: 'r1', done: true },
        ]),
      ),
    );
    const text: string[] = [];
    await workspaceApi.streamReply('r1', {
      onText: (t) => {
        text.push(t);
      },
      onDone: () => undefined,
      onError: () => undefined,
      onDecisionRaised: (d) => {
        raised.push(d);
      },
    });

    expect(raised).toEqual([{ decisionId: 'd1', summary: 'Send it?' }]);
    expect(text.join('')).toBe('working on it');
  });
});
