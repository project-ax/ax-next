import { assertSafeUrl, type FetchFn, type HostResolver } from './ssrf.js';

// ---------------------------------------------------------------------------
// Slice 4 — "Signed in as". After the token exchange we work out which account
// the agent signed in as, best effort, so the connector rail can say so.
//
// Everything a provider tells us here is UNTRUSTED text. It is used for DISPLAY
// ONLY — never for an access decision — and every function in this module is
// fail-soft: any problem yields `null`, nothing throws, and nothing is logged
// (a log line would carry either a token or the account itself).
// ---------------------------------------------------------------------------

/** Longest account label we keep (an RFC 5321 path is at most 254 octets). */
const ACCOUNT_MAX_CODE_POINTS = 254;

/**
 * Unicode category Cc (C0, DEL, C1) plus the bidi controls that can reorder how
 * the label reads on screen: LRM/RLM (U+200E/F), the embeddings and overrides
 * (U+202A–U+202E) and the isolates (U+2066–U+2069).
 */
const STRIPPED = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu;

/** The claims we read, in order of preference (OIDC Core §5.1). */
const ACCOUNT_CLAIMS = ['email', 'preferred_username', 'sub'] as const;

/**
 * Make a provider-reported account label safe to store and show: strip control
 * and bidi characters, trim, and cap at 254 code points (never splitting a
 * surrogate pair). Anything that isn't a string, or is empty afterwards → null.
 */
export function sanitizeAccount(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(STRIPPED, '').trim();
  // Array.from iterates code points, so a surrogate pair stays whole.
  const capped = Array.from(cleaned).slice(0, ACCOUNT_MAX_CODE_POINTS).join('');
  return capped.length > 0 ? capped : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first claim that sanitizes to a non-empty label, or null. */
function accountFromClaims(claims: unknown): string | null {
  if (!isPlainObject(claims)) return null;
  for (const name of ACCOUNT_CLAIMS) {
    const account = sanitizeAccount(claims[name]);
    if (account !== null) return account;
  }
  return null;
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Read the account out of an `id_token`'s payload.
 *
 * The signature is deliberately NOT verified. The token came straight from the
 * token endpoint over TLS on a request we made (OIDC Core §3.1.3.7 allows
 * skipping validation in that case), and the result is a display label only —
 * it is never used for authorization. Do not start using it for authz without
 * adding signature, `iss`, `aud` and `exp` validation first.
 */
export function accountFromIdToken(idToken: unknown): string | null {
  try {
    if (typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    // Buffer's base64url decoder silently skips bad characters, so check first.
    if (!BASE64URL.test(payload)) return null;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return accountFromClaims(JSON.parse(json));
  } catch {
    return null;
  }
}

export interface FetchUserinfoAccountOptions {
  /** The authorization server's advertised `userinfo_endpoint` (untrusted). */
  endpoint: string;
  /** Sent as `Authorization: Bearer …`. Never logged. */
  accessToken: string;
  /** The connector's allowlist: the token goes nowhere the connector can't reach. */
  allowedHosts: Set<string>;
  /** Injected in tests; the global `fetch` in production. */
  fetchImpl?: FetchFn;
  /** Injected in tests so the private-IP check makes no real DNS lookup. */
  resolver?: HostResolver;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Read at most `maxBytes` of the body; null (and the stream cancelled) beyond. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The userinfo fallback (used only when the token response had no usable
 * `id_token`). One guarded GET:
 *
 * - The URL must pass `assertSafeUrl` — https only, host in the connector's
 *   `allowedHosts`, and not resolving to a private IP — BEFORE anything is sent.
 *   (`safeFetch` is not used: it follows redirects, re-sending headers, and the
 *   bearer token must never follow a redirect. We reuse its exact pre-check.)
 * - `redirect: 'manual'`, and any non-2xx — a 3xx included — means no identity.
 *   Nothing is ever re-requested.
 * - The whole exchange, body included, is bounded by `timeoutMs`; the body is
 *   read up to `maxBytes` and abandoned beyond.
 *
 * Never throws and never logs.
 */
export async function fetchUserinfoAccount(opts: FetchUserinfoAccountOptions): Promise<string | null> {
  const {
    endpoint,
    accessToken,
    allowedHosts,
    fetchImpl = fetch,
    resolver,
    timeoutMs = 5000,
    maxBytes = 65536,
  } = opts;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  const attempt = (async (): Promise<string | null> => {
    await assertSafeUrl(endpoint, allowedHosts, resolver);
    // Timed out during the host check: the caller has moved on; send nothing.
    if (controller.signal.aborted) return null;
    const res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readCapped(res, maxBytes);
    if (text === null) return null;
    return accountFromClaims(JSON.parse(text));
  })().catch(() => null);

  try {
    return await Promise.race([attempt, timedOut]);
  } finally {
    clearTimeout(timer);
    // A late finish after the timeout is ignored; make sure nothing keeps reading.
    if (!controller.signal.aborted) controller.abort();
  }
}

/**
 * The scope to request at authorize time: the connector's scope plus `openid`
 * (when the AUTHORIZATION SERVER's metadata lists it in `scopes_supported`) and
 * `email` (when it lists both), each added once, only if not already present.
 *
 * With no base scope we add nothing: the authorization server then applies its
 * own default grant, and asking for `openid email` alone would narrow that
 * grant to identity only — breaking the connector. Registration never uses this.
 */
export function requestScopeWithIdentity(
  scope: string | undefined,
  metadata: unknown,
): string | undefined {
  if (scope === undefined || scope.trim() === '') return scope;
  const supported = isPlainObject(metadata) ? metadata.scopes_supported : undefined;
  const list = Array.isArray(supported)
    ? supported.filter((s): s is string => typeof s === 'string')
    : [];
  const present = new Set(scope.split(/\s+/).filter((s) => s.length > 0));
  const add: string[] = [];
  if (list.includes('openid')) {
    if (!present.has('openid')) add.push('openid');
    if (list.includes('email') && !present.has('email')) add.push('email');
  }
  // Nothing to add → the scope goes out exactly as it did before slice 4.
  return add.length === 0 ? scope : [...present, ...add].join(' ');
}

/** The authorization server's advertised `userinfo_endpoint`, if it is a string. */
export function userinfoEndpointOf(metadata: unknown): string | undefined {
  if (!isPlainObject(metadata)) return undefined;
  const v = metadata.userinfo_endpoint;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
