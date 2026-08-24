// Guard: the CI pre-pull image list equals the set of images the test suites
// actually start.
//
// Why this exists (TASK-317). testcontainers pulls its image DURING the test
// run, and `pullImage` short-circuits on a purely LOCAL check —
//
//     if (!options.force && (await imageExists(...))) return;
//
// where `imageExists` is a local `dockerode.getImage(name).inspect()` and
// nothing in this repo sets `force`. So an image already resident on the runner
// means the test phase makes ZERO registry calls, and a Docker Hub blip during
// it cannot fail a suite. That is what the `Pre-pull test container images` step
// in .github/workflows/ci.yml buys, and RESIDENCY OF THE EXACT TAG is the whole
// mechanism.
//
// Which is why the list needs a guard rather than good intentions. The tag lives
// at ~118 `new PostgreSqlContainer('postgres:16-alpine')` call sites that share
// no constant, so the CI step is a 119th independent copy. Bump the tag in the
// tests and leave the step alone and you get the worst possible outcome: the
// pre-pull happily succeeds on the OLD tag, the suites cold-pull the NEW one,
// and the original flake is back — sitting behind a green, reassuringly-named
// step. Nothing about a passing CI run would say so, which makes this a
// source-shape guard, same posture as helm-dependency-sync-single-source.test.js
// and the other drift guards here. Runs under `pnpm test:scripts` with no
// network, no Docker, and no build.
//
// The equality is deliberate in BOTH directions. Missing a started image is the
// bug above. Pulling an image no test starts is the card's own original error —
// it asked for `postgres:16` as well, on the strength of a docs line, when all 8
// occurrences of that tag are inert string literals in schema-validation tests
// that start nothing. That would have spent ~150MB per run on an image no suite
// ever uses, so "extra is harmless" is not a thing we want to leave room for.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** Where test sources live. Anything outside these does not start a container. */
const SOURCE_ROOTS = ['packages', 'presets'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-web', 'build', 'coverage']);

/**
 * Every image tag a test source hands to a testcontainers container class.
 *
 * Two spellings, because the second is how a future non-postgres module would
 * most likely arrive: the constructor argument (`new XContainer('img:tag')` —
 * all 118 of today's call sites) and the builder (`.withImage('img:tag')`).
 * Matching `[A-Za-z]*Container` rather than `PostgreSqlContainer` by name is the
 * point: adding `@testcontainers/redis` should redden this guard until the
 * pre-pull list learns about redis, not slip past it.
 */
const CONSTRUCTOR_IMAGE = /new\s+[A-Za-z]*Container\s*\(\s*(['"`])([^'"`]+)\1/g;
const WITH_IMAGE = /\.withImage\s*\(\s*(['"`])([^'"`]+)\1/g;
/** A container class constructed WITHOUT a literal — a hole in the scan. */
const NON_LITERAL_CONSTRUCTOR = /new\s+[A-Za-z]*Container\s*\(\s*[^'"`)\s]/g;

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(REPO_ROOT, root));
  return out.sort();
}

function imagesIn(src) {
  const found = [];
  for (const re of [CONSTRUCTOR_IMAGE, WITH_IMAGE]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) found.push(m[2]);
  }
  return found;
}

/**
 * The pre-pull step's list, read from the delimited block in its `run:` script.
 *
 * Parsed out of the raw file rather than a YAML tree so the guard has no
 * dependency of its own, and anchored on markers so reformatting the step (or
 * moving it between jobs) does not quietly empty the list — an empty list would
 * make the equality assertion below pass against an empty scan.
 */
function prePulledImages() {
  const ci = readFileSync(CI_WORKFLOW, 'utf8');
  const block = /# AX-PREPULL-IMAGES-START([\s\S]*?)# AX-PREPULL-IMAGES-END/.exec(ci);
  if (!block) return null;
  const decl = /images=\(([^)]*)\)/.exec(block[1]);
  if (!decl) return null;
  return decl[1]
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('CI pre-pull list covers the images the tests start', () => {
  const files = sourceFiles();
  const sites = files.flatMap((f) =>
    imagesIn(readFileSync(f, 'utf8')).map((image) => ({ image, path: relative(REPO_ROOT, f) })),
  );
  const started = [...new Set(sites.map((s) => s.image))].sort();
  const pulled = prePulledImages();

  it('finds the pre-pull list in the CI workflow', () => {
    // A null here means the markers or the `images=(…)` declaration moved. Every
    // other assertion in this file is meaningless until that is true again, so
    // it gets its own failure rather than being folded into the equality.
    expect(pulled, 'AX-PREPULL-IMAGES block missing from .github/workflows/ci.yml').not.toBeNull();
    expect(pulled).not.toHaveLength(0);
  });

  it('pre-pulls exactly the images the test sources start', () => {
    // Both directions on purpose — see the header. If this fails, the fix is
    // usually to edit the `images=(…)` list in ci.yml to match reality, NOT to
    // relax this assertion.
    expect([...(pulled ?? [])].sort()).toEqual(started);
  });

  it('every container class is constructed with a literal image tag', () => {
    // A computed tag (`new PostgreSqlContainer(IMAGE)`) is invisible to a text
    // scan, which would make the equality above vacuously true for that suite
    // while it cold-pulls something nobody pre-pulled. If a shared constant is
    // ever introduced — genuinely the better shape for 118 duplicates — this
    // guard has to learn to resolve it before that lands.
    const opaque = files
      .filter((f) => {
        NON_LITERAL_CONSTRUCTOR.lastIndex = 0;
        return NON_LITERAL_CONSTRUCTOR.test(readFileSync(f, 'utf8'));
      })
      .map((f) => relative(REPO_ROOT, f));
    expect(opaque).toEqual([]);
  });

  // Over-guard: a broken walk, a changed extension filter or a renamed
  // directory would leave `started` empty and make the equality assertion pass
  // against an empty pre-pull list. A vacuously green guard is worse than none.
  it('actually scanned the call sites it is meant to police', () => {
    expect(started).not.toHaveLength(0);
    // 118 sites across 22 workspace projects at the time of writing. The floors
    // are loose enough to survive normal churn and tight enough that a collapsed
    // scan trips them.
    expect(sites.length).toBeGreaterThan(50);
    const projects = new Set(sites.map((s) => s.path.split('/').slice(0, 2).join('/')));
    expect(projects.size).toBeGreaterThan(10);
    // The suite whose failure produced this card must be in the scan.
    expect(sites.map((s) => s.path)).toContain(
      join('packages', 'decisions', 'src', '__tests__', 'store.test.ts'),
    );
  });

  it('recognises each spelling, and no inert string literal', () => {
    expect(imagesIn("new PostgreSqlContainer('postgres:16-alpine')")).toEqual([
      'postgres:16-alpine',
    ]);
    expect(imagesIn('new GenericContainer("redis:7").withExposedPorts(6379)')).toEqual(['redis:7']);
    expect(imagesIn('container.withImage(`mongo:7`)')).toEqual(['mongo:7']);
    // The card's own error, pinned. These are the shapes `postgres:16` actually
    // appears in — schema fixtures and assertions that start nothing — and a
    // matcher that swept them up would put a 150MB image nobody uses into the
    // pre-pull list.
    expect(imagesIn("services: [{ ...validServiceDescriptor(), image: 'postgres:16' }]")).toEqual(
      [],
    );
    expect(imagesIn("expect(r.invalid[0].image).toBe('postgres:16')")).toEqual([]);
    expect(imagesIn('image: postgres:16')).toEqual([]);
    // And the blind-spot detector must fire on a computed tag but not a literal.
    const fires = (src) => {
      NON_LITERAL_CONSTRUCTOR.lastIndex = 0;
      return NON_LITERAL_CONSTRUCTOR.test(src);
    };
    expect(fires('new PostgreSqlContainer(POSTGRES_IMAGE)')).toBe(true);
    expect(fires("new PostgreSqlContainer('postgres:16-alpine')")).toBe(false);
    expect(fires('new PostgreSqlContainer()')).toBe(false);
  });
});
