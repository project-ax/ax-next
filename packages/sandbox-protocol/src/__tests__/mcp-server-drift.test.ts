import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpServerSchema } from '../schemas.js';

// ---------------------------------------------------------------------------
// ARCH-11 — MCP-server-entry drift guard (schema side).
//
// `McpServerSchema` (this package, the host contract) and the runner's
// hand-rolled `validateMcpEntry` (@ax/agent-claude-sdk-runner — sandbox-side
// defense-in-depth that intentionally does NOT import this package) are both
// asserted against ONE shared fixture of golden vectors. This suite pins the
// SCHEMA side; the runner package's `mcp-server-drift.test.ts` pins the runner
// side by reading the SAME fixture via a repo-root-relative path (no import of
// this package — that's the whole point of the independence). If either
// validator's verdict on any vector flips, one of the two suites fails -> CI
// red, forcing a conscious fixture + cross-reference update.
//
// Each vector declares an expected verdict per side (`schema`, `runner`). The
// `core: true` vectors are the security-critical shape rules that MUST stay
// identical on both sides (name regex, transport enum, transport refine /
// cross-contamination, command presence, url validity, args caps); we assert
// schema === runner for those here too. The `core: false` vectors encode the
// two KNOWN, intentional asymmetries documented on `validateMcpEntry`.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Vector = {
  desc: string;
  core: boolean;
  schema: 'accept' | 'reject';
  runner: 'accept' | 'reject';
  value: unknown;
};

const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures', 'mcp-server-golden-vectors.json'),
    'utf-8',
  ),
) as { note: string; vectors: Vector[] };

describe('McpServerSchema golden-vectors drift guard (schema side)', () => {
  it('has a non-trivial fixture (guards against an empty/renamed file)', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(20);
    // At least one of each verdict on the schema side, and at least one
    // documented asymmetry, so the fixture can't silently collapse to
    // all-accept or all-core.
    expect(fixture.vectors.some((v) => v.schema === 'accept')).toBe(true);
    expect(fixture.vectors.some((v) => v.schema === 'reject')).toBe(true);
    expect(fixture.vectors.some((v) => !v.core)).toBe(true);
  });

  for (const v of fixture.vectors) {
    it(`McpServerSchema ${v.schema}s: ${v.desc}`, () => {
      const ok = McpServerSchema.safeParse(v.value).success;
      expect(ok).toBe(v.schema === 'accept');
    });
  }

  // The core invariant: on the security-critical rules the two validators must
  // never diverge. The fixture itself encodes the requirement (schema ===
  // runner for every `core` vector); assert that encoding here so a careless
  // fixture edit that splits a core verdict is caught even before the runner
  // suite runs.
  for (const v of fixture.vectors.filter((x) => x.core)) {
    it(`core vector has identical schema/runner verdict: ${v.desc}`, () => {
      expect(v.schema).toBe(v.runner);
    });
  }
});
