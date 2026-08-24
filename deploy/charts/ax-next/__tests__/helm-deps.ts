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

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The chart whose `dependencies:` we materialize. */
export const CHART_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const BITNAMI_REPO = 'bitnami';
export const BITNAMI_URL = 'https://charts.bitnami.com/bitnami';

/**
 * Marker the run-level sync stamps on `process.env` once it has attempted the
 * fetch. `globalSetup` runs in vitest's parent process and workers inherit its
 * environment, so this carries the "already done" fact ACROSS processes — a
 * module-level flag alone would only dedupe within a single worker, and the
 * whole bug was one-fetch-per-worker. Anything that calls
 * `ensureChartDependencies()` from inside a test file therefore short-circuits
 * instead of touching the shared helm cache a second time.
 */
export const CHART_DEPS_SYNCED_ENV = 'AX_CHART_DEPS_SYNCED';

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
  /** Environment carrying (and receiving) the run-level marker. */
  env?: Record<string, string | undefined>;
};

export type SyncResult =
  /** `attempted: false` = short-circuited (already synced, or no helm). */
  | { ok: true; attempted: boolean }
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
 * At most ONE attempt per process and, via the inherited env marker, per vitest
 * run. The marker is stamped BEFORE the spawns, not after a success: "one
 * attempt, win or lose" is what keeps a failure from re-entering the fetch and
 * rebuilding the amplification this file exists to delete.
 *
 * No-ops when helm is absent — the suites that need it are `describe.skip`-ped
 * by the gate in helm-required.ts, so there is nothing to fetch.
 */
export function ensureChartDependencies(opts: SyncOptions = {}): SyncResult {
  const spawn = opts.spawn ?? realSpawn;
  const env = opts.env ?? process.env;
  const chartDir = opts.chartDir ?? CHART_DIR;

  if (attemptedInThisProcess || env[CHART_DEPS_SYNCED_ENV] === '1') {
    return { ok: true, attempted: false };
  }

  const helm = opts.helm !== undefined ? opts.helm : findHelm(spawn);
  attemptedInThisProcess = true;
  env[CHART_DEPS_SYNCED_ENV] = '1';

  if (helm === null) return { ok: true, attempted: false };

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

/** Test-only: forget this process's attempt. Does not touch the env marker. */
export function resetChartDependencyStateForTests(): void {
  attemptedInThisProcess = false;
}
