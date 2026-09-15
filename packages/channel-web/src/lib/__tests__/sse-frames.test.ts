/**
 * Frame-level tests for the shared SSE reader (TASK-349).
 *
 * This module owns the wire and nothing else, so these tests never mention a
 * `UIMessageChunk`, a store, or a rendered label — they assert the frames that
 * come out and the reason the read ended. The two consumers
 * (`lib/transport.ts` for chat, `lib/workspace-api.ts` for the workspace) keep
 * their own tests for what they DO with a frame.
 */
import { describe, expect, test } from 'vitest';
import { readSseFrames, type SseReadEnd } from '../sse-frames';
import type { SseFrame } from '../../server/types';

/**
 * Build a body from a list of byte-chunks, so a test can put a split exactly
 * where it wants one. `cancel` is a spy: a locally-detected seq gap must
 * actually close the HTTP body, not just stop reading it.
 */
function bodyOf(
  chunks: string[],
  /**
   * `openEnded` models the case a gap actually happens in: the server is still
   * streaming when the client gives up. Without it the stream closes itself as
   * soon as the chunks run out, and a closed stream's `cancel` is never called
   * — so the cancellation assertion would pass or fail on a race.
   */
  { openEnded = false }: { openEnded?: boolean } = {},
): {
  body: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let offset = 0;
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= chunks.length) {
        if (!openEnded) {
          controller.close();
          return undefined;
        }
        // Stay open forever. Only a cancel ends this stream, which is the
        // point of the test using it.
        return new Promise<void>(() => {});
      }
      controller.enqueue(encoder.encode(chunks[offset]!));
      offset += 1;
      return undefined;
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { body, cancelled: () => wasCancelled };
}

/** Read every frame to the end, collecting them. */
async function collect(
  chunks: string[],
): Promise<{ frames: SseFrame[]; end: SseReadEnd; cancelled: boolean }> {
  const { body, cancelled } = bodyOf(chunks);
  const frames: SseFrame[] = [];
  const end = await readSseFrames(body, (frame) => {
    frames.push(frame);
    return 'continue';
  });
  return { frames, end, cancelled: cancelled() };
}

/** One `data:` line, newline-terminated. */
function data(frame: unknown): string {
  return `data: ${JSON.stringify(frame)}\n`;
}

