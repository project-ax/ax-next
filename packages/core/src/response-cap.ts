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
 * length over the limit is refused before reading, but that only saves the
 * read; the count is the guard.
 *
 * Over the limit the reader gets `ResponseTooLargeError`, a plain Error and
 * never a TypeError: the MCP SDK's OAuth discovery takes a TypeError from
 * fetch for a browser CORS failure and moves on to the next URL. The message
 * names only the limit: no URL, no header, no body bytes.
 *
 * What it is not:
 *   - A time limit. A server that sends slowly is the caller's timeout.
 *   - A bound on what a parser builds from the bytes it lets through. MEASURED
 *     with the runner's MCP SDK (zod 4.6.7): 400 KB of junk MCP content kept
 *     306 MB of zod issues, so a caller that validates with zod bounds that
 *     separately.
 *   - The same Response. The capped one is new, so it has no `url`,
 *     `redirected` or `type`; no caller reads them. Its status text is kept
 *     only when `new Response` accepts it (see REASON_PHRASE).
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
   * Called once, synchronously, when the limit is passed, before the error
   * reaches the body's reader. A throw from it is swallowed.
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
 * Return `res` with its body cut off at `limit` bytes. Reading past the limit
 * rejects with `ResponseTooLargeError` and cancels the source. A declared
 * Content-Length over the limit throws here, before anything is read. A
 * response with no body comes back as it is.
 *
 * `limit` must be a non-negative safe integer. Anything else (NaN, a fraction,
 * Infinity) would quietly disable the comparison, so it throws a RangeError.
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
  const { onOversize } = opts;

  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    const err = new ResponseTooLargeError(limit);
    report(onOversize, err);
    void res.body?.cancel(err).catch(() => {});
    throw err;
  }

  if (res.body === null) return res;

  let seen = 0;
  const counted = res.body.pipeThrough(
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
  // fetch passes a status of 600-999 through, and `new Response` refuses it
  // with a RangeError. That answer fails; it is never returned uncapped.
  return new Response(counted, {
    status: res.status,
    statusText: REASON_PHRASE.test(res.statusText) ? res.statusText : '',
    headers: res.headers,
  });
}
