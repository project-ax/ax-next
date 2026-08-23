/**
 * The SPA's shared request helper: one place that notices a 401, and one place
 * that decides what a failed request SAYS to a person.
 *
 * WHY THIS EXISTS AT ALL. Before this, exactly three error types in the whole
 * client carried an HTTP status (`WorkspaceApiError`, `AdminSettingHttpError`,
 * `BrandingHttpError`). Every other module flattened the status into a
 * prose-shaped `Error` the moment it left `fetch` — `chat-flow POST failed: 401
 * Unauthorized`, `list agents: 401`, `send message → 401` — so no caller could
 * branch on it even if it wanted to, and nine surfaces ended up printing those
 * strings at readers. Giving the fetch modules a status-carrying error type is
 * the whole point; the 401 interceptor is what that finally makes possible.
 *
 * THE ASYMMETRY WITH BOOT IS DELIBERATE — DO NOT "FIX" IT.
 * `App.tsx` routes ANY thrown boot failure to the signed-out screen, including
 * a plain network outage: being offline at first load lands on `<LoginPage />`.
 * That is not an oversight and it is pinned by `__tests__/auth-gate.test.tsx`.
 * Boot genuinely knows less than we do here — there is no established session
 * to lose, and "connecting…" forever is a worse answer than a sign-in button.
 * Post-boot we know more, so we are stricter: ONLY a 401 ends the session, and
 * a 500 or a dropped connection stays a per-surface failure the reader can
 * retry. The boot modules (`lib/auth.ts`, `lib/bootstrap-status.ts`,
 * `lib/features.ts`) deliberately do NOT route through this helper, so the two
 * rules cannot bleed into each other by accident.
 *
 * WHAT A 401 MEANS HERE. Every route this helper reaches is behind
 * `auth:require-user`, which answers 401 when — and only when — the caller has
 * no valid session. It is never a per-route authorization verdict (that is a
 * 403). So a 401 is direct evidence about the SESSION, which is what makes it
 * safe to act on globally.
 *
 * A NOTED CONSEQUENCE: the decisions undo poll re-reads a row once per second
 * while an undo window is open, so on an expired session a BACKGROUND TIMER —
 * not a click — is usually what flips the app to the signed-out screen. That is
 * the correct outcome (the session really is gone, and the reader finding out
 * within a second beats finding out on their next click), and
 * `sessionExpiredActions.expired()` is a latch so the repeat ticks cost
 * nothing. It is called out because it is surprising, not because it is wrong.
 */
import { sessionExpiredActions } from './session-expired-store';

/** The `fetch` shape callers may inject. Tests pass a stub; transport passes its own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/*
 * The four sentences a failed request is allowed to become.
 *
 * Every one of them is a whole sentence with no status code, no request path
 * and no `statusText` in it. `statusText` in particular is a trap: it is the
 * HTTP/1.1 reason-phrase, and HTTP/2 does not have one — so a message built
 * from it reads `… failed: 401 Unauthorized` on a dev box and `… failed: 401 `
 * on the cluster. Nothing a reader can act on either way.
 */
export const HTTP_SESSION_ENDED =
  'Your session has ended. Sign in again to pick up where you left off.';
export const HTTP_NO_ACCESS = 'This account does not have access to that.';
export const HTTP_NOT_FOUND = 'We could not find that. It may have been deleted.';
export const HTTP_UNAVAILABLE =
  'That part of the app is not running in this deployment.';
/**
 * A 5xx is the server telling us it broke. It is NOT the same event as not
 * reaching one, and conflating them sends someone to check their wifi over a
 * bug on our side.
 */
export const HTTP_SERVER_ERROR =
  'The server ran into a problem. Please try again.';
/** We never got an answer at all — offline, DNS, a connection that died. */
export const HTTP_FAILED = 'We could not reach the server just now.';

/**
 * Status → the sentence a reader gets.
 *
 * Everything reaching here came back from a real response, so the 5xx band
 * gets its own sentence. `HTTP_FAILED` stays the fallback for a status we have
 * no words for, and is what `userFacingMessage` uses when there was no
 * response to read a status from.
 */
