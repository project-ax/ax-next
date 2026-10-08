import { assertSafeUrl, type FetchFn, type HostResolver } from './ssrf.js';

// ---------------------------------------------------------------------------
// Slice 4 — "Signed in as". After the token exchange we work out which account
// the agent signed in as, best effort, so the connector rail can say so.
//
// Everything a provider tells us here is UNTRUSTED text. It is used for DISPLAY
// ONLY — never for an access decision — and every function in this module is
// fail-soft: any problem yields `null`, nothing throws, and nothing is logged
// here (a log line would carry either a token or the account itself). The
// callback logs ONE line about the outcome, carrying only a fixed `reason`
// (see `IdentityMissReason`) — never the account, the token or a body.
// ---------------------------------------------------------------------------

/** Longest account label we keep (an RFC 5321 path is at most 254 octets). */
const ACCOUNT_MAX_CODE_POINTS = 254;

/**
 * Unicode category Cc (C0, DEL, C1), category Cf (format characters: the
 * zero-width space/joiners, the word joiner, the BOM, U+061C and the rest),
 * every Bidi_Control (LRM/RLM, the embeddings, overrides and isolates — all of
 * which can reorder how the label reads on screen), and the line/paragraph
 * separators U+2028/U+2029.
 */
const STRIPPED = /[\p{Cc}\p{Cf}\p{Bidi_Control}\u2028\u2029]/gu;

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
  // Trim again: the cut can land just after a space.
  const capped = Array.from(cleaned).slice(0, ACCOUNT_MAX_CODE_POINTS).join('').trim();
  return capped.length > 0 ? capped : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The first claim that sanitizes to a non-empty label, or null. An `email` the
 * provider explicitly says is NOT verified (`email_verified === false`) is
 * skipped — anyone can type an address they don't own — and the next claim
 * (`preferred_username`, then `sub`) is used instead. Absent or non-boolean
 * `email_verified` keeps the email (many providers never send the claim).
 */
function accountFromClaims(claims: unknown): string | null {
  if (!isPlainObject(claims)) return null;
  for (const name of ACCOUNT_CLAIMS) {
    if (name === 'email' && claims.email_verified === false) continue;
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
 * Why the identity step found no account. A FIXED vocabulary: this is the only
 * thing about the step that is ever logged.
 *   no_id_token / no_userinfo_endpoint — see the callback (no source to read).
 *   not_allowlisted — the userinfo URL failed the pre-check (https, allowlist,
 *     no private IP); nothing was sent.
 *   redirect — a 3xx (never followed). http_status — any other non-2xx, or no
 *     HTTP response at all (a network error).
 *   timeout / too_large / bad_json — as named. no_claim — no usable claim.
 */
export type IdentityMissReason =
  | 'no_id_token'
  | 'no_userinfo_endpoint'
  | 'not_allowlisted'
  | 'http_status'
  | 'redirect'
  | 'timeout'
  | 'too_large'
  | 'bad_json'
  | 'no_claim';

/** What one userinfo lookup found: an account, or a fixed reason it didn't. */
export type UserinfoIdentity =
  | { account: string }
  | { account: null; reason: Exclude<IdentityMissReason, 'no_id_token' | 'no_userinfo_endpoint'> };

type UserinfoMiss = Extract<UserinfoIdentity, { account: null }>;
const miss = (reason: UserinfoMiss['reason']): UserinfoMiss => ({ account: null, reason });

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
 * Never throws and never logs. A miss carries a fixed {@link IdentityMissReason}.
 */
export async function fetchUserinfoIdentity(opts: FetchUserinfoAccountOptions): Promise<UserinfoIdentity> {
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
  const timedOut = new Promise<UserinfoMiss>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(miss('timeout'));
    }, timeoutMs);
  });
  // A throw after the abort is the timeout's doing, whatever the error says.
  const failed = (otherwise: UserinfoMiss['reason']): UserinfoMiss =>
    miss(controller.signal.aborted ? 'timeout' : otherwise);

  const attempt = (async (): Promise<UserinfoIdentity> => {
    try {
      await assertSafeUrl(endpoint, allowedHosts, resolver);
    } catch {
      return failed('not_allowlisted');
    }
    // Timed out during the host check: the caller has moved on; send nothing.
    if (controller.signal.aborted) return miss('timeout');
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      return failed('http_status');
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      // `redirect: 'manual'` in a browser-style fetch yields an opaque redirect
      // (status 0); Node's undici hands back the 3xx itself.
      const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
      return miss(redirected ? 'redirect' : 'http_status');
    }
    let text: string | null;
    try {
      text = await readCapped(res, maxBytes);
    } catch {
      return failed('http_status');
    }
    if (text === null) return miss('too_large');
    let claims: unknown;
    try {
      claims = JSON.parse(text);
    } catch {
      return miss('bad_json');
    }
    const account = accountFromClaims(claims);
    return account === null ? miss('no_claim') : { account };
  })().catch(() => failed('http_status'));

  try {
    return await Promise.race([attempt, timedOut]);
  } finally {
    clearTimeout(timer);
    // A late finish after the timeout is ignored; make sure nothing keeps reading.
    if (!controller.signal.aborted) controller.abort();
  }
}

/** {@link fetchUserinfoIdentity}, the account only. Never throws, never logs. */
export async function fetchUserinfoAccount(opts: FetchUserinfoAccountOptions): Promise<string | null> {
  return (await fetchUserinfoIdentity(opts)).account;
}

/**
 * The scope to request at authorize time: the connector's scope plus `openid`
 * (when the AUTHORIZATION SERVER's metadata lists it in `scopes_supported`) and
 * `email` (when it lists both), each added once, only if not already present.
 *
 * With no base scope we add nothing: the authorization server then applies its
 * own default grant, and asking for `openid email` alone would narrow that
 * grant to identity only — breaking the connector. A dynamically registered
 * client registers this same scope (it is registered fresh on every begin).
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