describe('readSseFrames — framing', () => {
  test('a frame split across two reads is stitched back together', async () => {
    const line = data({ reqId: 'r1', kind: 'text', text: 'hello world' });
    const cut = Math.floor(line.length / 2);
    const { frames, end } = await collect([line.slice(0, cut), line.slice(cut)]);

    expect(frames).toEqual([{ reqId: 'r1', kind: 'text', text: 'hello world' }]);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('a read boundary inside the `data: ` prefix itself still parses', async () => {
    // The nastiest split: the reader has "da" in hand and nothing else, so it
    // cannot even tell yet whether this is a data line or a comment.
    const line = data({ reqId: 'r1', kind: 'text', text: 'hi' });
    const { frames, end } = await collect([line.slice(0, 2), line.slice(2)]);

    expect(frames).toEqual([{ reqId: 'r1', kind: 'text', text: 'hi' }]);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('several frames arriving in one read are all surfaced, in order', async () => {
    const { frames } = await collect([
      data({ reqId: 'r1', kind: 'text', text: 'a' }) +
        data({ reqId: 'r1', kind: 'text', text: 'b' }) +
        data({ reqId: 'r1', kind: 'text', text: 'c' }),
    ]);

    expect(frames.map((f) => (f as { text: string }).text)).toEqual(['a', 'b', 'c']);
  });

  test('malformed JSON is skipped and the frames around it still arrive', async () => {
    const { frames, end } = await collect([
      data({ reqId: 'r1', kind: 'text', text: 'before' }) +
        'data: {not json\n' +
        data({ reqId: 'r1', kind: 'text', text: 'after' }),
    ]);

    expect(frames.map((f) => (f as { text: string }).text)).toEqual(['before', 'after']);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('a `:` keepalive comment is skipped', async () => {
    const { frames } = await collect([
      ':\n' + ': keepalive\n' + data({ reqId: 'r1', kind: 'text', text: 'x' }),
    ]);

    expect(frames).toEqual([{ reqId: 'r1', kind: 'text', text: 'x' }]);
  });

  test('blank lines and non-`data:` field lines are skipped', async () => {
    const { frames } = await collect([
      '\n' + 'event: message\n' + 'id: 7\n' + data({ reqId: 'r1', kind: 'text', text: 'x' }),
    ]);

    expect(frames).toEqual([{ reqId: 'r1', kind: 'text', text: 'x' }]);
  });

  test('a trailing line with no newline is never delivered', async () => {
    // Deliberate: an unterminated line may still be growing. The server always
    // terminates a frame it means to send, so a partial tail is a truncation,
    // and parsing it would surface half a frame as if it were whole.
    //
    // The tail here is DELIBERATELY complete, valid JSON — it is missing only
    // its newline. An earlier version of this test used a syntactically broken
    // tail, which meant an implementation that wrongly flushed the carry buffer
    // at close would have hit the malformed-JSON skip and passed anyway. The
    // only thing withholding this frame is the missing terminator.
    const line = data({ reqId: 'r1', kind: 'text', text: 'complete' });
    const partial = data({ reqId: 'r1', kind: 'text', text: 'unterminated' }).replace(/\n$/, '');
    const { frames, end } = await collect([line + partial]);

    expect(frames).toEqual([{ reqId: 'r1', kind: 'text', text: 'complete' }]);
    expect(end).toEqual({ reason: 'closed' });
  });
});

describe('readSseFrames — every frame kind reaches the caller intact', () => {
  test('text, thinking, tool-use, tool-result, phase, permissionRequest, decisionRaised, done', async () => {
    const wire: SseFrame[] = [
      { reqId: 'r1', kind: 'text', text: 'hello' },
      { reqId: 'r1', kind: 'thinking', text: 'pondering' },
      {
        reqId: 'r1',
        kind: 'tool-use',
        toolCallId: 'c1',
        toolName: 'mcp__ax-sandbox-tools__artifact_publish',
        input: { path: '/permanent/report.md' },
        activityPhrase: 'Publishing the report',
      },
      {
        reqId: 'r1',
        kind: 'tool-result',
        toolCallId: 'c1',
        output: 'ax://artifact/abc',
        held: true,
      },
      { reqId: 'r1', phase: 'sandbox-starting' },
      {
        reqId: 'r1',
        permissionRequest: { kind: 'host', host: 'example.org', sessionId: 's1' },
      },
      { reqId: 'r1', decisionRaised: { decisionId: 'd1', summary: 'Send the email' } },
      { reqId: 'r1', done: true },
    ];
    const { frames } = await collect([wire.map(data).join('')]);

    // Payloads are forwarded verbatim — the parser never renames, strips or
    // reshapes a field. `activityPhrase` and `held` in particular are the two
    // fields the chat renderer stashes out-of-band (TASK-271 / TASK-270); a
    // parser that dropped them would break the tool label and the held mark.
    expect(frames).toEqual(wire);
  });

  test('an error frame keeps its optional `detail` line', async () => {
    const { frames } = await collect([
      data({ reqId: 'r1', error: 'dev-service-failed', detail: 'postgres: EACCES /var/lib' }),
    ]);

    expect(frames).toEqual([
      { reqId: 'r1', error: 'dev-service-failed', detail: 'postgres: EACCES /var/lib' },
    ]);
  });
});

describe('readSseFrames — how a read ends', () => {
  test('a graceful close with no terminator is `closed` — the caller calls that lost', async () => {
    const { end } = await collect([data({ reqId: 'r1', kind: 'text', text: 'partial' })]);

    expect(end).toEqual({ reason: 'closed' });
  });

  test("a caller returning 'stop' ends the read and no later frame is delivered", async () => {
    const { body } = bodyOf([
      data({ reqId: 'r1', kind: 'text', text: 'a' }) +
        data({ reqId: 'r1', done: true }) +
        data({ reqId: 'r1', kind: 'text', text: 'past-the-terminator' }),
    ]);
    const seen: SseFrame[] = [];
    const end = await readSseFrames(body, (frame) => {
      seen.push(frame);
      return 'done' in frame ? 'stop' : 'continue';
    });

    expect(end).toEqual({ reason: 'stopped' });
    expect(seen).toEqual([
      { reqId: 'r1', kind: 'text', text: 'a' },
      { reqId: 'r1', done: true },
    ]);
  });

  test('a body that throws mid-read ends as `body-error`, carrying the error', async () => {
    const boom = new Error('network died');
    const encoder = new TextEncoder();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode(data({ reqId: 'r1', kind: 'text', text: 'a' })));
          return;
        }
        controller.error(boom);
      },
    });
    const frames: SseFrame[] = [];
    const end = await readSseFrames(body, (f) => {
      frames.push(f);
      return 'continue';
    });

    expect(frames).toHaveLength(1);
    expect(end).toEqual({ reason: 'body-error', error: boom });
  });

  test('a throw from the caller surfaces as `body-error` rather than escaping', async () => {
    // Matches the pre-extraction behaviour: `consumeSseAttempt` wrapped the
    // whole dispatch in its own try, so a renderer that threw was reported as
    // a lost stream. Preserved deliberately — a throwing consumer must not
    // leave the body's reader lock held.
    const boom = new Error('renderer exploded');
    const { body } = bodyOf([data({ reqId: 'r1', kind: 'text', text: 'a' })]);
    const end = await readSseFrames(body, () => {
      throw boom;
    });

    expect(end).toEqual({ reason: 'body-error', error: boom });
  });
});

describe('readSseFrames — seq dedup and gap detection (TASK-23)', () => {
  test('frames with no seq bypass the cursor entirely (older server build)', async () => {
    const { frames, end } = await collect([
      data({ reqId: 'r1', kind: 'text', text: 'a' }) +
        data({ reqId: 'r1', kind: 'text', text: 'b' }) +
        data({ reqId: 'r1', kind: 'text', text: 'c' }),
    ]);

    expect(frames).toHaveLength(3);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('a replayed duplicate seq is dropped and never reaches the caller', async () => {
    const { frames, end } = await collect([
      data({ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }) +
        data({ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }) +
        // The bounded per-reqId buffer replayed the tail it already sent.
        data({ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }) +
        data({ reqId: 'r1', kind: 'text', text: 'c', seq: 3 }),
    ]);

    expect(frames.map((f) => (f as { text: string }).text)).toEqual(['a', 'b', 'c']);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('a first content frame above seq 1 is a truncated head, and cancels the body', async () => {
    // Servers mint from 1, so a stream whose first seq-bearing frame is 4 is
    // proof the buffer dropped 1..3 before this client ever connected.
    const { body, cancelled } = bodyOf(
      [data({ reqId: 'r1', kind: 'text', text: 'tail-only', seq: 4 })],
      { openEnded: true },
    );
    const frames: SseFrame[] = [];
    const end = await readSseFrames(body, (f) => {
      frames.push(f);
      return 'continue';
    });

    expect(end).toEqual({ reason: 'gap', kind: 'truncated-head' });
    expect(frames).toEqual([]);
    // Not merely "stopped reading": the HTTP body is closed, so the server
    // stops writing into a connection nobody is listening to.
    expect(cancelled()).toBe(true);
  });

  test('a first content frame at exactly seq 1 is a clean start', async () => {
    const { frames, end } = await collect([
      data({ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }),
    ]);

    expect(frames).toHaveLength(1);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('a mid-stream hole in the sequence is a gap, and cancels the body', async () => {
    const { body, cancelled } = bodyOf(
      [
        data({ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }) +
          data({ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }) +
          // 3 never arrives — the buffer dropped it.
          data({ reqId: 'r1', kind: 'text', text: 'd', seq: 4 }),
      ],
      { openEnded: true },
    );
    const frames: SseFrame[] = [];
    const end = await readSseFrames(body, (f) => {
      frames.push(f);
      return 'continue';
    });

    expect(end).toEqual({ reason: 'gap', kind: 'mid-stream' });
    // The contiguous prefix was delivered; only the post-gap frame is withheld.
    expect(frames.map((f) => (f as { text: string }).text)).toEqual(['a', 'b']);
    expect(cancelled()).toBe(true);
  });

  test('the seq cursor only governs content frames — out-of-band frames always pass', async () => {
    // `phase`, `permissionRequest`, `decisionRaised`, `done` and `error` carry
    // no top-level `kind`, so they are never dedup candidates. This is what
    // lets an approval card arrive during a replayed tail.
    const { frames, end } = await collect([
      data({ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }) +
        data({ reqId: 'r1', phase: 'sandbox-starting' }) +
        data({
          reqId: 'r1',
          permissionRequest: { kind: 'host', host: 'example.org', sessionId: 's1' },
        }) +
        data({ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }),
    ]);

    expect(frames).toHaveLength(4);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('a `permissionRequest` whose inner kind collides with a content kind still passes', async () => {
    // The seq guard reads a TOP-LEVEL `kind`. A permission frame's `kind` is
    // nested one level down, and confusing the two would make an approval card
    // a dedup candidate — silently swallowing it on a replayed stream.
    const card = {
      reqId: 'r1',
      permissionRequest: {
        kind: 'skill' as const,
        skillId: 'linear',
        description: 'a skill card riding between two content frames',
        hosts: [],
        slots: [],
      },
    };
    const { frames, end } = await collect([
      data({ reqId: 'r1', kind: 'text', text: 'a', seq: 1 }) +
        data(card) +
        data({ reqId: 'r1', kind: 'text', text: 'b', seq: 2 }),
    ]);

    // If the nested `kind` were read as a content kind, the card would carry no
    // seq, sit at lastSeq 1, and the seq-2 frame after it would still pass —
    // so the tell is the card itself arriving, in position.
    expect(frames).toEqual([
      { reqId: 'r1', kind: 'text', text: 'a', seq: 1 },
      card,
      { reqId: 'r1', kind: 'text', text: 'b', seq: 2 },
    ]);
    expect(end).toEqual({ reason: 'closed' });
  });

  test('cancelling for a gap does not double-release the reader lock', async () => {
    // `reader.cancel()` releases the lock itself; a `finally` that also called
    // `releaseLock()` would throw out of the finally block, turning a clean
    // gap into a rejected promise. Returning the gap at all is the proof.
    const { body } = bodyOf([data({ reqId: 'r1', kind: 'text', text: 'a', seq: 9 })]);

    await expect(readSseFrames(body, () => 'continue')).resolves.toEqual({
      reason: 'gap',
      kind: 'truncated-head',
    });
  });
});
