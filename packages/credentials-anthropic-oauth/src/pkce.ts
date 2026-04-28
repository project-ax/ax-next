// PKCE primitives — RFC 7636 §4. Public-client OAuth without a client secret.
//
// Verifier: 43–128 chars from the unreserved set. We use 32 random bytes →
// 43 base64url chars (no padding), well within the spec.
// Challenge: SHA-256 of the verifier, base64url-encoded.
// State: 16 random bytes hex — CSRF-bind for the redirect callback.
//
// All three live in the host process for the few seconds between :login and
// :exchange. Never logged, never persisted, never crossed into a sandbox (I13).

import { createHash, randomBytes } from 'node:crypto';

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generateState(): string {
  return randomBytes(16).toString('hex');
}
