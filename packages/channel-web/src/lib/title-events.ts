/**
 * Client consumer for GET /api/chat/title-events. One long-lived SSE
 * connection (fetch + ReadableStream, NOT EventSource — EventSource can't
 * send credentials cleanly) surfaces title changes for any of the user's
 * conversations. Reconnects with capped backoff; resync is the caller's job
 * via onOpen. Mirrors the SSE line-parsing in transport.ts.
 */
export interface TitleEventFrame {
  conversationId: string;
  title: string;
}

export interface SubscribeTitleEventsOptions {
  onTitle: (frame: TitleEventFrame) => void;
  /** Fired each time the stream (re)opens — caller resyncs (e.g. list()). */
  onOpen?: () => void;
  api?: string;
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function subscribeTitleEvents(
  opts: SubscribeTitleEventsOptions,
): () => void {
  const api = opts.api ?? '/api/chat/title-events';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;

  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const resp = await fetchImpl(api, {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          credentials: 'include',
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`title-events open failed: ${resp.status}`);
        }
        attempt = 0; // reset backoff once we're connected
        opts.onOpen?.();
        await consume(resp.body, opts.onTitle);
      } catch {
        // transient — fall through to backoff + reconnect
      }
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  };

  void run();

  return () => {
    stopped = true;
    controller?.abort();
  };
}

async function consume(
  body: ReadableStream<Uint8Array>,
  onTitle: (frame: TitleEventFrame) => void,
): Promise<void> {
  const reader = body
    .pipeThrough(
      new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>,
    )
    .getReader();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const data = carry + value;
    const lines = data.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data: ')) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(trimmed.slice(6));
      } catch {
        continue;
      }
      if (
        typeof frame === 'object' &&
        frame !== null &&
        typeof (frame as TitleEventFrame).conversationId === 'string' &&
        typeof (frame as TitleEventFrame).title === 'string'
      ) {
        onTitle({
          conversationId: (frame as TitleEventFrame).conversationId,
          title: (frame as TitleEventFrame).title,
        });
      }
    }
  }
}
