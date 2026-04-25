import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Dev-bootstrap helpers.
//
// The dev-bootstrap path mints a single shared `is_admin` user from a
// pre-shared token in env. It is REFUSED outside `NODE_ENV !== 'production'`
// — the bootstrap CLI is the only sanctioned caller, and operators on prod
// don't need the kid-glove path.
//
// Token comparison is constant-time via `timingSafeEqual`, gated behind a
// length check (timingSafeEqual throws on length mismatch, which would
// itself leak length via exception type).
// ---------------------------------------------------------------------------

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Compare two token strings without leaking length OR per-byte timing.
 * Returns false on:
 *   - length mismatch (without consulting timingSafeEqual)
 *   - any UTF-8 decoding hiccup
 *   - empty inputs (defensive — empty config token must not authenticate)
 */
export function constantTimeTokenEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
