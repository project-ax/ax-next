/**
 * OIDC verification for the bridge's two kinds of identity:
 *
 * - the CALLER: the external platform's bearer ID token, on every request,
 *   pinned to one issuer, audience and exact subject;
 * - the VIEWER: the signed viewer assertion in viewer mode, pinned to an
 *   issuer and audience and a maximum age, whose `email` names the person.
 *
 * This is the bridge's only authentication. Tokens are untrusted input:
 * nothing here logs a token, a claim or an email, and a refusal carries only a
 * closed reason code, never token content.
 */
import { MAX_TOKEN_CHARS } from '@ax/apps-bridge-contract';
import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from 'jose';

/** Asymmetric algorithms only: never `HS*` (alg confusion), never `none`. */
export const ALLOWED_JWS_ALGS = [
  'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA',
] as const;

export const CLOCK_TOLERANCE_SECONDS = 30;

/** The viewer assertion's max age, in whole seconds: at least this... */
export const MIN_VIEWER_MAX_AGE_SECONDS = 30;
/** ...and at most this. */
export const MAX_VIEWER_MAX_AGE_SECONDS = 3600;

/**
 * Throws unless `seconds` is a whole number in the allowed range. NaN or
 * Infinity reaching jose's `maxTokenAge` would silently turn the age check
 * off, so the verifier refuses them itself, whatever the config parse did.
 */
export function assertViewerMaxAge(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < MIN_VIEWER_MAX_AGE_SECONDS || seconds > MAX_VIEWER_MAX_AGE_SECONDS) {
    throw new Error(
      `viewer maxAgeSeconds must be a whole number from ${MIN_VIEWER_MAX_AGE_SECONDS} to ${MAX_VIEWER_MAX_AGE_SECONDS}`,
    );
  }
}

export type VerifyFailure =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'too-old'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'wrong-subject'
  | 'bad-claims'
  | 'keys-unavailable';

export type CallerVerdict = { ok: true } | { ok: false; reason: VerifyFailure };
export type ViewerVerdict = { ok: true; email: string } | { ok: false; reason: VerifyFailure };

export interface CallerVerifierConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  subject: string;
}

export interface ViewerVerifierConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  maxAgeSeconds: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A JWKS URL is `https:`, or `http:` on a loopback host, with no credentials.
 * Throws an Error naming the broken rule; the message never echoes the URL
 * (it may hold credentials).
 */
export function assertJwksUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('jwksUrl must be an absolute URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('jwksUrl must not carry credentials');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error('jwksUrl must be https:, or http: on 127.0.0.1, localhost or [::1]');
}

/** The key set failed for a reason that is not the token's fault. */
class KeysUnavailable extends Error {
  constructor() {
    super('signing keys unavailable');
    this.name = 'KeysUnavailable';
  }
}

/**
 * jose's remote key set (defaults: 5 s timeout, 30 s cooldown, 10 min cache),
 * wrapped so that "no key for this token" stays the token's fault and every
 * other failure (fetch error, non-200, bad JSON, timeout, an unusable served
 * key) becomes `KeysUnavailable`.
 */
function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  const remote = createRemoteJWKSet(assertJwksUrl(jwksUrl));
  return async (protectedHeader, token) => {
    try {
      return await remote(protectedHeader, token);
    } catch (err) {
      if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) {
        throw err;
      }
      throw new KeysUnavailable();
    }
  };
}

const BASE64URL_PART = '[A-Za-z0-9_-]+';
const COMPACT_JWS_RE = new RegExp(`^${BASE64URL_PART}\\.${BASE64URL_PART}\\.${BASE64URL_PART}$`);

/** Shape check before any key lookup: bounded length, three base64url parts. */
function wellShaped(token: unknown): token is string {
  return typeof token === 'string' && token.length <= MAX_TOKEN_CHARS && COMPACT_JWS_RE.test(token);
}

function toFailure(err: unknown): VerifyFailure {
  if (err instanceof KeysUnavailable) return 'keys-unavailable';
  if (!(err instanceof errors.JOSEError)) return 'malformed';
  switch (err.code) {
    case 'ERR_JWT_EXPIRED':
      return (err as errors.JWTExpired).claim === 'iat' ? 'too-old' : 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      switch ((err as errors.JWTClaimValidationFailed).claim) {
        case 'iss':
          return 'wrong-issuer';
        case 'aud':
          return 'wrong-audience';
        case 'sub':
          return 'wrong-subject';
        case 'nbf':
          return 'not-yet-valid';
        default:
          return 'bad-claims';
      }
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'bad-signature';
    default:
      return 'malformed';
  }
}

type Verified = { ok: true; payload: JWTPayload } | { ok: false; reason: VerifyFailure };

function createVerifier(
  keys: JWTVerifyGetKey,
  options: Omit<JWTVerifyOptions, 'algorithms' | 'clockTolerance' | 'currentDate'>,
  now: () => number,
): (token: string) => Promise<Verified> {
  return async (token) => {
    if (!wellShaped(token)) return { ok: false, reason: 'malformed' };
    try {
      const { payload } = await jwtVerify(token, keys, {
        ...options,
        algorithms: [...ALLOWED_JWS_ALGS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(now()),
      });
      return { ok: true, payload };
    } catch (err) {
      return { ok: false, reason: toFailure(err) };
    }
  };
}

export function createCallerVerifier(
  cfg: CallerVerifierConfig,
  opts?: { now?: () => number },
): (token: string) => Promise<CallerVerdict> {
  const verify = createVerifier(
    remoteKeys(cfg.jwksUrl),
    { issuer: cfg.issuer, audience: cfg.audience, subject: cfg.subject, requiredClaims: ['exp'] },
    opts?.now ?? Date.now,
  );
  return async (token) => {
    const result = await verify(token);
    return result.ok ? { ok: true } : result;
  };
}

/** Printable ASCII without space, 3-320 characters, exactly one `@`, not at either end. */
const EMAIL_RE = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$/;

function viewerEmail(payload: JWTPayload): string | undefined {
  const { email } = payload;
  if (typeof email !== 'string' || email.length < 3 || email.length > 320 || !EMAIL_RE.test(email)) {
    return undefined;
  }
  if (Object.hasOwn(payload, 'email_verified') && payload['email_verified'] !== true) return undefined;
  return email;
}

export function createViewerVerifier(
  cfg: ViewerVerifierConfig,
  opts?: { now?: () => number },
): (token: string) => Promise<ViewerVerdict> {
  assertViewerMaxAge(cfg.maxAgeSeconds);
  const verify = createVerifier(
    remoteKeys(cfg.jwksUrl),
    {
      issuer: cfg.issuer,
      audience: cfg.audience,
      maxTokenAge: cfg.maxAgeSeconds,
      requiredClaims: ['exp', 'iat', 'email'],
    },
    opts?.now ?? Date.now,
  );
  return async (token) => {
    const result = await verify(token);
    if (!result.ok) return result;
    const email = viewerEmail(result.payload);
    return email === undefined ? { ok: false, reason: 'bad-claims' } : { ok: true, email };
  };
}
