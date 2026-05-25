import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateMcpEntry } from '../installed-skills.js';

// ---------------------------------------------------------------------------
// ARCH-11 — MCP-server-entry drift guard (runner side).
//
// The runner's hand-rolled `validateMcpEntry` is deliberately INDEPENDENT of
// `@ax/sandbox-protocol`'s `McpServerSchema`: it must re-validate at the
// sandbox-side trust boundary WITHOUT importing the host contract package
// (invariant I2 — no cross-plugin imports across the boundary; the
// independence is the whole point of the defense-in-depth). To keep the two
// in sync without coupling them, both are asserted against the SAME shared
// golden-vectors fixture that lives with the schema. This side reaches it
// READ-ONLY via a repo-root-relative path — it does NOT import the schema
// package. The schema side lives in
// packages/sandbox-protocol/src/__tests__/mcp-server-drift.test.ts.
//
// If either validator's verdict on a vector flips, one of the two suites
// fails -> CI red.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = packages/agent-claude-sdk-runner/src/__tests__
//   -> ../ src  -> ../ agent-claude-sdk-runner  -> ../ packages  -> ../ repoRoot
const repoRoot = path.join(__dirname, '..', '..', '..', '..');
const fixturePath = path.join(
  repoRoot,
  'packages',
  'sandbox-protocol',
  'src',
  '__tests__',
  'fixtures',
  'mcp-server-golden-vectors.json',
);

type Vector = {
  desc: string;
  core: boolean;
  schema: 'accept' | 'reject';
  runner: 'accept' | 'reject';
  value: unknown;
};

const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  note: string;
  vectors: Vector[];
};

/** True iff validateMcpEntry accepts the value (returns without throwing). */
function runnerAccepts(value: unknown): boolean {
  try {
    validateMcpEntry(value);
    return true;
  } catch {
    return false;
  }
}

describe('validateMcpEntry golden-vectors drift guard (runner side)', () => {
  it('found the shared fixture and it is non-trivial', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(20);
    expect(fixture.vectors.some((v) => v.runner === 'accept')).toBe(true);
    expect(fixture.vectors.some((v) => v.runner === 'reject')).toBe(true);
  });

  for (const v of fixture.vectors) {
    it(`validateMcpEntry ${v.runner}s: ${v.desc}`, () => {
      expect(runnerAccepts(v.value)).toBe(v.runner === 'accept');
    });
  }

  // Independence self-check: the runner must NOT IMPORT the host contract
  // package, anywhere in its source. Reaching the fixture by path is fine —
  // that's data, not a code coupling — and a cross-reference COMMENT naming
  // the package (as installed-skills.ts has) is also fine. So we match only an
  // actual `import ... from '@ax/sandbox-protocol'` / `require('@ax/...')`
  // statement, not any mention, so a future "just import the schema" shortcut
  // trips this guard without flagging the deliberate cross-reference doc.
  it('the runner package does not import @ax/sandbox-protocol (independence invariant)', () => {
    // Match only a module SPECIFIER that directly follows `from`/`require(`/
    // `import(` (no arbitrary content may span between). That catches a real
    // static or dynamic import without false-positiving on a comment or
    // string that merely names the package.
    const importRe = /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*['"]@ax\/sandbox-protocol['"]/;
    const srcRoot = path.join(repoRoot, 'packages', 'agent-claude-sdk-runner', 'src');
    const selfPath = fileURLToPath(import.meta.url);
    const offenders = collectTsFiles(srcRoot).filter(
      // This guard file legitimately names the package in its assertion text;
      // exclude it so its own description can't trip the check.
      (file) => file !== selfPath && importRe.test(readFileSync(file, 'utf-8')),
    );
    expect(offenders).toEqual([]);
  });
});

/** Recursively collect every `.ts` file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
