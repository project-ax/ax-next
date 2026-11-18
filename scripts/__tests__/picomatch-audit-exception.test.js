import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// GHSA-fc5q-39xc-vjpf (picomatch <= 4.0.7, ReDoS through single-branch repeated
// extglobs) has no patched version yet, so it sits in pnpm.auditConfig.ignoreGhsas
// (TASK-1152 removes it once one ships). That is only acceptable while picomatch
// is reached through test tooling. Today the one production-tree path is
// better-auth's OPTIONAL `vitest` peer, which only its dist/test-utils imports;
// everything else is devDependencies. If any other production path to picomatch
// appears — a dependency that globs at runtime — fail here so nobody ships it
// unnoticed. Same shape as minimatch-glob-dev-only-audit-exception.
const root = fileURLToPath(new URL('../../', import.meta.url));
const projects = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }),
);

it('keeps the picomatch audit exception behind test tooling (vitest only)', () => {
  const seen = new Set();
  const found = [];
  let visited = 0;
  const walk = (deps, trail) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      visited++;
      const key = `${name}@${info?.version}`;
      if (name === 'picomatch') found.push([...trail, key]);
      if (seen.has(key)) continue;
      seen.add(key);
      walk(info?.dependencies, [...trail, key]);
    }
  };
  for (const p of projects) walk(p.dependencies, [p.name]);
  // A listing that came back empty would make "no other path" vacuous.
  expect(visited).toBeGreaterThan(50);
  const notViaVitest = found
    .filter((trail) => !trail.some((step) => step.startsWith('vitest@')))
    .map((trail) => trail.join(' > '));
  expect(notViaVitest).toEqual([]);
});
