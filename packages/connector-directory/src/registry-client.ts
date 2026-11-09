/**
 * The directory's only egress: one page of a registry's server list, from one
 * operator-configured origin.
 *
 * The capability is as small as we could make it (invariant 5):
 *   - https only, no userinfo, query or fragment in the configured URL;
 *   - redirects are refused (`redirect: 'manual'`; any 3xx, or a response a
 *     fetch followed a redirect to anyway, is a `redirect` failure), so the
 *     origin stays pinned;
 *   - one fixed header (`accept`), no credentials;
 *   - page URLs are built with URLSearchParams, so a hostile `nextCursor` is
 *     only ever one query value;
 *   - a deadline per request, plus the caller's signal (run budget, shutdown);
 *   - at most MAX_PAGE_BYTES of decoded body per page (`capResponseBody`);
 *   - a transient failure is asked again at most twice
 *     (`fetchRegistryPageWithRetry`), never once the caller's signal aborted.
 *
 * Failures are fixed short codes. A RegistryError never carries a URL, a
 * header, a byte of the response or an underlying error (JSON.parse's message
 * quotes the text it choked on), so it is safe to log as it is.
 *
 * Why https and no per-IP vetting: see
 * `.claude/memory/decisions/2026-11-09-TASK-1100.md` (egress row).
 */
import { PluginError } from '@ax/core';
import { ResponseTooLargeError, capResponseBody } from '@ax/core/response-cap';
import { REWRITES_THE_SURFACE } from '@ax/core/surface-text';
import {
  MAX_CURSOR_CHARS,
  MAX_PAGE_BYTES,
  PAGE_LIMIT,
  PAGE_RETRY_BACKOFF_MS,
  REQUEST_TIMEOUT_MS,
} from './limits.js';

export const PLUGIN_NAME = '@ax/connector-directory';

export type RegistryFailure =
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'redirect'
  | 'too-large'
  | 'invalid-json'
  | 'invalid-shape'
  | `http-${number}`;

/** A failed registry request. The message names the fixed reason and nothing else. */
export class RegistryError extends Error {
  readonly reason: RegistryFailure;

  constructor(reason: RegistryFailure) {
    super(`registry request failed: ${reason}`);
    this.name = 'RegistryError';
    this.reason = reason;
  }
}

export interface RegistryPage {
  servers: unknown[];
  nextCursor?: string;
}

export interface PageQuery {
  /** Only servers changed at or after this instant; absent = the full list. */
  since?: Date;
  /** The previous page's `nextCursor`, sent back unchanged. */
  cursor?: string;
}

const WHITESPACE = /\s/;
const TRAILING_SLASHES = /\/+$/;

function invalidConfig(message: string): PluginError {
  return new PluginError({ code: 'invalid-config', plugin: PLUGIN_NAME, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The configured registry as a base URL: https only; no username or password,
 * query or fragment (not even an empty `?` or `#`); no whitespace or control
 * characters, which the parser would silently strip or drop; trailing slashes
 * dropped. Throws PluginError `invalid-config`. The message never echoes the
 * URL: it may carry a password.
 */
export function parseRegistryUrl(raw: string): URL {
  if (WHITESPACE.test(raw) || REWRITES_THE_SURFACE.test(raw)) {
    throw invalidConfig('registryUrl must not contain spaces or control characters');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidConfig('registryUrl must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw invalidConfig('registryUrl must use https');
  if (url.username !== '' || url.password !== '') {
    throw invalidConfig('registryUrl must not carry a username or password');
  }
  if (raw.includes('?') || raw.includes('#')) {
    throw invalidConfig('registryUrl must not carry a query or fragment');
  }
  url.pathname = url.pathname.replace(TRAILING_SLASHES, '');
  return url;
}

/**
 * `<base path>/v0.1/servers?limit=100&version=latest[&updated_since=ISO][&cursor=…]`.
 * A new URL; `base` is not changed.
 */
export function registryPageUrl(base: URL, q: PageQuery): URL {
  const url = new URL(base.href);
  url.pathname = `${base.pathname.replace(TRAILING_SLASHES, '')}/v0.1/servers`;
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT), version: 'latest' });
  if (q.since !== undefined) params.set('updated_since', q.since.toISOString());
  if (q.cursor !== undefined) params.set('cursor', q.cursor);
  url.search = params.toString();
  url.hash = '';
  return url;
}

function hasName(err: unknown, name: string): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === name;
}

/**
 * A deadline running out is `timeout`, whether it was ours or the caller's
 * (a run budget); the caller's signal aborting for any other reason
 * (shutdown) is `aborted`; anything else went wrong on the wire.
 */
function classify(
  err: unknown,
  caller: AbortSignal | undefined,
  deadline: AbortSignal,
): RegistryFailure {
  if (err instanceof ResponseTooLargeError) return 'too-large';
  if (hasName(err, 'TimeoutError')) return 'timeout';
  if (caller?.aborted === true) return 'aborted';
  if (deadline.aborted) return 'timeout';
  return 'network';
}

/** Let an answer we will not read go, without holding its connection open. */
function discard(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // Nothing to do: the failure we report is the status, not the body.
  }
}

