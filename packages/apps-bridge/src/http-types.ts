/**
 * The slice of `@ax/http-server`'s request and response the settings routes
 * use, duck-typed so this package has no dependency on another plugin (I2),
 * the same posture as channel-slack's http-types.ts. The server hands every
 * handler its full objects; these name only what we read.
 */

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  /** The request-target path before percent-decoding, without the query. */
  readonly rawPath: string;
  /** `:name` captures, already URI-decoded. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Lowercased names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The raw bytes, already capped by the route's `maxBodyBytes`. */
  readonly body: Buffer;
}

/** Single-shot like the server's: `json`, `text`, `end` and `redirect` each finish it. */
export interface RouteResponse {
  status(code: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(body: unknown): void;
  text(body: string): void;
  end(): void;
  redirect(url: string, status?: number): void;
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

/** One route, as `http:register-route` takes it. */
export interface RouteSpec {
  method: 'GET' | 'POST';
  path: string;
  handler: RouteHandler;
  /** Never set by this package: every settings route keeps http-server's CSRF check. */
  bypassCsrf?: boolean;
  maxBodyBytes?: number;
}
