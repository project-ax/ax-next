/**
 * `streamReply`'s SSE `error` frame — the reason code must not reach a reader.
 *
 * `frame.error` is a STABLE REASON CODE (`dev-service-failed`,
 * `chat-run-timeout`), and this reader used to hand it to its caller verbatim,
 * which put an internal identifier on the one surface TASK-296 was clearing of
 * exactly that. `lib/transport.ts` has mapped these codes to authored labels
 * since Fault A; the fix was to read that table rather than grow a second one.
 *
 * The optional `detail` line rides along and is KEPT. Per `server/types.ts` it
 * is bounded and sanitized server-side and is meant to be rendered — it is the
 * only actionable specifics a reader gets, so dropping it costs them the line
 * that says what to do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi } from '../workspace-api';
import { DEFAULT_TURN_ERROR, ERROR_LABELS, MAX_DETAIL_CHARS } from '../transport';

/** One SSE response carrying exactly the frames given. */
function sseResponse(frames: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** Drive `streamReply` over those frames and collect what it reports. */
async function errorFrom(frames: unknown[]): Promise<string | null> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => sseResponse(frames)),
  );
  let reported: string | null = null;
  await workspaceApi.streamReply('r1', {
    onText: () => undefined,
    onDone: () => undefined,
    onError: (m) => {
      reported = m;
    },
  });
  return reported;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamReply — the SSE error frame', () => {
  /*
    THE LEAK THIS CLOSES. The old reader emitted `dev-service-failed` (plus the
    detail) as the message, and `AgentView` rendered it. A reason code is an
    internal identifier: a reader cannot act on it, and it is the same class of
    string as the request paths and status codes the rest of TASK-296 removed.
  */
  it('maps the reason code to its authored label instead of printing it', async () => {
    const reported = await errorFrom([
      { error: 'dev-service-failed', detail: 'api could not write /srv/data' },
    ]);

    expect(reported).toContain(ERROR_LABELS['dev-service-failed']);
    // The code itself is gone.
    expect(reported).not.toContain('dev-service-failed');
  });

  /*
    TASK-160's channel, kept. The label says a dev service failed; only the
    detail says WHICH and WHERE, so this is the half a reader can act on.
  */
  it('keeps the author-facing detail line beneath the label', async () => {
    const reported = await errorFrom([
      { error: 'dev-service-failed', detail: 'api could not write /srv/data' },
    ]);

    expect(reported).toBe(
      `${ERROR_LABELS['dev-service-failed']}\napi could not write /srv/data`,
    );
  });

  /*
    An unknown code must not fall through to itself. This is the arm that makes
    "a reason code can never reach a reader" true rather than true-for-now: a
    reason added server-side without a label here degrades to authored copy.
  */
  it('falls back to authored copy for a code it has no label for', async () => {
    const reported = await errorFrom([{ error: 'some-new-reason-we-added' }]);

    expect(reported).toBe(DEFAULT_TURN_ERROR);
    expect(reported).not.toContain('some-new-reason');
  });

  /* Defense in depth over a field the host already bounds. */
  it('clamps an over-long detail line', async () => {
    const reported = await errorFrom([
      { error: 'chat-run-timeout', detail: 'x'.repeat(MAX_DETAIL_CHARS + 250) },
    ]);

    expect(reported).not.toBeNull();
    const detail = (reported as unknown as string).split('\n')[1] ?? '';
    expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
  });

  /* No detail, no empty second line dangling under the label. */
  it('omits the detail line entirely when the frame carries none', async () => {
    const reported = await errorFrom([{ error: 'chat-run-timeout' }]);

    expect(reported).toBe(ERROR_LABELS['chat-run-timeout']);
    expect(reported).not.toContain('\n');
  });
});
