/**
 * Stop reading a remote response body once it passes a byte limit (TASK-944).
 *
 * Import it from `@ax/core/response-cap`. Like `@ax/core/surface-text`, this
 * file imports nothing, and every plugin already depends on `@ax/core`, so no
 * caller needs a cross-plugin import (invariant 2).
 *
 * Why: `@ax/mcp-oauth` (sign-in), `@ax/llm-openrouter` (completions) and the
 * AI-SDK runner (connector MCP answers) each read a remote server's body
 * whole. A hostile, compromised or broken server can send gigabytes, or a few
 * KB of gzip that inflates to gigabytes, and the host or runner pod (1 GiB by
 * default) has to hold all of it. Each caller wraps its responses with
 * `capResponseBody` and its own limit.
 *
 * What is counted: the bytes the body yields, after fetch has undone any
 * Content-Encoding. A small, absent or lying Content-Length cannot get a big
 * body past the count, and neither can gzip (MEASURED over real HTTP: a body
 * whose Content-Length said 16,329 bytes was 16 MiB once decoded). A declared
 * length over the limit is let go without reading a byte, but that only saves
 * the read; the count is the guard.
 *
 * When a body fails for its size: only on a read. A body whose Content-Length
 * is over the limit is cancelled at once, but its error waits for the first
 * read. A caller that checks only the status or the headers, then cancels or
 * drops the body, must not fail: the MCP SDK's OAuth discovery cancels a 4xx
 * from one well-known URL and tries the next, and mcp-oauth's resource probe
 * reads only the headers of the server's 401. An error thrown from fetch
 * would instead end the sign-in over an error page nobody reads.
 *
 * Over the limit the reader gets `ResponseTooLargeError`, a plain Error and
 * never a TypeError, which callers take for a network failure: fetch reports
 * one that way, and the MCP SDK's OAuth discovery takes a TypeError thrown by
 * fetch for a browser CORS failure and moves on to the next URL. The message
 * names only the limit: no URL, no header, no body bytes.
 *
 * What it is not:
 *   - A time limit. A server that sends slowly is the caller's timeout.
 *   - A bound on what a parser builds from the bytes it lets through. MEASURED
 *     with the runner's MCP SDK (zod 4.6.7): 400 KB of junk MCP content kept
 *     306 MB of zod issues, so a caller that validates with zod bounds that
 *     separately.
 *   - The same Response. The capped one is new: its `url` is empty,
 *     `redirected` is false and `type` is "default". The MCP SDK does read
 *     `type` and `url`, in `unfollowedRedirect`, to word the error for a
 *     redirect it did not follow, and that is harmless. Node's fetch never
 *     returns an `opaqueredirect`. mcp-oauth's `safeFetch` returns a 3xx only
 *     when it has no Location to follow, so there is no target to word. In
 *     the runner, an empty `url` makes the SDK resolve the Location against
 *     the URL it requested, so the only effect is on the error text for an
 *     unfollowed cross-origin redirect. Its status text is kept only when
 *     `new Response` accepts it (see REASON_PHRASE).
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/** `bytes` in the largest unit that divides it exactly: "8 MiB", "64 KiB", "1000 bytes". */
function describeSize(bytes: number): string {
  if (bytes > 0 && bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes > 0 && bytes % KIB === 0) return `${bytes / KIB} KiB`;
  return `${bytes} bytes`;
}

/**
 * A status text `new Response` accepts: the HTTP reason-phrase bytes (HTAB,
 * SP, VCHAR, obs-text). fetch can hand back others, because it decodes the
 * server's reason phrase as UTF-8: a Cyrillic or emoji phrase, or a lone
 * Latin-1 byte (decoded as U+FFFD), arrives as characters above U+00FF, and a
 * control character can arrive too. `new Response` throws a TypeError for all
 * of them (MEASURED on node 24.19.0, undici 7.29.0 and 6.29.1). Such a status
 * text is dropped, so an answer under the limit does not fail with a TypeError
 * that the MCP SDK would take for a CORS failure. Nothing that reads a capped
 * response uses the status text for more than an error message.
 */
