// Guard: no tracked, non-binary source file may contain a raw NUL byte.
//
// Why this exists (TASK-218). Four tracked files --
// packages/memory-strata/src/__tests__/agent-tier-sync.test.ts,
// packages/workspace-git-server/src/{client,shared}/__tests__/workspace-id.test.ts,
// packages/workspace-git-server/src/server/__tests__/integration/argv-injection.test.ts
// -- carried a LITERAL NUL byte inside a string literal instead of the
// \u0000 escape. file(1) reported them as `data`, and plain grep/rg
// silently returned NOTHING for the entire file -- no error, no warning, just
// an empty result indistinguishable from "no match". That produced a real
// false negative: a grep for `filterSensitive` in a fifth file
// (packages/memory-strata/src/map.ts, fixed separately under TASK-217)
// returned nothing while the import sat in plain view.
//
// The fix in each case was byte-identical at runtime: swap the raw 0x00 byte
// for the six-character \u0000 escape inside the string literal. This
// guard stops it from creeping back in -- a NUL byte pasted into a test
// fixture (or anywhere else) makes the *whole file* invisible to ordinary
// text tools, which is a footgun regardless of whether the NUL itself is
// intentional.
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs
// UNCONDITIONALLY (see no-workspace-build-in-tests.test.js for the same
// pattern) -- no network, no build, just `git ls-files` + a byte scan.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Extensions that are legitimately binary and exempt from the scan. Keep this
// list minimal -- the point of the guard is that TEXT files stay grep-able;
// widening it should be a conscious, reviewed act, not a way to silence a
// real offender.
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.pdf',
]);

/** Every path git ls-files tracks, repo-root-relative, NUL-delimited so
 *  filenames with odd characters can't corrupt the list. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/** Does this buffer contain a raw 0x00 byte? */
function hasRawNulByte(buf) {
  return buf.includes(0);
}

describe('no tracked non-binary file contains a raw NUL byte', () => {
  const files = trackedFiles();

  it('finds tracked files to scan (the scan itself must not be vacuous)', () => {
    // Same shape as the workspace-build guard's sanity check: a broken
    // git ls-files call would make every assertion below trivially true.
    expect(files.length).toBeGreaterThan(100);
  });

  it('never contains a raw NUL byte in a non-binary tracked file', () => {
    const offenders = [];
    for (const relPath of files) {
      if (BINARY_EXTENSIONS.has(extname(relPath).toLowerCase())) continue;
      const full = join(REPO_ROOT, relPath);
      let buf;
      try {
        buf = readFileSync(full);
      } catch {
        // Deleted-but-still-staged / submodule gitlink entries etc. -- not
        // this guard's concern.
        continue;
      }
      if (hasRawNulByte(buf)) offenders.push(relPath);
    }

    expect(
      offenders,
      'These tracked files contain a raw NUL byte, which makes them invisible ' +
        'to plain grep/rg (file(1) reports them as data; grep silently ' +
        'returns nothing, indistinguishable from "no match"). If the NUL is ' +
        'load-bearing (e.g. a security fixture), write it as the ' +
        String.raw`\u0000` +
        ' escape inside the string literal instead -- byte-identical at ' +
        'runtime, but the file stays readable by ordinary tools. If a new ' +
        'binary asset type is legitimately failing here, add its extension ' +
        'to BINARY_EXTENSIONS in this file.',
    ).toEqual([]);
  });
});

/** Sanity: the byte-level detector itself does the right thing. */
describe('hasRawNulByte', () => {
  it('detects a NUL byte planted anywhere in the buffer', () => {
    expect(hasRawNulByte(Buffer.from('abc\0def', 'binary'))).toBe(true);
    expect(hasRawNulByte(Buffer.from('\0leading', 'binary'))).toBe(true);
    expect(hasRawNulByte(Buffer.from('trailing\0', 'binary'))).toBe(true);
  });

  it('does not flag an ordinary text buffer', () => {
    expect(hasRawNulByte(Buffer.from('no nul bytes here', 'utf8'))).toBe(false);
  });

  it('does not flag the escaped form (six literal characters, not a byte)', () => {
    // Two backslashes so the JS literal below evaluates to the six literal
    // source characters backslash-u-0-0-0-0, NOT a real NUL byte -- this is
    // what the fixed source files now contain in place of the raw byte.
    const escaped = 'const s = "' + '\\\\u0000' + '";';
    expect(hasRawNulByte(Buffer.from(escaped, 'utf8'))).toBe(false);
  });

  it('handles unicode text without false positives', () => {
    expect(hasRawNulByte(Buffer.from('unicode emoji text', 'utf8'))).toBe(false);
  });
});
