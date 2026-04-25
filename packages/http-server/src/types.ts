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
 * Response adapter. Single-shot: any of `text`/`json`/`end`/`redirect`
 * finishes the response; a second call throws. `status` defaults to 200,
 * `header` names are lowercased, `redirect` defaults to 302.
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
  end(): void;
  redirect(url: string, status?: number): void;
  setSignedCookie(name: string, value: string, opts?: SignedCookieOptions): void;
  clearCookie(name: string, opts?: ClearCookieOptions): void;
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