const REASON_PHRASE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** A response body passed its byte limit, so reading stopped. */
export class ResponseTooLargeError extends Error {
  /** The limit, in bytes. */
  readonly limit: number;

  constructor(limit: number) {
    super(`the response was larger than ${describeSize(limit)}, so we stopped reading it`);
    this.name = 'ResponseTooLargeError';
    this.limit = limit;
  }
}

export interface CapResponseBodyOptions {
  /**
   * Called once, synchronously, when a read finds the body over the limit,
   * before the error reaches the reader. For a declared Content-Length over
   * the limit that is the first read, so a body nobody reads is never
   * reported. A throw from it is swallowed.
   */
  onOversize?: (err: ResponseTooLargeError) => void;
}

/** Tell the observer, if any. A broken observer must not hide the cap. */
function report(onOversize: CapResponseBodyOptions['onOversize'], err: ResponseTooLargeError): void {
  if (onOversize === undefined) return;
  try {
    onOversize(err);
  } catch {
    // Swallowed on purpose: the reader still gets `err`.
  }
}

/**
 * Return `res` with its body cut off at `limit` bytes.
 *
 * Reading past the limit rejects with `ResponseTooLargeError` and cancels the
 * source. A declared Content-Length over the limit cancels the source at once,
 * before a byte is read, and the first read rejects. That error is lazy on
 * purpose: a caller that only checks the status or headers, then cancels or
 * drops the body, does not fail (see "When a body fails for its size" above).
 * A response with no body comes back as it is, whatever its Content-Length
 * says.
 *
 * Given a response from fetch, it throws in two cases, each a RangeError and
 * never a TypeError. `limit` must be a non-negative safe integer: anything
 * else (NaN, a fraction, Infinity) would quietly disable the comparison. And a
 * status that `new Response` refuses fails here, with the source cancelled,
 * rather than come back uncapped. (`new Response` also refuses a body with a
 * 204, 205 or 304, with a TypeError, but fetch hands back no body for those,
 * or for a HEAD request, even when the server sends one: MEASURED on node
 * 24.19.0's fetch and undici 6.29.1.)
 */
export function capResponseBody(
  res: Response,
  limit: number,
  opts: CapResponseBodyOptions = {},
): Response {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(
      `capResponseBody: the limit must be a non-negative safe integer, not ${String(limit)}`,
    );
  }
  // Before Content-Length: an answer with no body (to a HEAD request, say)
  // can declare any length, and there is nothing to read.
  if (res.body === null) return res;
  const source = res.body;

  // fetch passes a status of 600-999 through with its body, and `new
  // Response` refuses anything outside 200-599 with a RangeError. Such an
  // answer fails here, before its body is touched, and the body is let go so
  // it does not hold the connection open. It never comes back uncapped.
  if (res.status < 200 || res.status > 599) {
    const err = new RangeError(
      `capResponseBody: a Response cannot carry a status of ${String(res.status)}`,
    );
    void source.cancel(err).catch(() => {});
    throw err;
  }
  const init = {
    status: res.status,
    statusText: REASON_PHRASE.test(res.statusText) ? res.statusText : '',
    headers: res.headers,
  };
  const { onOversize } = opts;

  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    // Over the limit by its own account, so it will never be read: let it go
    // now. The error waits for a read, and is reported then.
    const err = new ResponseTooLargeError(limit);
    void source.cancel(err).catch(() => {});
    const refused = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          report(onOversize, err);
          controller.error(err);
        },
      },
      // No pull until a read asks for one.
      { highWaterMark: 0 },
    );
    return new Response(refused, init);
  }

  let seen = 0;
  const counted = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          // Never enqueue the chunk that crossed the limit.
          const err = new ResponseTooLargeError(limit);
          report(onOversize, err);
          controller.error(err);
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, init);
}
