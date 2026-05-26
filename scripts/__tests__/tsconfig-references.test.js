// Guard: every workspace package whose tsconfig.json declares a `references`
// array must reference each `@ax/*` package it lists in `dependencies` and that
// itself builds with `tsc --build` (has a tsconfig.json).
//
// Why this exists (TASK-34): adding `@ax/skill-broker` to `presets/k8s`'s
// package.json `dependencies` + a value import in its `index.ts` — but NOT to
// its tsconfig.json `references` — passed the ROOT `tsc --build` (the root
// tsconfig references skill-broker directly) yet failed CI's ISOLATED
// `@ax/cli build` and the Docker image build with
// `TS2307: Cannot find module '@ax/skill-broker'`, because a project's own
// `tsc --build` resolves its imports through ITS tsconfig references, not the
// root's. A per-package build differs from the root build; this guard closes
// that gap so the mismatch turns RED in any PR test step (it lives in
// scripts/__tests__/, which CI's `pnpm test:scripts` runs UNCONDITIONALLY —
// see .claude/memory patterns 2026-05-25).
//
// Scope: `dependencies` only (devDependencies — test-only @ax/* deps — are
// excluded from the package's `tsc --build`, which excludes __tests__/).
//
// Known exception: a TYPE-ONLY import (`import type { X } from '@ax/y'`) does
// NOT need a project reference (tsc resolves the .d.ts via node_modules without
// a build-ordering edge). Such cases are listed in TYPE_ONLY_EXCEPTIONS with a
// reason; everything else must be referenced.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// `<pkgName>` -> `<@ax dep that is a type-only import and intentionally not referenced>`
const TYPE_ONLY_EXCEPTIONS = new Set([
  // channel-web imports only `import type { Destination } from '@ax/credentials'`
  // (a client-side mirror of the server contract); no value import, so no
  // project-reference edge is required.
  '@ax/channel-web -> @ax/credentials',
]);

/** Strip // and /* *​/ comments so JSON.parse accepts a tsconfig with comments. */
function readJsonc(path) {
  const raw = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(raw);
}

function workspacePackageDirs() {
  const dirs = [];
  for (const root of ['packages', 'presets']) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const dir = join(abs, name);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

describe('tsconfig references match @ax/* dependencies', () => {
  it('every package that declares references lists each @ax/* runtime dep that builds with tsc', () => {
    const dirs = workspacePackageDirs();

    // Map @ax/* package name -> its directory (only those that build with tsc).
    const nameToDir = new Map();
    for (const dir of dirs) {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pj.name) nameToDir.set(pj.name, dir);
    }

    const problems = [];

    for (const dir of dirs) {
      const tsconfigPath = join(dir, 'tsconfig.json');
      if (!existsSync(tsconfigPath)) continue;
      const ts = readJsonc(tsconfigPath);
      if (!Array.isArray(ts.references)) continue;

      const referenced = new Set(
        ts.references.map((r) => normalize(join(dir, r.path))),
      );
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const selfName = pj.name;

      for (const dep of Object.keys(pj.dependencies ?? {})) {
        if (!dep.startsWith('@ax/')) continue;
        const depDir = nameToDir.get(dep);
        if (depDir === undefined) continue; // not a local workspace package
        if (!existsSync(join(depDir, 'tsconfig.json'))) continue; // dep doesn't build with tsc
        if (TYPE_ONLY_EXCEPTIONS.has(`${selfName} -> ${dep}`)) continue;
        if (!referenced.has(normalize(depDir))) {
          problems.push(
            `${relative(REPO_ROOT, dir)}: depends on ${dep} but tsconfig.json "references" lacks ` +
              `{ "path": "${relative(dir, depDir)}" }`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
