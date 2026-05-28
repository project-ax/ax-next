import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Repo root: this file is presets/k8s/src/__tests__/<file> → up 4 dirs.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DOCKERFILE = `${REPO_ROOT}container/agent/Dockerfile`;

/**
 * Regression guard for the agent-authored-skills boot-crash (kind walk
 * 2026-05-28): the `ax-skill-creator` SKILL.md asset never reached the
 * production image, so enabling open mode (the chart default) crashed the
 * host at boot via loadBuiltinSkills() → ENOENT.
 *
 * Root cause: the image is built with `pnpm --filter @ax/cli build`, which is
 * `tsc --build` walking TS *project references* — it compiles every package's
 * .ts but does NOT run any package's npm `build` script. The only thing that
 * copies preset-k8s's SKILL.md assets into dist is the `cpSync` step in
 * @ax/preset-k8s's own build script, which that path never runs. `files:
 * ["dist"]` then ships a dist without the asset.
 *
 * Unit/acceptance tests missed it because vitest resolves `import.meta.url` to
 * SOURCE (src/builtin-skills/...), where the asset exists — the gap only
 * appears in the compiled artifact the image actually ships.
 *
 * The invariant this enforces: every workspace package whose `build` script
 * emits NON-tsc artifacts (an asset copy, a Vite bundle, …) must be built
 * explicitly by the production Dockerfile, or those artifacts won't be in the
 * image. @ax/channel-web (vite) was already handled; @ax/preset-k8s (cpSync)
 * was the forgotten symmetric case.
 */

interface PkgJson {
  name?: string;
  scripts?: { build?: string };
}

function readPkgJsons(): { name: string; build: string }[] {
  const out: { name: string; build: string }[] = [];
  for (const group of ['packages', 'presets']) {
    const groupDir = `${REPO_ROOT}${group}`;
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pjPath = `${groupDir}/${entry.name}/package.json`;
      if (!existsSync(pjPath)) continue;
      const pj = JSON.parse(readFileSync(pjPath, 'utf8')) as PkgJson;
      const build = pj.scripts?.build;
      if (pj.name && typeof build === 'string') out.push({ name: pj.name, build });
    }
  }
  return out;
}

/**
 * A build script is "tsc-only" iff every `&&`-separated command is a `tsc`
 * invocation. `tsc --build` walks project references, so the cli's transitive
 * build produces these packages' dist for free. Anything else (cpSync, vite,
 * node -e, copyfiles, esbuild …) emits artifacts that transitive build skips.
 */
function isTscOnly(build: string): boolean {
  return build
    .split('&&')
    .map((seg) => seg.trim())
    .every((seg) => seg === '' || seg.startsWith('tsc'));
}

describe('production image asset packaging', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');

  it('Dockerfile builds every workspace package that emits non-tsc artifacts', () => {
    const nonTscOnly = readPkgJsons().filter((p) => !isTscOnly(p.build));

    // Sanity: the survey must actually find the asset-emitting packages, or the
    // test is vacuously green (e.g. a glob that matched nothing).
    expect(nonTscOnly.map((p) => p.name).sort()).toEqual(
      expect.arrayContaining(['@ax/channel-web', '@ax/preset-k8s']),
    );

    // `pnpm -r build` (recursive) would run every package's build script, so
    // accept it as a blanket satisfier; otherwise each package must be filtered
    // in explicitly.
    const buildsEverything = /pnpm\s+(-r|--recursive)\s+build/.test(dockerfile);

    for (const { name } of nonTscOnly) {
      const filtered = new RegExp(
        `pnpm\\s+--filter\\s+${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s+build`,
      ).test(dockerfile);
      expect(
        buildsEverything || filtered,
        `${name} emits non-tsc build artifacts but the production Dockerfile ` +
          `(container/agent/Dockerfile) never runs its build script — those ` +
          `artifacts will be missing from the image. Add ` +
          `\`pnpm --filter ${name} build\` to the builder stage.`,
      ).toBe(true);
    }
  });
});
