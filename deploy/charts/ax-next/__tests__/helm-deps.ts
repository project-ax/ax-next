// The one place that fetches the chart's subchart dependencies — and it runs
// at most once per vitest run.
//
// Why this file exists (TASK-316). render.test.ts, blob-backend.test.ts and
// env-shape.test.ts each carried a copy-pasted `helmRepoSync()` running
// `helm repo add --force-update bitnami` + `helm dependency build <chartDir>`
// from its own `beforeAll`, and each copy was wrapped in a 3x retry. vitest
// runs test files in parallel, so that was up to NINE concurrent
// `--force-update` writes to the same shared paths:
//
//   ~/.cache/helm/repository/bitnami-index.yaml   (the downloaded index)
//   ~/.config/helm/repositories.yaml              (the repo registration)
//   <chartDir>/charts/ + Chart.lock               (the built subchart)
//
// Those writes are lossy. One writer wins; the losers read a half-written —
// often empty — index. Which is precisely the failure the retry was written to
// paper over: `helm dependency build` reporting "error loading
// bitnami-index.yaml: empty index.yaml file", blamed at the time on Bitnami's
// late-2025 endpoint flakiness. So the retry AMPLIFIED the race it was meant to
// fix, every failure firing another `--force-update` into the same contended
// files. main CI went red at 94d27490 on two `Hook timed out in 30000ms`
// failures (blob-backend, env-shape) and halted the auto-ship merge queue.
//
// Serializing the fetch — not lengthening the timeout — is what removes the
// contention, and it retires both of the old workarounds on its own:
//
//   * `--force-update` is gone. That flag only ever existed to make a REPEATED
//     `helm repo add` idempotent (a second plain `add` errors with "repository
//     name (bitnami) already exists"). One fetch per run has nothing to force,
//     so we register the repo when it is missing and refresh its index when it
//     is already there. Exactly one of the two, exactly once.
//
//   * The 3x retry is gone, and deliberately not replaced. The empty-index it
//     retried around was self-inflicted by the concurrent writers above, so
//     with one writer there is no race left to retry. A genuine upstream outage
//     now fails ONCE, at run level, carrying helm's real stderr — instead of
//     nine writes turning a network blip into a hook timeout whose message
//     ("Hook timed out in 30000ms") names neither helm nor the index.
//
// Hoisting also takes the fetch off the hook clock entirely: it happens in
// `globalSetup` (see global-setup.ts), in vitest's parent process, before any
// worker starts. There is no longer a `hookTimeout` for it to run out of.
//
// Two interlocks keep "once per run" true rather than merely intended: a
// module-level flag (once per process) and a refusal to fetch from inside a
// vitest worker (see VITEST_WORKER_ENV below). The source-shape guard at
// scripts/__tests__/helm-dependency-sync-single-source.test.js is the third —
// it fails if any other file grows its own copy of the fetch.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The chart whose `dependencies:` we materialize. */
export const CHART_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const BITNAMI_REPO = 'bitnami';
export const BITNAMI_URL = 'https://charts.bitnami.com/bitnami';

/**
 * Set by vitest in each test worker, and NOT set in the parent process where
 * `globalSetup` runs. We use it as the cross-process interlock: the real fetch
 * is allowed only outside a worker, so nothing running inside a test file can
 * touch the shared helm cache a second time. A module-level flag cannot do this
 * job — workers are separate processes, so each one starts with a fresh flag,
 * and "one fetch per worker" IS the bug this file exists to delete.
 *
 * This started life as our own marker stamped on `process.env` inside
 * globalSetup, which only works if the worker pool snapshots its environment
 * AFTER globalSetup has run. That ordering is not part of vitest's contract, so
 * the marker was a bet on an implementation detail. Reading a variable vitest
 * itself sets in the worker takes the bet off the table.
 *
 * (Honest footnote, because the first draft of this comment got it wrong: we do
 * NOT have evidence that the inherited marker actually fails anywhere. The CI
 * run that looked like proof was red for an unrelated reason — a bad commit had
 * reverted `globalSetup` out of vitest.config.ts, so nothing stamped the marker
 * at all. The reason to prefer `VITEST_WORKER_ID` is that it needs no
 * assumption, not that the assumption was measured false.)
 */
const VITEST_WORKER_ENV = 'VITEST_WORKER_ID';

/** Are we inside a vitest test worker (as opposed to the run's parent)? */
export function inTestWorker(env: Env = process.env): boolean {
  return env[VITEST_WORKER_ENV] !== undefined;
}

/** Process environment, injectable so the tests never mutate the real one. */
export type Env = Record<string, string | undefined>;

/** Minimal shape of what we need back from a spawn. */
export type HelmSpawnResult = {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
};

/** Injectable spawner — lets the unit tests count calls without running helm. */
export type HelmSpawner = (file: string, args: readonly string[]) => HelmSpawnResult;

