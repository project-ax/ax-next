import { describe, expect, it, vi } from 'vitest';
import { ResponseTooLargeError, capResponseBody } from '../response-cap.js';

// Sizes are literals, never read from the code under test.
const LIMIT = 64 * 1024;
const CHUNK = 4 * 1024;

/** `total` bytes in `chunk`-byte pieces; records how far a reader pulled. */
function counted(total: number, chunk: number) {
  // A NaN total (an import still undefined during a red run) would never end.
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(chunk) || chunk <= 0) {
    throw new Error(`counted: bad sizes ${String(total)}/${String(chunk)}`);
  }
  const stats = { pulled: 0, cancelled: false, reason: undefined as unknown };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.pulled * chunk >= total) return controller.close();
        stats.pulled += 1;
        controller.enqueue(new Uint8Array(chunk).fill(0x61));
      },
      cancel(reason) {
        stats.cancelled = true;
        stats.reason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}

/**
 * A cancel reaches the source through the pipe a few microtasks after the
 * reader's rejection or `cancel()`, so a check on the source waits a macrotask.
 */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('capResponseBody', () => {
  it('passes a body at the cap, or under it, through whole', async () => {
    const { stream, stats } = counted(LIMIT, CHUNK);
    const res = new Response(stream, { headers: { 'content-length': String(LIMIT) } });
    const atCap = await capResponseBody(res, LIMIT).arrayBuffer();
    expect(atCap.byteLength).toBe(LIMIT);
    await nextTask();
    expect(stats.cancelled).toBe(false);

    const under = await capResponseBody(new Response(new Uint8Array(LIMIT - 1)), LIMIT).arrayBuffer();
    expect(under.byteLength).toBe(LIMIT - 1);
  });

  it('errors the body as soon as it streams past the cap, and stops pulling', async () => {
    const { stream, stats } = counted(16 * LIMIT, CHUNK);
    const read = capResponseBody(new Response(stream), LIMIT).text();
    await expect(read).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(read).rejects.toMatchObject({ name: 'ResponseTooLargeError', limit: LIMIT });
    await nextTask();
    expect(stats.pulled).toBeLessThanOrEqual(LIMIT / CHUNK + 2);
    expect(stats.cancelled).toBe(true);
    expect(stats.reason).toBeInstanceOf(ResponseTooLargeError);

    // A reader is handed at most the limit: the chunk that crosses it is dropped.
    const again = counted(16 * LIMIT, CHUNK);
    const reader = capResponseBody(new Response(again.stream), LIMIT).body!.getReader();
    let delivered = 0;
    let failure: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        delivered += value.byteLength;
      }
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(ResponseTooLargeError);
    expect(delivered).toBeLessThanOrEqual(LIMIT);
  });

  it('counts what streams, not what Content-Length claims', async () => {
    const { stream } = counted(16 * LIMIT, CHUNK);
    const res = new Response(stream, { headers: { 'content-length': '10' } });
    await expect(capResponseBody(res, LIMIT).text()).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('refuses a declared Content-Length over the cap before reading a byte', async () => {
    const { stream, stats } = counted(16 * LIMIT, CHUNK);
    const res = new Response(stream, { headers: { 'content-length': String(LIMIT + 1) } });
    expect(() => capResponseBody(res, LIMIT)).toThrow(ResponseTooLargeError);
    await nextTask();
    expect(stats.pulled).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  it('tells onOversize once, before the reader sees the error, on both paths', async () => {
    const order: string[] = [];
    const streamed = vi.fn<(err: ResponseTooLargeError) => void>(() => {
      order.push('callback');
    });
    const { stream } = counted(16 * LIMIT, CHUNK);
    const rejection = await capResponseBody(new Response(stream), LIMIT, { onOversize: streamed })
      .text()
      .then(
        () => undefined,
        (err: unknown) => {
          order.push('reader');
          return err;
        },
      );
    expect(rejection).toBeInstanceOf(ResponseTooLargeError);
    expect(order).toEqual(['callback', 'reader']);
    expect(streamed).toHaveBeenCalledTimes(1);
    expect(streamed.mock.calls[0]?.[0]).toBe(rejection);

    const declared = vi.fn<(err: ResponseTooLargeError) => void>();
    const big = counted(16 * LIMIT, CHUNK);
    const res = new Response(big.stream, { headers: { 'content-length': String(LIMIT + 1) } });
    let thrown: unknown;
    try {
      capResponseBody(res, LIMIT, { onOversize: declared });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ResponseTooLargeError);
    expect(declared).toHaveBeenCalledTimes(1);
    expect(declared.mock.calls[0]?.[0]).toBe(thrown);
  });

  it('a throwing onOversize does not hide the cap', async () => {
    const onOversize = () => {
      throw new Error('observer broke');
    };
    const { stream } = counted(16 * LIMIT, CHUNK);
    await expect(
      capResponseBody(new Response(stream), LIMIT, { onOversize }).text(),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);

    const big = counted(16 * LIMIT, CHUNK);
    const res = new Response(big.stream, { headers: { 'content-length': String(LIMIT + 1) } });
    expect(() => capResponseBody(res, LIMIT, { onOversize })).toThrow(ResponseTooLargeError);
  });

  it('returns a bodiless response as it is', () => {
    const r = new Response(null, { status: 204 });
    expect(capResponseBody(r, LIMIT)).toBe(r);
  });

  it('keeps status, statusText and headers', async () => {
    const wrapped = capResponseBody(
      new Response('ok', { status: 418, statusText: 'Teapot', headers: { 'x-a': '1' } }),
      LIMIT,
    );
    expect(wrapped.status).toBe(418);
    expect(wrapped.statusText).toBe('Teapot');
    expect(wrapped.headers.get('x-a')).toBe('1');
    expect(await wrapped.text()).toBe('ok');
  });

  it("a reader's cancel reaches the source", async () => {
    const { stream, stats } = counted(16 * LIMIT, CHUNK);
    await capResponseBody(new Response(stream), LIMIT).body!.cancel();
    await nextTask();
    expect(stats.cancelled).toBe(true);
  });

  it('rejects a limit that would disable the cap', () => {
    for (const limit of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => capResponseBody(new Response('x'), limit)).toThrow(RangeError);
    }
  });

  // fetch decodes a server's reason phrase as UTF-8, so it can hand back a
  // status text that `new Response` refuses with a TypeError: characters above
  // U+00FF (a Cyrillic or emoji phrase, or U+FFFD for a lone Latin-1 byte) or a
  // control character. MEASURED on node 24.19.0 with its own fetch (undici
  // 7.29.0) and with the runner's undici 6.29.1. `new Response` cannot build
  // such a response, so each case gives a real one that status text.
  it('drops a status text that new Response would refuse, instead of throwing a TypeError', async () => {
    const refused = [
      'Успешно',
      'Caf�',
      'OK \u{1F600}',
      'OK\u0001',
    ];
    for (const statusText of refused) {
      expect(() => new Response('x', { statusText })).toThrow(TypeError);
      const res = new Response('ok', { status: 200 });
      Object.defineProperty(res, 'statusText', { value: statusText });
      const wrapped = capResponseBody(res, LIMIT);
      expect(wrapped.status).toBe(200);
      expect(wrapped.statusText).toBe('');
      expect(await wrapped.text()).toBe('ok');
    }

    // Latin-1 text is a valid reason phrase, so it is kept.
    const latin1 = new Response('ok', { statusText: 'Café' });
    expect(capResponseBody(latin1, LIMIT).statusText).toBe('Café');
  });

  // fetch passes a status of 600-999 through with its body (same MEASURED
  // versions), and `new Response` refuses it with a RangeError. Such an answer
  // must fail, never come back as the original, uncapped response.
  it('fails closed on a status new Response cannot carry', () => {
    const { stream } = counted(16 * LIMIT, CHUNK);
    const res = new Response(stream);
    Object.defineProperty(res, 'status', { value: 999 });
    expect(() => capResponseBody(res, LIMIT)).toThrow(RangeError);
  });
});

describe('ResponseTooLargeError', () => {
  it('ResponseTooLargeError is a plain named Error with a readable size', () => {
    const e = new ResponseTooLargeError(64 * 1024);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(TypeError);
    expect(e.name).toBe('ResponseTooLargeError');
    expect(e.limit).toBe(65536);
    expect(e.message).toBe('the response was larger than 64 KiB, so we stopped reading it');

    expect(new ResponseTooLargeError(2 * 1024 * 1024).message).toBe(
      'the response was larger than 2 MiB, so we stopped reading it',
    );
    expect(new ResponseTooLargeError(4 * 1024 * 1024).message).toBe(
      'the response was larger than 4 MiB, so we stopped reading it',
    );
    expect(new ResponseTooLargeError(8 * 1024 * 1024).message).toBe(
      'the response was larger than 8 MiB, so we stopped reading it',
    );
    expect(new ResponseTooLargeError(1000).message).toBe(
      'the response was larger than 1000 bytes, so we stopped reading it',
    );
  });
});