function readPage(body: unknown): RegistryPage {
  if (!isRecord(body)) throw new RegistryError('invalid-shape');
  const servers = body['servers'];
  if (!Array.isArray(servers)) throw new RegistryError('invalid-shape');

  const metadata = body['metadata'];
  if (metadata === undefined || metadata === null) return { servers };
  if (!isRecord(metadata)) throw new RegistryError('invalid-shape');
  const cursor = metadata['nextCursor'];
  if (cursor === undefined || cursor === null || cursor === '') return { servers };
  // Anything else that is not a usable cursor fails the page rather than
  // reading as "last page": ending a crawl early would let the sync record a
  // checkpoint past entries it never saw.
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_CHARS) {
    throw new RegistryError('invalid-shape');
  }
  return { servers, nextCursor: cursor };
}

/**
 * GET one page. Every request or response failure rejects with a
 * RegistryError carrying a fixed reason; only a caller's own bad argument (an
 * invalid `since` date or `timeoutMs`) throws anything else. A non-2xx body is
 * never read.
 */
export async function fetchRegistryPage(
  fetchImpl: typeof fetch,
  base: URL,
  q: PageQuery,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RegistryPage> {
  const url = registryPageUrl(base, q);
  const caller = opts.signal;
  // Already stopped between pages: no request at all. A deadline that ran
  // out (a run budget) is still a timeout; anything else (shutdown) aborted.
  if (caller?.aborted === true) {
    throw new RegistryError(hasName(caller.reason, 'TimeoutError') ? 'timeout' : 'aborted');
  }
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any(caller === undefined ? [deadline] : [deadline, caller]);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal,
    });
  } catch (err) {
    throw new RegistryError(classify(err, caller, deadline));
  }

  if (
    res.redirected ||
    res.type === 'opaqueredirect' ||
    (res.status >= 300 && res.status <= 399)
  ) {
    discard(res);
    throw new RegistryError('redirect');
  }
  if (res.status < 200 || res.status > 299) {
    discard(res);
    throw new RegistryError(`http-${res.status}`);
  }

  let text: string;
  try {
    text = await capResponseBody(res, MAX_PAGE_BYTES).text();
  } catch (err) {
    throw new RegistryError(classify(err, caller, deadline));
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RegistryError('invalid-json');
  }
  return readPage(body);
}

/** How a retry waits: `ms`, or less once `signal` aborts. Never rejects. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Wait `ms`; end early, clearing the timer, once `signal` aborts (at once if
 * it already has). Never rejects. The timer is unref'd: a wait never keeps the
 * process alive.
 */
export const waitUnlessAborted: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });

/**
 * Whether asking again may get a different answer: a request's own deadline,
 * the wire, the registry asking us to slow down (429) or failing on its side
 * (5xx). Not an answer we refused (redirect, too large, bad JSON or shape) or
 * any other status, which would only come back the same; never an abort.
 */
function isTransient(reason: RegistryFailure): boolean {
  return reason === 'timeout' || reason === 'network' || /^http-(429|5\d\d)$/.test(reason);
}

/**
 * `fetchRegistryPage`, asked again after a transient failure: once per
 * PAGE_RETRY_BACKOFF_MS entry, each after its wait. Never once the caller's
 * signal has aborted, whatever the failure: a run budget that ran out reads as
 * `timeout` too, and shutdown means stop. A wait the signal cuts short makes
 * no further request (`fetchRegistryPage` checks the signal first), so the
 * run budget is never overrun. Rejects with the last RegistryError.
 */
export async function fetchRegistryPageWithRetry(
  fetchImpl: typeof fetch,
  base: URL,
  q: PageQuery,
  opts: { signal?: AbortSignal; timeoutMs?: number; sleep?: Sleep } = {},
): Promise<RegistryPage> {
  const { sleep = waitUnlessAborted, ...once } = opts;
  for (let retry = 0; ; retry += 1) {
    try {
      return await fetchRegistryPage(fetchImpl, base, q, once);
    } catch (err) {
      const wait = PAGE_RETRY_BACKOFF_MS[retry];
      if (
        wait === undefined ||
        !(err instanceof RegistryError) ||
        !isTransient(err.reason) ||
        once.signal?.aborted === true
      ) {
        throw err;
      }
      await sleep(wait, once.signal);
    }
  }
}
