/**
 * The cause behind CONNECTION_LOST reaches the console (TASK-349 follow-up).
 *
 * Before the parser extraction, chat's reader ended a broken body with a bare
 * `catch { return 'lost'; }` — it never bound the error, so a TCP reset, a
 * decode failure and a renderer that threw were the same single line on screen
 * and NOTHING in the console. `readSseFrames` returns the cause now, and this
 * pins that chat actually logs it.
 *
 * The other half is the one that makes the log worth having: an ABORT must stay
 * silent. The user pressed Stop, or the component unmounted; warning about it
 * would train everyone to ignore the warning.
 *
 * These live in their own file so the chat regression net
 * (`transport.test.ts`, unedited through the extraction) stays exactly what it
 * was — this is new behaviour, not a re-litigation of old behaviour.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AxChatTransport, CONNECTION_LOST } from '../lib/transport';

type StreamFn = (s: ReadableStream<Uint8Array>) => ReadableStream<unknown>;
const asProcess = (t: AxChatTransport): StreamFn =>
  (t as unknown as { processResponseStream: StreamFn }).processResponseStream.bind(t);

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader();
  const out: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

/** One text frame, then the body errors with `failure` on the next pull. */
function bodyThatErrorsWith(failure: unknown): ReadableStream<Uint8Array> {
  let step = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (step === 0) {
        step = 1;
        controller.enqueue(
          new TextEncoder().encode(`data: {"reqId":"r1","kind":"text","text":"partial"}\n\n`),
        );
        return;
      }
      controller.error(failure);
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a body error names its cause', () => {
  test('a network failure is logged, and the reader still gets CONNECTION_LOST', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = new TypeError('network error: connection reset');
    const transport = new AxChatTransport({ getAgentId: () => 'a' });

    const chunks = (await drain(asProcess(transport)(bodyThatErrorsWith(boom)))) as Array<{
      type: string;
      errorText?: string;
    }>;

    // The cause, for whoever is debugging.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ended badly'), boom);
    // The authored line, for whoever is reading. Unchanged.
    expect(chunks.find((c) => c.type === 'error')?.errorText).toBe(CONNECTION_LOST);
  });

  test('an abort is NOT logged — nothing went wrong', async () => {
    // This is the arm that makes the log usable. An abort rejects the read the
    // same way a real failure does, so without the guard every Stop press and
    // every unmount would warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = new AxChatTransport({ getAgentId: () => 'a' });

    await drain(
      asProcess(transport)(bodyThatErrorsWith(new DOMException('aborted', 'AbortError'))),
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
