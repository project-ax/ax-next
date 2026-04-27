import type { SignedCookieOptions } from './cookies.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Request adapter. `headers` keys are lowercased. `body` is capped at
 * MAX_BODY_BYTES (1 MiB) — over that, the plugin returns 413 before the
 * handler runs.
 *
 * `cookies` are RAW values straight from the Cookie header. For
 * tamper-evident reads use `signedCookie(name)`, which returns the
 * verified plaintext or `null` if the cookie is missing / mangled / forged.
 */
export interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  /**
   * Parsed query parameters, lowercased keys, repeated keys collapsed to
   * the LAST value. Empty object when the URL has no `?...`. Provided so
   * route handlers (e.g. /auth/callback?code=...&state=...) don't have to
   * re-parse from the original URL — the http-server already did so to
   * route the request.
   */
  readonly query: Record<string, string>;
  /**
   * Path parameters captured by `:name` segments in the registered route
   * pattern. Always present; empty object for exact-match routes. Values
   * are URI-decoded before being handed to the handler.
   */
  readonly params: Record<string, string>;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  /**
   * Returns the verified plaintext for an HMAC-signed cookie, or null
   * when the cookie is absent, malformed, or the HMAC check fails.
   * Comparison is constant-time. Never throws.
   */
  signedCookie(name: string): string | null;
}

export type ClearCookieOptions = Pick<
  SignedCookieOptions,
  'path' | 'domain' | 'sameSite' | 'secure'
>;

/**
 * Response adapter. Single-shot: any of `text`/`json`/`end`/`redirect`/
 * `stream` finishes the response; a second call throws. `status` defaults
 * to 200, `header` names are lowercased, `redirect` defaults to 302.
 *
 * `setSignedCookie` / `clearCookie` append a Set-Cookie header with the
 * locked defaults (HttpOnly, SameSite=Lax, Path=/). Secure is derived
 * from the request protocol unless explicitly overridden via opts.secure.
 */
export interface HttpResponse {
  status(n: number): HttpResponse;
  header(name: string, value: string): HttpResponse;
  text(s: string): void;
  json(v: unknown): void;
  /**
   * Send raw bytes (file contents, binary blobs). `contentType` is
   * applied to the Content-Type header ONLY when no prior
   * `header('content-type', …)` call has already set it — an explicit
   * earlier `header()` always wins. Single-shot like the rest.
   */
  body(buf: Buffer, contentType?: string): void;
  end(): void;
  redirect(url: string, status?: number): void;
  setSignedCookie(name: string, value: string, opts?: SignedCookieOptions): void;
  clearCookie(name: string, opts?: ClearCookieOptions): void;
  /**
   * Open a streaming response (SSE, NDJSON, long-poll keepalive). Flushes
   * the current status + headers immediately and returns a writer for
   * subsequent chunks. Like the other terminators, `stream()` finishes
   * the adapter (later `text`/`json`/`end` throws). Callers MUST call
   * `close()` on the returned writer when they're done so the connection
   * can drain cleanly; if the client disconnects first, `onClose` fires
   * and any subsequent `write()` becomes a no-op.
   *
   * Default Content-Type when none was set via `header()` is
   * `text/event-stream; charset=utf-8`.
   */
  stream(opts?: StreamingResponseOptions): StreamingResponse;
}

/**
 * Options for `HttpResponse.stream()`. `contentType` overrides the
 * default `text/event-stream; charset=utf-8` (an explicit prior
 * `header('content-type', …)` call still wins). `noBuffer` is hardcoded
 * to true so SSE chunks land on the wire immediately.
 */
export interface StreamingResponseOptions {
  contentType?: string;
}

/**
 * Writer surface for a streaming response. `write` accepts UTF-8 strings
 * (SSE frames, NDJSON lines) or raw `Buffer` chunks. `close` ends the
 * response cleanly; `onClose` fires once when the client disconnects OR
 * the server calls `close` — whichever happens first. The handler
 * registers cleanup (unsubscribe from buses, clear keepalive timers) in
 * `onClose`.
 *
 * After `close()` returns or `onClose` fires, `write()` and `close()`
 * are no-ops — the stream is single-shot terminal, mirroring the rest
 * of HttpResponse.
 */
export interface StreamingResponse {
  /** Write a chunk. UTF-8 strings are encoded; Buffers are written as-is. */
  write(chunk: string | Buffer): void;
  /** Finish the response and flush any remaining bytes. Idempotent. */
  close(): void;
  /**
   * Subscribe to the close event. Fires exactly once. Multiple subscribers
   * are supported; each receives the callback in registration order.
   * Subscribers added AFTER close has already fired run synchronously on
   * the next microtask.
   */
  onClose(handler: () => void): void;
}

export type HttpRouteHandler = (
  req: HttpRequest,
  res: HttpResponse,
) => Promise<void>;

export interface HttpRegisterRouteInput {
  method: HttpMethod;
  path: string;
  handler: HttpRouteHandler;
}

export interface HttpRegisterRouteOutput {
  /** Idempotent; second call no-ops. */
  unregister(): void;
}

/**
 * Subscriber payload for `http:request`, fired before handler dispatch.
 *
 * Veto-only contract: subscribers may call `reject({ reason })` to
 * short-circuit the request with a 4xx (`csrf*` reasons map to 403, all
 * others to 400). Payload mutation is NOT honored — the original request
 * fields drive routing. Use this hook for veto (CSRF, rate-limit, auth)
 * only, not for header/path rewrites.
 */
export interface HttpRequestEvent {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
}

/**
 * Subscriber payload for `http:response-sent`, fired after the handler
 * completes (success OR error). Observation-only.
 */
export interface HttpResponseSentEvent {
  status: number;
  durationMs: number;
}

/** Hard cap on request body size. Matches @ax/cli's `serve` body cap. */
export const MAX_BODY_BYTES = 1 * 1024 * 1024;
