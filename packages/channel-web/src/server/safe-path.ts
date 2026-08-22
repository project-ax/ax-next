/**
 * Path safety for the one route on this surface that takes a path from the
 * caller: `GET /api/workspace/agents/:agentId/files/*`.
 *
 * `safePath` below is a PORT of `~/dev/ai/ax/src/utils/safe-path.ts` (v1's
 * SC-SEC-004 helper, which CLAUDE.md names as worth carrying over) rather than
 * a fresh derivation. It is copied deliberately unchanged — the sanitizer's
 * exact rule set is the reviewed part, and "I rewrote it but it does the same
 * thing" is how a defense loses a case nobody remembers adding. Only
 * `assertWithinBase` was left behind: nothing here reads a path back out of
 * storage, and porting an uncalled function would be half-wired code.
 *
 * WHY A SANITIZER IS USED AS A VALIDATOR. v1's helper REWRITES a hostile
 * segment (`..` → `_`) and hands back something safe. That is right for a
 * writer picking its own filename and wrong for a reader: silently serving
 * `_/_/etc/passwd` when the caller asked for `../../etc/passwd` answers a
 * question nobody asked. So `workspaceFilePath` runs the port and then
 * REJECTS whenever sanitizing changed anything. The containment logic stays
 * the reviewed v1 code; the verdict is ours.
 *
 * There is no filesystem here. `workspace:read` takes a logical,
 * workspace-relative key, and the backend behind it may be git, a bucket, or
 * a table (invariant 1). `VIRTUAL_ROOT` exists only to give `safePath`'s
 * containment check something to contain against — it is never opened, never
 * stat'ed, and never leaves this module.
 */
import { join, relative, resolve, sep } from 'node:path';

/**
 * Safely construct a path from a base directory and untrusted segments.
 *
 * PORTED VERBATIM from v1 (`src/utils/safe-path.ts`). Do not "improve" it in
 * place — if a rule here is wrong, it is wrong in v1 too and both should
 * change together.
 *
 * The function:
 * 1. Sanitizes each segment (removes dangerous characters)
 * 2. Joins segments to the base directory
 * 3. Resolves the result to an absolute path
 * 4. Verifies the resolved path is within the base directory
 * 5. Throws if containment check fails
 */
export function safePath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = resolve(baseDir);

  const sanitized = segments.map((seg) => {
    let clean = seg
      .replace(/[/\\]/g, '_') // path separators -> underscore
      .replace(/\0/g, '') // null bytes -> remove
      .replace(/\.\./g, '_') // .. sequences -> underscore
      .replace(/:/g, '_') // colons -> underscore (Windows ADS)
      .replace(/^[\s]+|[\s.]+$/g, ''); // trim leading whitespace + trailing dots/spaces
    // (a LEADING dot survives, so `.gitignore` stays `.gitignore`)

    if (clean.length === 0) clean = '_empty_';
    if (clean.length > 255) clean = clean.slice(0, 255);

    return clean;
  });

  const constructed = join(resolvedBase, ...sanitized);
  const resolvedFull = resolve(constructed);

  // CRITICAL: Containment check
  if (
    resolvedFull !== resolvedBase &&
    !resolvedFull.startsWith(resolvedBase + sep)
  ) {
    throw new Error(
      `Path traversal blocked: segments ${JSON.stringify(segments)} ` +
        `resolved to "${resolvedFull}" which is outside base "${resolvedBase}"`,
    );
  }

  return resolvedFull;
}

/**
 * A root that does not exist and never will. `safePath` needs SOMETHING to
 * measure containment against; this is a bare token, not a directory. A name
 * nobody would ever mount, so a bug that leaked it into a message reads as
 * obviously wrong rather than as a plausible server path.
 */
const VIRTUAL_ROOT = '/__ax_workspace_root__';

/**
 * The caller-supplied splat → a workspace-relative path we are willing to
 * read, or `null` for "we are not answering this".
 *
 * `raw` arrives from `@ax/http-server`'s splat capture, which passes the
 * remainder of the URL through VERBATIM — no percent-decoding, slashes intact
 * (router.ts). So this function owns the decode, and it does it EXACTLY ONCE.
 * Decoding twice is how `%252e%252e%252f` gets past a check written against
 * the once-decoded form; decoding zero times is how `%2e%2e%2f` gets treated
 * as an innocent filename by us and as a traversal by whatever is downstream.
 * One decode, then validate the result, then never touch it again.
 *
 * `null` covers, in order: a malformed escape, a NUL byte, an empty path, and
 * anything the v1 sanitizer would have had to change to make safe — which is
 * every traversal, every absolute path, every empty or dot-only segment, and
 * every over-long name.
 */
export function workspaceFilePath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape. We cannot know what was meant, and guessing
    // on a security check is how a check becomes decorative.
    return null;
  }

  // NUL truncates the path in any C-string consumer downstream, so `a.md\0.png`
  // and `a.md` become the same read at some layer and different reads at
  // another. `safePath` would strip it and we would never know it was there.
  if (decoded.includes('\u0000')) return null;
  if (decoded.length === 0) return null;

  let resolved: string;
  try {
    resolved = safePath(VIRTUAL_ROOT, ...decoded.split('/'));
  } catch {
    // The containment check fired. Under the sanitizer this should be
    // unreachable, which is exactly why it is handled rather than trusted.
    return null;
  }

  const rel = relative(resolve(VIRTUAL_ROOT), resolved);
  // The verdict: sanitizing changed something, so the caller asked for a path
  // we are not going to invent an answer for.
  return rel === decoded ? rel : null;
}
