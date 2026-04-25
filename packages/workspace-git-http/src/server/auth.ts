import { timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'bearer ';

export type BearerCheckResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Validate `Authorization: Bearer <token>` against the expected service token.
 *
 * Different from @ax/ipc-core's `authenticate`: there's no session resolution
 * here, just a static shared token between the host pod and the git-server
 * pod (provisioned via the Helm `gitServerAuth` Secret). Token never appears
 * in any error message — invariant I9 carried over from the IPC slice.
 */
export function checkBearerToken(
  authHeader: string | undefined,
  expectedToken: string,
): BearerCheckResult {
  if (authHeader === undefined || authHeader.length === 0) {
    return { ok: false, status: 401, message: 'missing authorization' };
  }
  if (
    authHeader.length <= BEARER_PREFIX.length ||
    authHeader.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX
  ) {
    return { ok: false, status: 401, message: 'invalid authorization scheme' };
  }
  const presented = authHeader.slice(BEARER_PREFIX.length).trim();
  if (presented.length === 0) {
    return { ok: false, status: 401, message: 'invalid authorization scheme' };
  }
  // Constant-time compare. timingSafeEqual REQUIRES equal-length buffers;
  // mismatched lengths short-circuit to false without leaking the difference.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) {
    return { ok: false, status: 401, message: 'unknown token' };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, message: 'unknown token' };
  }
  return { ok: true };
}
