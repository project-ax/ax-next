import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6: an oversized array whose elements all fail
// validation collects one issue per element and can exhaust memory) is fixed
// only in zod 4.6.6. Our own packages are on zod 3, which has no patched
// release, so the advisory sits in pnpm.auditConfig.ignoreGhsas until zod 3 is
// patched locally (Vinay's call, 2026-10-23). That ignore covers every zod
// version, so it would also hide a zod 4 copy below 4.6.6. The override in
// package.json keeps zod 4 at 4.6.6 or later; fail here if any copy slips under it.
it('keeps every installed zod 4 at 4.6.6 or later while the zod advisory is ignored', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = execFileSync('pnpm', ['list', '-r', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const projects = JSON.parse(out);
  const seen = new Set();
  const zods = new Set();
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const key = `${name}@${info?.version}`;
      if (name === 'zod') zods.add(info.version);
      if (seen.has(key)) continue;
      seen.add(key);
      walk(info?.dependencies);
    }
  };
  for (const p of projects) {
    walk(p.dependencies);
    walk(p.devDependencies);
  }
  // A listing that found no zod at all would make the check vacuous.
  expect(zods.size).toBeGreaterThan(0);
  const below = [...zods].filter((v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return major === 4 && (minor < 6 || (minor === 6 && patch < 6));
  });
  expect(below).toEqual([]);
});
