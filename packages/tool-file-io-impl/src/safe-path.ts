// Moved from @ax/tool-file-io in Task 10 — runs sandbox-side.
//
// This module enforces the workspace-root boundary for read_file / write_file.
// Sandbox-side code cannot import @ax/core (invariant I2), so the original
// `PluginError` rejections become plain `Error` throws here. The caller in
// exec.ts / register.ts wraps these into tool-call failure results.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

function reject(message: string): never {
  throw new Error(`safePath: ${message}`);
}

/**
 * Resolve `userPath` (relative) against `rootAbs` (absolute), rejecting any
 * path that escapes the root via '..', absolute prefix, null byte, backslash,
 * colon, or symlink redirection. Segment-aware '..' check: a segment is
 * treated as traversal only when it equals '..' exactly — legitimate names
 * like '..foo.txt' or '.hidden' are accepted (invariant I3).
 */
export async function safePath(rootAbs: string, userPath: string): Promise<string> {
  if (typeof userPath !== 'string' || userPath === '') {
    reject('empty or non-string path');
  }
  if (!path.isAbsolute(rootAbs)) {
    reject('root must be absolute');
  }
  // Check for disallowed characters on the whole string BEFORE splitting:
  // a split on /[/\\]/ would consume backslashes and hide them from a
  // per-segment .includes('\\') check.
  if (userPath.includes('\0')) reject(`path contains null byte: ${userPath}`);
  if (userPath.includes('\\')) reject(`path contains backslash: ${userPath}`);
  if (userPath.includes(':')) reject(`path contains colon: ${userPath}`);

  // Segment-aware '..' check: a segment is traversal only when it equals
  // '..' exactly — names like '..foo.txt' or '.hidden' are accepted (I3).
  // Split on POSIX sep AND backslash so Windows-style inputs can't sneak
  // past (backslash is already rejected above; this is belt-and-suspenders).
  const segments = userPath.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '..') reject(`path contains '..' segment: ${userPath}`);
  }
  if (path.isAbsolute(userPath)) {
    reject(`path is absolute: ${userPath}`);
  }

  const rootReal = await fs.realpath(rootAbs);
  const resolved = path.resolve(rootReal, userPath);
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    reject(`path resolves outside root: ${resolved}`);
  }

  // Walk up to the nearest existing ancestor, realpath that, re-check boundary,
  // then rejoin the non-existent suffix. This allows write_file on a
  // non-existent leaf while still canonicalizing any existing symlinks.
  // The catch swallows only filesystem errors (ENOENT); the Error from
  // the boundary check must propagate, otherwise a symlink escape would walk
  // up past the offending link and silently succeed.
  let probe = resolved;
  while (probe !== rootReal) {
    let real: string;
    try {
      real = await fs.realpath(probe);
    } catch {
      probe = path.dirname(probe);
      continue;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      reject(`symlink canonicalizes outside root: ${real}`);
    }
    const suffix = path.relative(probe, resolved);
    return suffix === '' ? real : path.join(real, suffix);
  }
  return resolved;
}
