// @vitest-environment node
/**
 * Every module the HOST can reach must spell its relative imports with `.js`.
 *
 * `src/server/` is compiled by `tsc` and run by Node as ESM. Node's resolver
 * does not guess extensions, so a relative import written without one resolves
 * to a path that does not exist and the process dies at module load — before
 * any of our error handling, with an `ERR_MODULE_NOT_FOUND` and no `fatal:`
 * line. Most of `src/lib/` is browser-only and gets away without extensions
 * because Vite and Vitest both guess; the moment the server imports one of
 * those modules, it stops getting away with it.
 *
 * THIS IS NOT HYPOTHETICAL. TASK-352 put `lib/workspace-steps.ts` on both
 * sides — the browser builds the live step panel, the route builds the
 * reloaded one — and its two extensionless imports took the whole CLI down at
 * boot. Every channel-web test passed; so did `tsc`; so did `vite build`. The
 * only thing that noticed was `@ax/cli`'s end-to-end test, three packages and
 * several minutes away, reporting an exit code. This test is the same finding,
 * arriving next to the file that caused it.
 *
 * It walks the real import graph rather than checking a list, so the next lib
 * module pulled server-side is covered without anyone remembering to add it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
const SERVER_DIR = join(SRC, 'server');

/** `import ... from '<spec>'` / `export ... from '<spec>'` / `import('<spec>')`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

/** Resolve a relative specifier to a real source file, or `null`. */
function resolveSource(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    base,
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

interface Offence {
  file: string;
  spec: string;
}

/**
 * Walk out from every server module, following relative imports, and collect
 * the ones written without an extension.
 */
function walkServerGraph(): { visited: string[]; offences: Offence[] } {
  const entries = readdirSync(SERVER_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts'))
    .map((e) => join(SERVER_DIR, e.name));

  const seen = new Set<string>();
  const offences: Offence[] = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) continue; // a package, not our tree
      if (!/\.(js|jsx|json|css)$/.test(spec)) {
        offences.push({ file: file.slice(SRC.length + 1), spec });
        // Still follow it, so one missing extension does not hide the rest of
        // that branch of the graph.
      }
      const target = resolveSource(file, spec);
      if (target !== null && target.startsWith(SRC)) queue.push(target);
    }
  }
  return { visited: [...seen], offences };
}

describe('the host-reachable module graph', () => {
  it('is big enough that a passing sweep means something', () => {
    // A guard that walked zero files would pass forever. Anchor it on a module
    // that is unambiguously server-reachable and on a lib module that only
    // became so with TASK-352.
    const { visited } = walkServerGraph();
    const rel = visited.map((f) => f.slice(SRC.length + 1));
    expect(rel).toContain('server/routes-workspace.ts');
    expect(rel).toContain('lib/workspace-steps.ts');
    expect(rel).toContain('lib/fence-line.ts');
    expect(rel.length).toBeGreaterThan(20);
  });

  it('spells every relative import with an extension Node can resolve', () => {
    const { offences } = walkServerGraph();
    expect(
      offences.map((o) => `${o.file} -> ${o.spec}`),
      'Node ESM does not guess extensions. These imports resolve under Vite and ' +
        'Vitest and then kill the host at module load. Append `.js` (even though ' +
        'the file on disk is `.ts` — that is the NodeNext convention this repo ' +
        'already uses in src/server). A type-only import is erased at emit and ' +
        'so is latent rather than live, but it is held to the same rule: a ' +
        'convention with exceptions is not checkable, and the day that import ' +
        'stops being type-only nobody re-reads this line.',
    ).toEqual([]);
  });
});
