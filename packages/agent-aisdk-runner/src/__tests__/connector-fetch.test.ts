import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponseTooLargeError } from '@ax/core/response-cap';
import {
  capConnectorFetch,
  MAX_CONNECTOR_RESPONSE_BYTES,
  MAX_TOOL_RESULT_BYTES,
  withResponseScope,
} from '../tools/connector-fetch.js';

// Every size below is a literal, never one of the constants under test: during
// a red run an export is still `undefined`, and a body sized from it would
// never end.

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

const URL_ = 'https://connector.example/mcp';

/** A base fetch that answers once with a `counted(total, chunk)` body and these headers. */
function fakeBase(total: number, chunk: number, headers: Record<string, string> = {}) {
  const { stream, stats } = counted(total, chunk);
  const base = vi.fn(async (_input: unknown, _init?: unknown) => new Response(stream, { headers }));
  return { base: base as unknown as typeof fetch, stats };
}

/** The error a read rejected with. */
async function readError(res: Response): Promise<unknown> {
  return res.text().then(
    () => {
      throw new Error('expected the read to fail');
    },
    (e: unknown) => e,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capConnectorFetch (TASK-944)', () => {
  it('the caps are 8 MiB for tools/call and 2 MiB otherwise', () => {
    expect(MAX_TOOL_RESULT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CONNECTOR_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  });

  it('outside any scope an answer is cut at 2 MiB', async () => {
    const { base, stats } = fakeBase(8 * 1024 * 1024, 64 * 1024);
    const res = await capConnectorFetch(base)(URL_);
    await expect(res.text()).rejects.toMatchObject({
      name: 'ResponseTooLargeError',
      limit: 2 * 1024 * 1024,
    });
    expect(stats.pulled).toBeLessThanOrEqual(34);
    await new Promise((r) => setTimeout(r, 0));
    expect(stats.cancelled).toBe(true);
  });

  it("inside a scope, the scope's cap applies and onOversize gets the reader's error", async () => {
    const { base } = fakeBase(64 * 1024, 4 * 1024);
    const spy = vi.fn();
    const capped = capConnectorFetch(base);
    const res = await withResponseScope({ maxBytes: 1024, onOversize: spy }, () => capped(URL_));
    // Read OUTSIDE the scope: the report goes to the scope that was active
    // when fetch was called, not to whoever reads the body.
    const err = await readError(res);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(err).toMatchObject({ name: 'ResponseTooLargeError', limit: 1024 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(err);
  });

  it('the innermost scope wins', async () => {
    const { base } = fakeBase(64 * 1024, 4 * 1024);
    const outer = vi.fn();
    const inner = vi.fn();
    const capped = capConnectorFetch(base);
    const res = await withResponseScope({ maxBytes: 1024 * 1024, onOversize: outer }, () =>
      withResponseScope({ maxBytes: 1024, onOversize: inner }, () => capped(URL_)),
    );
    const err = await readError(res);
    expect(err).toMatchObject({ name: 'ResponseTooLargeError', limit: 1024 });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('a declared Content-Length over the cap is reported once, fails the read, and is never pulled', async () => {
    const { base, stats } = fakeBase(64 * 1024, 4 * 1024, { 'content-length': String(1025) });
    const spy = vi.fn();
    const capped = capConnectorFetch(base);
    // Whether the fetch itself rejects or the first read does is the core
    // helper's choice; either way the answer fails and nothing is pulled.
    const read = withResponseScope({ maxBytes: 1024, onOversize: spy }, () => capped(URL_)).then((r) =>
      r.text(),
    );
    await expect(read).rejects.toMatchObject({ name: 'ResponseTooLargeError', limit: 1024 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: 'ResponseTooLargeError', limit: 1024 });
    expect(stats.pulled).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(stats.cancelled).toBe(true);
  });

  it('an undefined base means the global fetch, looked up per request', async () => {
    const capped = capConnectorFetch(undefined);
    const stub = vi.fn(async (_input: unknown, _init?: unknown) => new Response('ok'));
    vi.stubGlobal('fetch', stub);
    const init = { method: 'POST', body: '{}' };
    const res = await capped(URL_, init);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith(URL_, init);
    await expect(res.text()).resolves.toBe('ok');
  });
});
