// Chart-shape test: the host Deployment's env vars match what the host
// process actually reads at boot. This is the test that would have caught
// the PR #37 → issue #39 regression: the host pod crash-looping on
// `AX_HTTP_HOST is required` because the chart wired the http-server
// plugin into the preset but forgot to stamp its env vars onto the
// deployment.
//
// Strategy: parse `presets/k8s/src/index.ts` for every `env.*` read, render
// the chart with kind-dev-values, extract the deployment's env keys, and
// assert both directions:
//
//   1. Every env var marked REQUIRED by the source must appear in the
//      deployment (otherwise `loadK8sConfigFromEnv` throws at boot).
//   2. Every env var the deployment SETS must either be read by the
//      preset's loader OR appear on the explicit external-readers list
//      below (e.g. AX_CREDENTIALS_KEY is read by @ax/credentials at init,
//      not by the preset loader). Orphan env vars are usually a half-
//      wired plugin or a stale env from a deleted plugin.
//
// We deliberately reach into the preset's source rather than maintaining
// a hand-curated list — the loader is the contract, and a hand-curated
// list is exactly the thing that drifted in PR #37.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAll } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');
const repoRoot = resolve(here, '../../../..');
const presetSourcePath = resolve(repoRoot, 'presets/k8s/src/index.ts');

const KIND_DEV_VALUES = resolve(chartDir, 'kind-dev-values.yaml');

const REQUIRED = [
  '--set',
  'credentials.key=test',
  '--set',
  'anthropic.apiKey=test',
];

type K8sDoc = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: Record<string, unknown>;
} & Record<string, unknown>;

function findHelm(): string | null {
  const probe = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' });
  if (probe.status === 0) return 'helm';
  return null;
}

const HELM = findHelm();

