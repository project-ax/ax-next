export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Request adapter. `headers` keys are lowercased. `body` is capped at
 * MAX_BODY_BYTES (1 MiB) — over that, the plugin returns 413 before the
 * handler runs. `cookies` are raw values; signing lands in Task 2.
 */
export interface HttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
}

/**
 * Response adapter. Single-shot: any of `text`/`json`/`end`/`redirect`
 * finishes the response; a second call throws. `status` defaults to 200,
 * `header` names are lowercased, `redirect` defaults to 302.
 */
export interface HttpResponse {
  status(n: number): HttpResponse;
  header(name: string, value: string): HttpResponse;
  text(s: string): void;
  json(v: unknown): void;
  end(): void;
  redirect(url: string, status?: number): void;
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