export function httpErrorMessage(status: number): string {
  if (status === 401) return HTTP_SESSION_ENDED;
  if (status === 403) return HTTP_NO_ACCESS;
  if (status === 404) return HTTP_NOT_FOUND;
  if (status === 503) return HTTP_UNAVAILABLE;
  if (status >= 500) return HTTP_SERVER_ERROR;
  return HTTP_FAILED;
}

/**
 * A request that came back with a status we could not use.
 *
 * `message` is authored copy and is safe to render anywhere. The raw
 * `path → status` lives on `detail`, which is for `console` and for nothing
 * else: a request path is an internal identifier, and a person cannot act on
 * one. `status` is there so callers can still tell 503 ("no backend here")
 * from 500 ("try again") — the distinction `WorkspaceApiError` was invented
 * for, kept.
 */
export class HttpError extends Error {
  readonly status: number;
  /** The request that failed. FOR LOGS. Never rendered. */
  readonly path: string;

  constructor(path: string, status: number, message?: string) {
    super(message ?? httpErrorMessage(status));
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
  }

  /** One line for an operator. Deliberately not the message. */
  get detail(): string {
    return `${this.path} → ${this.status}`;
  }
}

/** `true` for anything this helper produced from a 401. */
export function isSessionEnded(e: unknown): boolean {
  return e instanceof HttpError && e.status === 401;
}

/**
 * `fetch`, plus the 401 latch, plus `credentials: 'include'` (every route here
 * is cookie-authenticated; forgetting it is how a request becomes a 401 that
 * is our own fault).
 *
 * Returns the `Response` untouched — callers that care about a non-ok status
 * for their own reasons keep that freedom. The latch fires on the RESPONSE, so
 * it lands before any caller-side `.catch()` can swallow the error, which is
 * the property that makes the silent-on-401 paths safe without rewriting them.
 */
export async function httpFetch(
  path: string,
  init?: RequestInit,
  fetchImpl?: FetchLike,
): Promise<Response> {
  const doFetch: FetchLike =
    fetchImpl ?? ((input, i) => globalThis.fetch(input, i));
  const res = await doFetch(path, { credentials: 'include', ...init });
  if (res.status === 401) sessionExpiredActions.expired();
  return res;
}

/** `httpFetch` + "a non-ok status is an `HttpError`" + JSON. The common case. */
export async function httpJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await httpFetch(path, init);
  if (!res.ok) throw new HttpError(path, res.status);
  return (await res.json()) as T;
}

/**
 * Put the operator's half of a failed request in the console, and nowhere else.
 *
 * Split out of `userFacingMessage` so a caller that wants the STATUS rather
 * than the sentence — anything branching on `toReadOutcome` to pick its own
 * per-surface copy — can still leave the same line in the console. Before
 * this, the only way to get that log was to call `userFacingMessage` and throw
 * its return value away, which reads as a mistake every time somebody meets
 * it.
 *
 * `detail` and nothing else, because `detail` is the whole point: a request
 * path and a status are exactly what an operator needs and exactly what a
 * reader cannot act on.
 */
export function logRequestFailure(e: unknown, context: string): void {
  if (e instanceof HttpError) {
    console.warn(`[${context}] ${e.detail}`);
    return;
  }
  console.warn(`[${context}] unexpected failure`, e);
}

/**
 * The sentence to put in front of a person for a caught error.
 *
 * An `HttpError` already carries authored copy, so it speaks for itself.
 * Anything else is a browser string or a bug in our own code — `Failed to
 * fetch`, `undefined is not a function` — and those go to the console, where
 * they help, rather than onto a screen, where they do not.
 */
export function userFacingMessage(e: unknown, context: string): string {
  logRequestFailure(e, context);
  return e instanceof HttpError ? e.message : HTTP_FAILED;
}

/** `httpJson` for a call whose body we do not read. */
export async function httpVoid(
  path: string,
  init?: RequestInit,
): Promise<void> {
  const res = await httpFetch(path, init);
  if (!res.ok) throw new HttpError(path, res.status);
}
