import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * View tokens (§6.5): how the content origin knows a request may have one
 * version of one artifact, with no cookie, session or API of its own. The app
 * checks access, then mints one of these; the content origin checks the
 * signature and the expiry and serves the bytes. A leaked token opens one
 * version of one artifact for at most five minutes.
 *
 * Wire: `v1.<b64url(JSON {a,n,p,l,e})>.<b64url(HMAC-SHA256(key, 'v1.' + payload))>`.
 * The key lives only in this process's memory, so a restart retires every
 * token in flight; the viewer just mints another.
 */

export const VIEW_TOKEN_TTL_SECONDS = 300;

/** Clock skew a token's expiry may run past the TTL by before we call it forged. */
const EXPIRY_SLACK_SECONDS = 60;

/** Longest token we will mint or look at. */
const MAX_TOKEN_CHARS = 600;

const PREFIX = 'v1';
const B64URL = /^[A-Za-z0-9_-]+$/;
/** A SHA-256 HMAC is 32 bytes: 43 base64url characters, unpadded. */
const SIG_CHARS = 43;
const LINK_BINDING_CHARS = 22;

export interface ViewTokenClaims {
  artifactId: string;
  version: number;
  purpose: 'view' | 'download';
  /** A link holder's token: bound to the share code it was minted from. Null for a member's. */
  linkBinding: string | null;
  /** Epoch seconds. */
  expiresAt: number;
}

const WireClaimsSchema = z
  .object({
    a: z.string().min(1).max(256),
    n: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    p: z.enum(['view', 'download']),
    l: z
      .string()
      .length(LINK_BINDING_CHARS)
      .regex(B64URL)
      .nullable(),
    e: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * What a link token is bound to: a one-way digest of the share code, so the
 * token never carries the code itself. Turning the link off or rotating it
 * changes what the code hashes to (or removes it), and the token stops serving.
 */
export function linkBindingFor(shareCode: string): string {
  return createHash('sha256').update(shareCode).digest('base64url').slice(0, LINK_BINDING_CHARS);
}

function sign(key: Uint8Array, payload: string): string {
  return createHmac('sha256', key).update(`${PREFIX}.${payload}`).digest('base64url');
}

export function signViewToken(key: Uint8Array, c: ViewTokenClaims): string {
  const wire = WireClaimsSchema.parse({
    a: c.artifactId,
    n: c.version,
    p: c.purpose,
    l: c.linkBinding,
    e: c.expiresAt,
  });
  const payload = Buffer.from(JSON.stringify(wire)).toString('base64url');
  const token = `${PREFIX}.${payload}.${sign(key, payload)}`;
  if (token.length > MAX_TOKEN_CHARS) throw new Error('view token too long');
  return token;
}

/**
 * The claims, or null for anything that is not a live token this key signed.
 * Never throws: every refusal is the same null, so a caller cannot tell a
 * forged token from an expired or malformed one.
 */
export function verifyViewToken(key: Uint8Array, token: string, nowSeconds: number): ViewTokenClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [prefix, payload, sig] = parts as [string, string, string];
  if (prefix !== PREFIX || !B64URL.test(payload) || sig.length !== SIG_CHARS || !B64URL.test(sig)) return null;

  // Compare the encoded text, not the decoded bytes: the last base64url
  // character carries two spare bits, so two spellings decode to one MAC.
  const want = Buffer.from(sign(key, payload), 'ascii');
  const got = Buffer.from(sig, 'ascii');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = WireClaimsSchema.safeParse(json);
  if (!parsed.success) return null;
  const w = parsed.data;
  if (w.e <= nowSeconds || w.e > nowSeconds + VIEW_TOKEN_TTL_SECONDS + EXPIRY_SLACK_SECONDS) return null;
  return { artifactId: w.a, version: w.n, purpose: w.p, linkBinding: w.l, expiresAt: w.e };
}
