// Guard: every image the CI test phase would pull is either pre-pulled or not
// pulled at all.
//
// Two things start containers in that phase, and this file polices both:
//   1. the suites themselves — one image, enumerated from source below;
//   2. testcontainers itself — the Ryuk reaper, which is library-internal and
//      appears in NO test source, so the source scan is structurally blind to it
//      and it needs its own assertion (see the last test in this file).
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
// at every `new PostgreSqlContainer('postgres:16-alpine')` call site in the repo
// — 115 of them as this is written — sharing no constant, so the CI step is one
// more independent copy of the same string. Bump the tag in the
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
//
// A note on the counts in this file: they come from the scan below, not from a
// `git grep`. A grep for the constructor also matches
// `packages/memory-strata/test/bench/internal-corpus.json`, a benchmark corpus
// whose document text contains testcontainers code as DATA — which is why a
// naive count reads 118/22 where this scan (correctly, `.json` excluded) reads
// 115/21. If you update these numbers, take them from a failing assertion here.

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
 * every one of today's call sites) and the builder (`.withImage('img:tag')`).
 * Matching `[A-Za-z]*Container` rather than `PostgreSqlContainer` by name is the
 * point: adding `@testcontainers/redis` should redden this guard until the
 * pre-pull list learns about redis, not slip past it.
 *
 * That breadth has a known false-positive shape: any unrelated class ending in
 * `Container` built from a string literal — `new DIContainer('root')` — reads as
 * a started image and would be demanded in the pull list. Nothing in the tree
 * collides today, and it fails loud rather than silent, but that is the failure
 * to expect if this ever reddens for no obvious reason.
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

/** Images testcontainers pulls on its own behalf, invisible to a source scan. */
const LIBRARY_INTERNAL_PREFIXES = ['testcontainers/ryuk:'];

const isLibraryInternal = (image) =>
  LIBRARY_INTERNAL_PREFIXES.some((prefix) => image.startsWith(prefix));

/** The pre-pull entries that a test source could actually have declared. */
const fromSource = (images) => images.filter((i) => !isLibraryInternal(i));

/**
 * The raw text of the `test:` job, so an assertion about that job's `env` cannot
 * be satisfied by a setting that actually lives in a different job.
 *
 * Sliced from the raw file by indentation: from the `  test:` key to the next key
 * at the same two-space level. Crude, but it needs no dependency, and the
 * over-guard in the Ryuk test proves the slice landed on the right job.
 */
function testJobBlock() {
  const ci = readFileSync(CI_WORKFLOW, 'utf8');
  const marker = '\n  test:\n';
  const start = ci.indexOf(marker);
  if (start === -1) return null;
  const rest = ci.slice(start + 1);
  const body = rest.slice(marker.length - 1);
  const next = /\n {2}[A-Za-z][\w-]*:/.exec(body);
  return next ? rest.slice(0, marker.length - 1 + next.index) : rest;
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
    //
    // Library-internal images are excluded here and asserted separately, because
    // they can never appear in `started`: no test source mentions them. Folding
    // them in would put the two assertions in direct conflict — pre-pulling the
    // reaper to satisfy the Ryuk test below would break this one, so a correct
    // configuration could not pass both.
    expect(fromSource(pulled ?? []).sort()).toEqual(started);
  });

  it('every container class is constructed with a literal image tag', () => {
    // A computed tag (`new PostgreSqlContainer(IMAGE)`) is invisible to a text
    // scan, which would make the equality above vacuously true for that suite
    // while it cold-pulls something nobody pre-pulled. If a shared constant is
    // ever introduced — genuinely the better shape for 115 duplicates — this
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
    // 115 sites across 21 workspace projects as this is written. The floors are
    // deliberately loose — exact counts rot, which is the whole thesis of this
    // file — but tight enough that a collapsed scan trips them.
    expect(sites.length).toBeGreaterThan(50);
    const projects = new Set(sites.map((s) => s.path.split('/').slice(0, 2).join('/')));
    expect(projects.size).toBeGreaterThan(10);
    // The suite whose failure produced this card must be in the scan.
    expect(sites.map((s) => s.path)).toContain(
      join('packages', 'decisions', 'src', '__tests__', 'store.test.ts'),
    );
    // And the library-internal exclusion must be narrow: it may drop the reaper,
    // never a real image. A prefix widened to something like `postgres` would
    // make the equality assertion above silently unfalsifiable.
    expect(fromSource(['postgres:16-alpine', 'testcontainers/ryuk:0.14.0'])).toEqual([
      'postgres:16-alpine',
    ]);
    expect(fromSource(started)).toEqual(started);
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

  // The blind spot the source scan cannot see, and the reason this file's title
  // is about the test PHASE rather than the test SOURCES.
  //
  // testcontainers starts its own container alongside every `.start()`: the Ryuk
  // reaper, `new GenericContainer(REAPER_IMAGE)` where `REAPER_IMAGE` defaults to
  // `testcontainers/ryuk:0.14.0` (testcontainers@11 `build/reaper/reaper.js`),
  // pulled through the very same `pullImage` path as postgres. It is skipped only
  // when `TESTCONTAINERS_RYUK_DISABLED` is exactly the string `"true"`.
  //
  // So "the test phase makes no registry calls" is a claim about TWO images, while
  // every other assertion here can only ever see one. Ryuk appears in no test
  // source, so `started` will never contain it and the equality test above stays
  // happily green while a real registry-blip vector sits open. Hence the pairing
  // rule: either the reaper is off, or its image is pre-pulled. Never neither.
  it('accounts for the Ryuk reaper - disabled, or pre-pulled', () => {
    const block = testJobBlock();
    // Over-guard first: if the slice missed, everything below is vacuous. The
    // pre-pull step lives in this job, so its marker proves we sliced the right
    // job -- and `env:` proves we kept the job-level keys, not just `steps:`.
    expect(block, 'could not slice the `test:` job out of ci.yml').not.toBeNull();
    expect(block).toContain('AX-PREPULL-IMAGES-START');
    expect(block).toContain('env:');

    const disabled = /TESTCONTAINERS_RYUK_DISABLED:\s*'true'/.test(block ?? '');
    const prePulled = (pulled ?? []).some(isLibraryInternal);
    expect(
      disabled || prePulled,
      'the test job must either set TESTCONTAINERS_RYUK_DISABLED to the string ' +
        "'true', or pre-pull a testcontainers/ryuk: image. Otherwise the test " +
        'phase cold-pulls the reaper from Docker Hub and a registry blip can ' +
        'still fail a suite with zero assertions - the exact bug the pre-pull ' +
        'step was added to close.',
    ).toBe(true);
  });
});