const realSpawn: HelmSpawner = (file, args) =>
  spawnSync(file, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export type SyncOptions = {
  /** `null` = helm is absent; omit to probe for it. */
  helm?: string | null;
  chartDir?: string;
  spawn?: HelmSpawner;
  /** Environment the worker interlock is read from. */
  env?: Env;
};

/** Why a call declined to fetch. Named rather than a bare boolean so a skip in
 *  the logs is never ambiguous between "nothing to do" and "already done". */
export type SkipReason =
  /** This process already attempted it — win or lose, once is once. */
  | 'already-attempted'
  /** We are inside a vitest worker; only the run's parent may fetch. */
  | 'in-test-worker'
  /** helm is not on PATH, so the render suites skip and there is nothing to get. */
  | 'no-helm';

export type SyncResult =
  | { ok: true; attempted: true }
  | { ok: true; attempted: false; skipped: SkipReason }
  | { ok: false; reason: string };

/** Probe for helm on PATH. Returns null when it isn't there. */
export function findHelm(spawn: HelmSpawner = realSpawn): string | null {
  return spawn('helm', ['version', '--short']).status === 0 ? 'helm' : null;
}

/**
 * The local name under which BITNAMI_URL is registered, or null if it isn't.
 *
 * We look the repo up by URL and refresh it by the name we find, because that is
 * how helm itself resolves `Chart.yaml`'s `repository:` field — by URL, not by
 * name. A machine that registered the same URL as `bitnami-mirror` needs
 * `helm repo update bitnami-mirror`; assuming the name `bitnami` would fail with
 * "no repositories found matching bitnami" on a setup that actually works.
 *
 * The URL comparison is exact (bar a trailing slash) and never a substring test.
 * `stdout.includes(BITNAMI_URL)` would call
 * `https://evil.example/charts.bitnami.com/bitnami` a match — CodeQL flags that
 * shape as `js/incomplete-url-substring-sanitization`, and it flagged this
 * function's first draft.
 *
 * A missing or unreadable repo list means "not registered", which routes to
 * `repo add` — the correct answer on a fresh CI runner, where the config file
 * does not exist yet and `helm repo list -o json` prints `[]` with exit 0.
 */
export function registeredBitnamiName(listed: HelmSpawnResult): string | null {
  if (listed.status !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout ?? '');
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const { name, url } = entry as { name?: unknown; url?: unknown };
    if (typeof name !== 'string' || typeof url !== 'string') continue;
    if (url.replace(/\/+$/, '') === BITNAMI_URL) return name;
  }
  return null;
}

let attemptedInThisProcess = false;

/**
 * Materialize the chart's subchart tarballs into `<chartDir>/charts/`.
 *
 * At most ONE attempt per process, and only from the run's parent process — the
 * two together are what make it once per vitest RUN. The in-process flag is set
 * BEFORE the spawns, not after a success: "one attempt, win or lose" is what
 * keeps a failure from re-entering the fetch and rebuilding the amplification
 * this file exists to delete.
 *
 * No-ops when helm is absent — the suites that need it are `describe.skip`-ped
 * by the gate in helm-required.ts, so there is nothing to fetch.
 */
export function ensureChartDependencies(opts: SyncOptions = {}): SyncResult {
  const spawn = opts.spawn ?? realSpawn;
  const env = opts.env ?? process.env;
  const chartDir = opts.chartDir ?? CHART_DIR;

  if (attemptedInThisProcess) {
    return { ok: true, attempted: false, skipped: 'already-attempted' };
  }
  if (inTestWorker(env)) {
    return { ok: true, attempted: false, skipped: 'in-test-worker' };
  }

  const helm = opts.helm !== undefined ? opts.helm : findHelm(spawn);
  attemptedInThisProcess = true;

  if (helm === null) return { ok: true, attempted: false, skipped: 'no-helm' };

  // Registered already? `helm repo list` is read-only, so probing costs nothing
  // and tells us which of add/update is the right single call.
  const existing = registeredBitnamiName(spawn(helm, ['repo', 'list', '-o', 'json']));

  // A fresh runner (CI) takes the `add` path, which registers the repo AND
  // downloads its index. A developer box that already has it takes `update`,
  // which re-downloads just the index — and so also repairs a stale or empty
  // cached one, the case `--force-update` used to cover.
  const refresh =
    existing !== null
      ? spawn(helm, ['repo', 'update', existing])
      : spawn(helm, ['repo', 'add', BITNAMI_REPO, BITNAMI_URL]);
  if (refresh.status !== 0) {
    return {
      ok: false,
      reason: `helm repo ${existing !== null ? `update ${existing}` : `add ${BITNAMI_REPO}`} exit ${refresh.status}: ${refresh.stderr ?? ''}`,
    };
  }

  // Idempotent: a no-op when the tarballs named by Chart.lock are already in
  // `<chartDir>/charts/`. The tarballs are gitignored, so a fresh checkout
  // needs this before any `helm template` can resolve postgresql.
  const build = spawn(helm, ['dependency', 'build', chartDir]);
  if (build.status !== 0) {
    return {
      ok: false,
      reason: `helm dependency build exit ${build.status}: ${build.stderr ?? ''}`,
    };
  }

  return { ok: true, attempted: true };
}

/** Test-only: forget this process's attempt so the next call runs again. */
export function resetChartDependencyStateForTests(): void {
  attemptedInThisProcess = false;
}
