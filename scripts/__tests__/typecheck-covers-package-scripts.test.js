// Guard: the root `typecheck` gate must run every package's own `typecheck`
// script, not just the project-reference build.
//
// Why this exists. `pnpm typecheck` was `tsc --build`, which walks project
// references through each package's `tsconfig.json` -- and those `exclude`
// their `test/` directories. So bench and diagnostic code was type-checked by
// NOTHING: not `pnpm build`, not `pnpm typecheck`, not CI. vitest transpiles
// without checking types, so the suite stayed green over it too.
//
// The bill came due twice in one day. `@ax/memory-strata`'s bench typecheck sat
// RED for weeks across five errors in three `repro-*.ts` diagnostics -- the
// exact files `docs/plans/2026-07-10-assistant-content-extraction-brief.md`
// tells you to reach for first when debugging retrieval ("these are how every
// root cause here was found"). And `x-ai/grok-4.1-fast` sat 404ing in the same
// tree for four months. Neither is a typing failure on its own, but both
// survived because that directory had no gate at all.
//
// `pnpm lint` DOES cover these directories, which is the trap: a clean lint
// reads like a clean typecheck there and is not. Don't substitute one for the
// other.
//
// The mechanism is `pnpm -r --if-present run typecheck`, so a package opts in
// simply by having the script. Two do today (@ax/memory-strata,
// @ax/agent-aisdk-runner), both `tsc --noEmit -p tsconfig.bench.json`.
//
// Opt-in alone would be a weaker promise than "the directories tsc --build
// never reaches", so the last test closes the gap: EVERY tsconfig that the
// reference graph cannot see must be named by its package's typecheck script.
// That rule is not hypothetical -- it caught `onboarding/tsconfig.spa.json`,
// which covered a `src/spa` directory that no longer exists and which nothing
// in the repo referenced. (That config is now deleted; had the SPA still been
// live, the fix would have been a typecheck script instead.)
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally
// -- no network, no build.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every workspace package that opts in by declaring a `typecheck` script. */
function packagesWithTypecheckScript() {
  const found = [];
  for (const workspaceDir of ['packages', 'presets']) {
    const root = join(REPO_ROOT, workspaceDir);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const manifest = join(root, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = readJson(manifest);
      if (pkg.scripts?.typecheck) found.push({ name: pkg.name, script: pkg.scripts.typecheck });
    }
  }
  return found;
}

describe('root typecheck gate covers per-package typecheck scripts', () => {
  it('runs the recursive per-package pass, not just tsc --build', () => {
    const root = readJson(join(REPO_ROOT, 'package.json'));
    const typecheck = root.scripts.typecheck;

    // `tsc --build` alone never reaches a tsconfig that isn't in the project
    // reference graph, and every package's bench config is exactly that.
    expect(typecheck).toMatch(/pnpm -r --if-present run typecheck/);
    // Still has to do the reference build too -- the recursive pass does not
    // replace it, it covers what the reference graph excludes.
    expect(typecheck).toMatch(/tsc --build/);
  });

  it('is wired into CI, not just available locally', () => {
    // A gate nothing runs is the condition this test exists to prevent, so
    // assert the workflow actually invokes it.
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/run:\s*pnpm typecheck/);
  });

  it('at least one package still opts in, so the recursive pass is not a no-op', () => {
    // If every package dropped its typecheck script, the flag above would keep
    // passing while checking nothing. Named rather than counted, so the failure
    // says which one went missing.
    const names = packagesWithTypecheckScript().map((p) => p.name);
    expect(names).toContain('@ax/memory-strata');
  });

  it('every tsconfig outside the reference graph is named by a typecheck script', () => {
    // The systematic half of the guarantee. `tsc --build` only ever sees a
    // package's `tsconfig.json` (and whatever that file references), so any
    // OTHER tsconfig in the package is invisible to it. Each one therefore has
    // to be claimed by that package's `typecheck` script, or it is checked by
    // nothing -- which is the entire bug this file exists to prevent.
    const orphans = [];
    for (const workspaceDir of ['packages', 'presets']) {
      const root = join(REPO_ROOT, workspaceDir);
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) {
        const pkgDir = join(root, entry);
        const manifest = join(pkgDir, 'package.json');
        const baseConfig = join(pkgDir, 'tsconfig.json');
        if (!existsSync(manifest) || !existsSync(baseConfig)) continue;
        const baseText = readFileSync(baseConfig, 'utf8');
        const script = readJson(manifest).scripts?.typecheck ?? '';
        for (const file of readdirSync(pkgDir)) {
          if (!/^tsconfig\..+\.json$/.test(file)) continue;
          // Reachable if the package's own tsconfig.json pulls it in.
          if (baseText.includes(file)) continue;
          if (!script.includes(file)) orphans.push(`${workspaceDir}/${entry}/${file}`);
        }
      }
    }
    expect(
      orphans,
      `these tsconfigs are outside the reference graph and no typecheck script runs them,\n` +
        `so the code they cover is type-checked by nothing. Add a "typecheck" script\n` +
        `naming each one (or delete the config if it is vestigial):\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });
});
