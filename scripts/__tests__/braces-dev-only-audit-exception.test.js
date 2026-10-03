import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// GHSA-vfj7-8cjw-p6xm (braces <= 3.0.3, stack-exhaustion DoS) has no patched
// release, so it sits in pnpm.auditConfig.ignoreGhsas (TASK-750). That is only
// acceptable while braces is dev tooling: today it arrives solely through
// @changesets/cli. If a production dependency ever starts pulling braces in,
// the exception stops being harmless — fail here so nobody ships it unnoticed.
it('keeps the braces audit exception dev-only (no production path to braces)', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = execFileSync('pnpm', ['list', '-r', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const projects = JSON.parse(out);
  const seen = new Set();
  const found = [];
  let visited = 0;
  const walk = (deps, trail) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      visited++;
      const key = `${name}@${info?.version}`;
      if (name === 'braces') found.push([...trail, key].join(' > '));
      if (seen.has(key)) continue;
      seen.add(key);
      walk(info?.dependencies, [...trail, key]);
    }
  };
  for (const p of projects) walk(p.dependencies, [p.name]);
  // A listing that came back empty would make "no braces" vacuous.
  expect(visited).toBeGreaterThan(50);
  expect(found).toEqual([]);
});
