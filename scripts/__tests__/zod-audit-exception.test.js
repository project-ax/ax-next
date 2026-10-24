import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6): a collection schema builds one issue per
// failing element, so one big untrusted payload can exhaust memory. The 4.6.6
// fix (upstream a0ebf970) only makes .max(), .length() and .size() reject an
// oversized collection before its elements are parsed. An unbounded z.array()
// still builds one issue per bad element in 4.6.6 and later.
//
// Our own packages are on zod 3.25.76, which has no fixed release, so
// patches/zod@3.25.76.patch (TASK-938) bounds it locally. Every issue list
// stops at 100, in both engines the package ships (`zod`, and the zod 4 core
// under `zod/v4` that @modelcontextprotocol/sdk uses), and the v3 API gets
// 4.6.6's size short-circuit. zod-issue-bound.test.js proves the installed copy
// is bounded. pnpm audit checks version numbers and cannot see a local patch,
// so the advisory stays in pnpm.auditConfig.ignoreGhsas (Vinay's call,
// 2026-10-23).
//
// That ignore covers every zod version. This file makes sure it hides nothing
// else: the patch is registered, every zod 3 in the tree is that one patched
// 3.25.76, and every zod 4 is at 4.6.6 or later (the package.json override).
const root = fileURLToPath(new URL('../../', import.meta.url));

let installed;
function installedZods() {
  if (installed) return installed;
  const out = execFileSync('pnpm', ['list', '-r', '--depth', 'Infinity', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const projects = JSON.parse(out);
  const seen = new Set();
  const zods = [];
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      // Dedupe by install path, not name@version: one version can resolve to
      // several directories (peer variants), and each one has to be walked.
      const key = info?.path ?? `${name}@${info?.version}`;
      if (name === 'zod') zods.push({ version: info.version, path: info.path });
      if (seen.has(key)) continue;
      seen.add(key);
      walk(info?.dependencies);
    }
  };
  for (const p of projects) {
    walk(p.dependencies);
    walk(p.devDependencies);
  }
  installed = zods;
  return zods;
}

it('keeps every installed zod 4 at 4.6.6 or later while the zod advisory is ignored', () => {
  const zods = installedZods();
  // A listing that found no zod at all would make the check vacuous.
  expect(zods.length).toBeGreaterThan(0);
  const below = [...new Set(zods.map(({ version }) => version))].filter((v) => {
    const [major, minor, patch] = v.split('.').map(Number);
    return major === 4 && (minor < 6 || (minor === 6 && patch < 6));
  });
  expect(below).toEqual([]);
});

it('keeps every installed zod 3 at the one patched 3.25.76', () => {
  const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  expect(manifest.pnpm.patchedDependencies['zod@3.25.76']).toBe('patches/zod@3.25.76.patch');
  const zod3 = installedZods().filter(({ version }) => version.split('.')[0] === '3');
  expect(zod3.length).toBeGreaterThan(0);
  // pnpm applies the patch to exactly this version; any other zod 3 would be unpatched.
  expect([...new Set(zod3.map(({ version }) => version))]).toEqual(['3.25.76']);
  // One directory on disk, so the consumers zod-issue-bound.test.js loads from
  // stand for every package that uses zod 3.
  expect(zod3.every(({ path }) => typeof path === 'string')).toBe(true);
  expect(new Set(zod3.map(({ path }) => realpathSync(path))).size).toBe(1);
});
