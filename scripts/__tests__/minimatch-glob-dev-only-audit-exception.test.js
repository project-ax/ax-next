import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// GHSA-g3hv-75wg-m249 (minimatch < 11.0.1, globparts ReDoS) and
// GHSA-3g3m-2fjr-6pw4 (glob 9.0.0–14.0.1, AbortSignal bypass) are fixed only in
// new majors, so they sit in pnpm.auditConfig.ignoreGhsas. That is only
// acceptable while both stay dev tooling: today minimatch arrives through
// eslint and glob through testcontainers' archiver. If a production dependency
// ever starts pulling either in, the exception stops being harmless — fail here
// so nobody ships it unnoticed. Same shape as braces-dev-only-audit-exception.
const root = fileURLToPath(new URL('../../', import.meta.url));
const projects = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }),
);

it.each(['minimatch', 'glob'])('keeps the %s audit exception dev-only (no production path)', (pkg) => {
  const seen = new Set();
  const found = [];
  let visited = 0;
  const walk = (deps, trail) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      visited++;
      const key = `${name}@${info?.version}`;
      if (name === pkg) found.push([...trail, key].join(' > '));
      if (seen.has(key)) continue;
      seen.add(key);
      walk(info?.dependencies, [...trail, key]);
    }
  };
  for (const p of projects) walk(p.dependencies, [p.name]);
  // A listing that came back empty would make "no path" vacuous.
  expect(visited).toBeGreaterThan(50);
  expect(found).toEqual([]);
});