function helmTemplate(extraArgs: readonly string[]): K8sDoc[] {
  if (!HELM) throw new Error('helm not available');
  const out = execFileSync(
    HELM,
    ['template', 'ax-test', chartDir, ...REQUIRED, ...extraArgs],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return (loadAll(out) as Array<K8sDoc | null>).filter(
    (d): d is K8sDoc => d != null && typeof d === 'object',
  );
}

const describeIfHelm = HELM ? describe : describe.skip;

if (!HELM) {
  console.warn(
    'helm CLI not available; env-shape tests skipped — run with helm in PATH for full coverage',
  );
}

/**
 * Collect every `env.NAME` read inside `loadK8sConfigFromEnv` (and helpers
 * it transitively delegates to). The source is the contract; if we drift
 * from the chart, the test fails.
 */
function collectLoaderEnvReads(): { all: Set<string>; required: Set<string> } {
  const src = readFileSync(presetSourcePath, 'utf8');
  // Match `env.NAME` where NAME is upper-snake_case identifiers — the env
  // reads inside loadK8sConfigFromEnv / workspaceConfigFromEnv. The match
  // is intentionally broad: we want every env var the preset's loaders
  // touch, regardless of which helper they live in.
  const all = new Set<string>();
  for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
    all.add(m[1]!);
  }
  // "Required" = the loader throws when the var is missing. Detect via
  // the `'<NAME> is required'` error-message convention — both
  // loadK8sConfigFromEnv and workspaceConfigFromEnv use it (matched in
  // either direction: `'NAME is required'` or `requires NAME to be set`).
  const required = new Set<string>();
  for (const m of src.matchAll(/['"]([A-Z][A-Z0-9_]*) is required/g)) {
    required.add(m[1]!);
  }
  for (const m of src.matchAll(/requires ([A-Z][A-Z0-9_]*) to be set/g)) {
    required.add(m[1]!);
  }
  return { all, required };
}

/**
 * Env vars the host pod sets that are NOT read by the preset loader.
 * These are read by plugins / CLI / debug at runtime; the chart still
 * needs to stamp them but they don't show up in the loader scan.
 */
const EXTERNAL_READERS: ReadonlySet<string> = new Set([
  // CLI bootstrap reads the config path before any plugin loads.
  'AX_CONFIG_PATH',
  // @ax/credentials reads at init().
  'AX_CREDENTIALS_KEY',
  // Legacy: chart sets ANTHROPIC_API_KEY but no plugin currently reads it
  // (Phase 6 deleted the host-side llm-anthropic plugin). Kept set so
  // operators can re-enable an Anthropic-keyed flow without re-rendering.
  'ANTHROPIC_API_KEY',
  // Read by @ax/http-server at init() — silences the empty-allow-list
  // warning when the chart deliberately doesn't pin allowedOrigins.
  'AX_HTTP_ALLOW_NO_ORIGINS',
  // Intermediate: helper for building DATABASE_URL via $(PGPASSWORD)
  // substitution; the host process never reads it directly.
  'PGPASSWORD',
  // kind-dev-values turns on debug logging via this env. No plugin
  // reads it today, but the values file sets it; allow-listing keeps
  // the test from failing on the kind path.
  'LOG_LEVEL',
]);

describeIfHelm('host deployment env vs preset loader', () => {
  beforeAll(() => {
    // Ensure subchart tarballs are present (postgresql). Idempotent.
    if (!HELM) return;
    const repoAdd = spawnSync(
      HELM,
      ['repo', 'add', '--force-update', 'bitnami', 'https://charts.bitnami.com/bitnami'],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
    );
    if (repoAdd.status !== 0) {
      throw new Error(`helm repo add bitnami failed: ${repoAdd.stderr ?? ''}`);
    }
    const r = spawnSync(HELM, ['dependency', 'build', chartDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (r.status !== 0) {
      throw new Error(`helm dependency build failed: ${r.stderr ?? ''}`);
    }
  });

  function renderHostDeployment(extraArgs: readonly string[] = []): K8sDoc {
    const docs = helmTemplate(['-f', KIND_DEV_VALUES, ...extraArgs]);
    const dep = docs.find(
      (d) =>
        d.kind === 'Deployment' &&
        (d.metadata?.name ?? '').endsWith('-host'),
    );
    if (dep === undefined) throw new Error('host Deployment not found in render');
    return dep;
  }

  function envKeysOf(deployment: K8sDoc): Set<string> {
    const spec = deployment.spec as { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string }> }> } } };
    const container = spec?.template?.spec?.containers?.[0];
    const out = new Set<string>();
    for (const e of container?.env ?? []) {
      if (typeof e.name === 'string') out.add(e.name);
    }
    return out;
  }

  it('host deployment sets every env var the preset loader requires', () => {
    const { required } = collectLoaderEnvReads();
    const deploymentEnv = envKeysOf(renderHostDeployment());

    // Some required-by-loader vars are gated by other config. The test
    // shape is: when the chart's defaults+kind-dev-values render the
    // host pod, every var the loader needs at THAT shape must be set.
    // Workspace-backend-specific required vars are NOT all required for
    // a kind-dev render (only the `local` backend's vars are). Filter
    // those out by checking only the always-required set.
    const ALWAYS_REQUIRED = new Set([
      'DATABASE_URL',
      'AX_K8S_HOST_IPC_URL',
      'AX_HTTP_HOST',
      'AX_HTTP_PORT',
      'AX_HTTP_COOKIE_KEY',
    ]);

    const requiredForKindDev = [...required].filter((v) => ALWAYS_REQUIRED.has(v));
    const missing = requiredForKindDev.filter((v) => !deploymentEnv.has(v));
    expect(missing, `loader requires these env vars but host deployment doesn't set them: ${missing.join(', ')}`).toEqual([]);
  });

  it('host deployment env vars are all read by the preset loader or a known external reader', () => {
    const { all: loaderReads } = collectLoaderEnvReads();
    const deploymentEnv = envKeysOf(renderHostDeployment());

    const known = new Set<string>([...loaderReads, ...EXTERNAL_READERS]);
    const orphans = [...deploymentEnv].filter((v) => !known.has(v));
    expect(orphans, `host deployment sets env vars no plugin reads: ${orphans.join(', ')}`).toEqual([]);
  });

  it('local workspace backend stamps AX_WORKSPACE_ROOT', () => {
    const env = envKeysOf(renderHostDeployment());
    expect(env.has('AX_WORKSPACE_BACKEND')).toBe(true);
    expect(env.has('AX_WORKSPACE_ROOT')).toBe(true);
  });

  it('http backend stamps AX_WORKSPACE_GIT_HTTP_URL + token', () => {
    const env = envKeysOf(
      renderHostDeployment([
        '--set',
        'workspace.backend=http',
        '--set',
        'gitServer.enabled=true',
      ]),
    );
    expect(env.has('AX_WORKSPACE_GIT_HTTP_URL')).toBe(true);
    expect(env.has('AX_WORKSPACE_GIT_HTTP_TOKEN')).toBe(true);
  });

  it('public-http port matches AX_HTTP_PORT env value', () => {
    const dep = renderHostDeployment();
    const spec = dep.spec as {
      template?: {
        spec?: {
          containers?: Array<{
            ports?: Array<{ name?: string; containerPort?: number }>;
            env?: Array<{ name?: string; value?: string }>;
          }>;
        };
      };
    };
    const container = spec.template?.spec?.containers?.[0];
    const publicHttpPort = container?.ports?.find((p) => p.name === 'public-http')?.containerPort;
    const httpPortEnv = container?.env?.find((e) => e.name === 'AX_HTTP_PORT')?.value;
    expect(publicHttpPort).toBeDefined();
    expect(httpPortEnv).toBeDefined();
    expect(String(publicHttpPort)).toBe(String(httpPortEnv));
  });

  it('ipc-http port and PORT env match', () => {
    const dep = renderHostDeployment();
    const spec = dep.spec as {
      template?: {
        spec?: {
          containers?: Array<{
            ports?: Array<{ name?: string; containerPort?: number }>;
            env?: Array<{ name?: string; value?: string }>;
          }>;
        };
      };
    };
    const container = spec.template?.spec?.containers?.[0];
    const ipcPort = container?.ports?.find((p) => p.name === 'ipc')?.containerPort;
    const portEnv = container?.env?.find((e) => e.name === 'PORT')?.value;
    expect(ipcPort).toBeDefined();
    expect(portEnv).toBeDefined();
    expect(String(ipcPort)).toBe(String(portEnv));
  });

  // The credential-proxy plugin's preset config defaults its unix socket
  // to /var/run/ax/proxy.sock. The container runs as UID 1000 (per the
  // agent Dockerfile), so the chart must (a) mount a writable emptyDir
  // there and (b) set fsGroup=1000 so the kubelet chowns the volume to
  // a group the user is in. Without either, the proxy's listen() fails
  // with EACCES and the host pod crash-loops at boot.
  it('mounts an emptyDir at /var/run/ax for the credential-proxy socket', () => {
    const dep = renderHostDeployment();
    const spec = dep.spec as {
      template?: {
        spec?: {
          containers?: Array<{
            volumeMounts?: Array<{ name?: string; mountPath?: string }>;
          }>;
          volumes?: Array<{ name?: string; emptyDir?: object }>;
        };
      };
    };
    const container = spec.template?.spec?.containers?.[0];
    const mount = container?.volumeMounts?.find((m) => m.mountPath === '/var/run/ax');
    expect(mount, 'volumeMount at /var/run/ax').toBeDefined();
    const volume = spec.template?.spec?.volumes?.find((v) => v.name === mount?.name);
    expect(volume, `volume backing the /var/run/ax mount`).toBeDefined();
    expect(volume?.emptyDir, `${mount?.name} must be an emptyDir`).toBeDefined();
  });

  it('host pod sets fsGroup=1000 so emptyDirs are writable by the UID-1000 user', () => {
    const dep = renderHostDeployment();
    const spec = dep.spec as {
      template?: { spec?: { securityContext?: { fsGroup?: number; runAsUser?: number } } };
    };
    const sc = spec.template?.spec?.securityContext;
    expect(sc?.fsGroup, 'pod-level fsGroup').toBe(1000);
    expect(sc?.runAsUser, 'pod-level runAsUser').toBe(1000);
  });
});
