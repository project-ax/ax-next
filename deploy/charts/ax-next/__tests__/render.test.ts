// Chart render tests for the dedicated git-server StatefulSet tier.
//
// Strategy: shell out to `helm template`, parse the multi-doc YAML, and
// assert on the resulting resources. The tests gate on `helm` being on the
// PATH; if it's not, every test inside the suite is skipped with a clear
// console.warn so CI doesn't silently pass over a missing dep.
//
// History: prior to 2026-05-04 this file also covered a parallel "legacy
// Deployment + experimental StatefulSet" canary topology, gated behind
// `gitServer.experimental.gitProtocol`. Both the legacy
// `@ax/workspace-git-http` server and the canary toggle were retired in
// the workspace-git-http deletion sweep. The chart now renders one tier:
// the StatefulSet, when `gitServer.enabled=true`.

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAll } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');

/** Stable required values so each test only sets what it's actually checking. */
const REQUIRED = [
  '--set',
  'credentials.key=test',
  '--set',
  'anthropic.apiKey=test',
  // Required since issue #39: http-server's cookie signing key + an auth
  // provider. 64-hex-char zero is fine for chart-render tests; these never
  // boot the host.
  '--set',
  'http.cookieKey=0000000000000000000000000000000000000000000000000000000000000000',
  '--set',
  'auth.devBootstrap.token=test-bootstrap',
];

/** A rendered k8s resource. Loose typing — tests narrow as needed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type K8sDoc = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  // `any` here is deliberate: tests reach deep into `spec` and a more
  // precise type would require modeling every k8s resource shape we
  // assert on. The yaml is parsed as opaque; assertions narrow by use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} & Record<string, any>;

/** Detect helm at module load. Returns null if absent. */
function findHelm(): string | null {
  const probe = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' });
  if (probe.status === 0) return 'helm';
  return null;
}

const HELM = findHelm();

/** Run `helm template ax-test <chart> <extraArgs...>` and parse YAML docs. */
function helmTemplate(extraArgs: readonly string[]): K8sDoc[] {
  if (!HELM) throw new Error('helm not available');
  // stdio[2] = 'ignore' silences helm's noisy `walk.go:74: found symbolic
  // link in path` warnings (it walks pnpm-symlinked paths in node_modules
  // when scanning the chart). They're harmless and would drown actual
  // failures in CI logs.
  const out = execFileSync(
    HELM,
    ['template', 'ax-test', chartDir, '--namespace', 'default', ...REQUIRED, ...extraArgs],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  // js-yaml's loadAll may emit nulls for empty docs (between separators).
  return (loadAll(out) as Array<K8sDoc | null>).filter(
    (d): d is K8sDoc => d != null && typeof d === 'object',
  );
}

/** Helm-template, capturing stderr — used to assert on `required` failures. */
function helmTemplateExpectFailure(extraArgs: readonly string[]): {
  status: number;
  stderr: string;
} {
  if (!HELM) throw new Error('helm not available');
  const r = spawnSync(
    HELM,
    ['template', 'ax-test', chartDir, '--namespace', 'default', ...REQUIRED, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return { status: r.status ?? -1, stderr: r.stderr ?? '' };
}

const describeIfHelm = HELM ? describe : describe.skip;

if (!HELM) {
  console.warn(
    'helm CLI not available; chart-render tests skipped — run with helm in PATH for full coverage',
  );
}

const STS_NAME = 'ax-test-ax-next-git-server-experimental';

// Pull subchart tarballs (postgresql) into charts/ before any render. They
// ship via Chart.yaml dependency declaration and are gitignored, so a fresh
// checkout (CI, new clones) needs `helm dependency build` once. Idempotent;
// a no-op when the tarballs are already present.
//
// The bitnami repo also has to be registered locally for `dependency build`
// to resolve postgresql. `helm repo add ... --force-update` is idempotent.
//
// Module-level so both describe blocks share one setup; without this the
// subprocess overhead doubles (each `helm dependency build` walks the
// chart tree even when it's a no-op).
beforeAll(() => {
  if (!HELM) return;
  const repoAdd = spawnSync(
    HELM,
    ['repo', 'add', '--force-update', 'bitnami', 'https://charts.bitnami.com/bitnami'],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (repoAdd.status !== 0) {
    throw new Error(
      `helm repo add bitnami failed (exit ${repoAdd.status}): ${repoAdd.stderr ?? ''}`,
    );
  }
  const r = spawnSync(HELM, ['dependency', 'build', chartDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(
      `helm dependency build failed (exit ${r.status}): ${r.stderr ?? ''}`,
    );
  }
});

describeIfHelm('ax-next chart: git-server StatefulSet', () => {
  it('gitServer.enabled=true: StatefulSet + headless Service + ClusterIP Service + NetworkPolicy render', () => {
    const docs = helmTemplate([
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
    ]);
    const sts = docs.find(
      (d) => d.kind === 'StatefulSet' && d.metadata?.name === STS_NAME,
    );
    expect(sts, 'git-server StatefulSet').toBeDefined();

    const headless = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === `${STS_NAME}-headless`,
    );
    expect(headless, 'headless Service').toBeDefined();

    const clusterIp = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === STS_NAME,
    );
    expect(clusterIp, 'ClusterIP Service').toBeDefined();

    const np = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' && d.metadata?.name === `${STS_NAME}-network`,
    );
    expect(np, 'NetworkPolicy').toBeDefined();

    // StatefulSet shape.
    expect(sts?.spec?.replicas, 'replicas defaults to gitServer.shards=1').toBe(1);
    expect(sts?.spec?.podManagementPolicy).toBe('Parallel');
    expect(sts?.spec?.updateStrategy?.type).toBe('RollingUpdate');

    const vcts = sts?.spec?.volumeClaimTemplates;
    expect(Array.isArray(vcts) && vcts.length).toBe(1);
    const vct = vcts[0];
    expect(vct.metadata?.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(vct.spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(vct.spec?.resources?.requests?.storage).toBe('10Gi');

    const container = sts?.spec?.template?.spec?.containers?.[0];
    const env: Array<{
      name: string;
      value?: string;
      valueFrom?: { fieldRef?: { fieldPath?: string } };
    }> = container?.env ?? [];
    const envByName = Object.fromEntries(env.map((e) => [e.name, e]));
    expect(envByName.AX_GIT_SERVER_TOKEN).toBeDefined();
    expect(envByName.AX_GIT_SERVER_REPO_ROOT?.value).toBe('/var/lib/ax-next/repo');
    expect(envByName.AX_GIT_SERVER_PORT?.value).toBe('7780');
    expect(envByName.AX_GIT_SERVER_SHARD_INDEX?.valueFrom?.fieldRef?.fieldPath).toBe(
      "metadata.labels['apps.kubernetes.io/pod-index']",
    );
    expect(envByName.AX_GIT_SERVER_DRAIN_TIMEOUT_MS?.value).toBe('50000');

    expect(container?.securityContext?.runAsNonRoot).toBe(true);
    expect(container?.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(container?.securityContext?.capabilities?.drop).toEqual(['ALL']);

    const preStopCmd: string[] | undefined =
      container?.lifecycle?.preStop?.exec?.command;
    expect(preStopCmd?.length, 'preStop command set').toBeGreaterThan(0);
    expect(preStopCmd?.join(' ')).toMatch(/kill\s+-TERM\s+1/);
    expect(preStopCmd?.join(' ')).toMatch(/sleep\s+55\b/);

    expect(sts?.spec?.template?.spec?.terminationGracePeriodSeconds).toBe(60);
  });

  it('gitServer.enabled=false (default): no git-server resources render', () => {
    const docs = helmTemplate([]);
    const gitServerDocs = docs.filter((d) =>
      (d.metadata?.name ?? '').includes('git-server'),
    );
    expect(gitServerDocs).toEqual([]);
  });

  it('shards: 3 → replicas: 3 with a single volumeClaimTemplate', () => {
    const docs = helmTemplate([
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
      '--set', 'gitServer.shards=3',
    ]);
    const sts = docs.find(
      (d) => d.kind === 'StatefulSet' && d.metadata?.name === STS_NAME,
    );
    expect(sts?.spec?.replicas).toBe(3);
    expect(sts?.spec?.volumeClaimTemplates?.length).toBe(1);
  });

  it('headless Service: clusterIP None, port matches gitServer.service.port', () => {
    const docs = helmTemplate([
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
    ]);
    const headless = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === `${STS_NAME}-headless`,
    );
    expect(headless?.spec?.clusterIP).toBe('None');
    expect(headless?.spec?.selector?.['app.kubernetes.io/name']).toBe(STS_NAME);
    const ports = headless?.spec?.ports ?? [];
    expect(ports.length).toBe(1);
    expect(ports[0]?.port).toBe(7780);
    expect(ports[0]?.targetPort).toBe('git');
  });

  it('NetworkPolicy: ingress from host only, egress empty', () => {
    const docs = helmTemplate([
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
    ]);
    const np = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' && d.metadata?.name === `${STS_NAME}-network`,
    );
    expect(np).toBeDefined();
    expect(np?.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name']).toBe(STS_NAME);
    expect(np?.spec?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(np?.spec?.egress).toEqual([]);

    const ingress = np?.spec?.ingress ?? [];
    expect(ingress.length).toBe(1);
    const from = ingress[0]?.from ?? [];
    expect(from.length).toBe(1);
    expect(
      from[0]?.podSelector?.matchLabels?.['app.kubernetes.io/name'],
    ).toBe('ax-test-ax-next-host');
  });

  it('gitServer.enabled=true without gitServer.storage → required-value failure', () => {
    const r = helmTemplateExpectFailure([
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=',
    ]);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(/gitServer\.storage is required/);
  });

  it('terminationGracePeriodSeconds=20 → render fails with explicit message', () => {
    const r = helmTemplateExpectFailure([
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
      '--set', 'gitServer.terminationGracePeriodSeconds=20',
    ]);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(
      /gitServer\.terminationGracePeriodSeconds must be >= 35/,
    );
  });
});

/**
 * Pull the host Deployment's env array out of a parsed render. Loose typing —
 * tests narrow on `name` and `value`/`valueFrom`.
 */
type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: Record<string, unknown>;
};

function findHostEnv(docs: K8sDoc[]): EnvVar[] {
  const host = docs.find(
    (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
  );
  if (!host) throw new Error('host Deployment not found in render');
  const containers = (host.spec as { template?: { spec?: { containers?: Array<{ env?: EnvVar[] }> } } })
    ?.template?.spec?.containers;
  return containers?.[0]?.env ?? [];
}

describeIfHelm('ax-next chart: workspace.backend wiring', () => {
  it('backend=local (default): host has AX_WORKSPACE_ROOT only', () => {
    const docs = helmTemplate([]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);

    expect(names).toContain('AX_WORKSPACE_BACKEND');
    expect(env.find((e) => e.name === 'AX_WORKSPACE_BACKEND')?.value).toBe('local');
    expect(names).toContain('AX_WORKSPACE_ROOT');
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_URL');
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_TOKEN');
  });

  it('backend=git-protocol + gitServer.enabled: host has AX_WORKSPACE_GIT_SERVER_*, StatefulSet renders', () => {
    const docs = helmTemplate([
      '--set', 'workspace.backend=git-protocol',
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
    ]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));

    expect(byName.AX_WORKSPACE_BACKEND?.value).toBe('git-protocol');
    expect(byName.AX_WORKSPACE_GIT_SERVER_URL?.value).toBe(
      `http://${STS_NAME}.default.svc.cluster.local:7780`,
    );
    expect(byName.AX_WORKSPACE_GIT_SERVER_TOKEN?.valueFrom).toBeDefined();
    expect(names).not.toContain('AX_WORKSPACE_ROOT');

    const clusterIp = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === STS_NAME,
    );
    expect(clusterIp, 'ClusterIP Service renders').toBeDefined();
    expect(clusterIp?.spec?.clusterIP).not.toBe('None');

    const sts = docs.find(
      (d) => d.kind === 'StatefulSet' && d.metadata?.name === STS_NAME,
    );
    expect(sts, 'StatefulSet renders').toBeDefined();

    // Host pod does NOT mount the workspace PVC (no local storage needed).
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
    );
    const volumes =
      (host?.spec as { template?: { spec?: { volumes?: Array<{ name?: string }> } } })?.template
        ?.spec?.volumes ?? [];
    expect(volumes.find((v) => v.name === 'workspace')).toBeUndefined();
  });

  it('backend=git-protocol without gitServer.enabled → render fails with sanitized error', () => {
    // Guardrail: the host pod would otherwise boot pointing at a Service
    // that doesn't render. Better to fail the install than discover this
    // at first workspace op.
    const r = helmTemplateExpectFailure([
      '--set', 'workspace.backend=git-protocol',
    ]);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(
      /workspace\.backend=git-protocol requires gitServer\.enabled=true/,
    );
  });

  it('backend=git-protocol: host egress NetworkPolicy opens a rule to the git-server tier', () => {
    // Without this rule, the host pod's @ax/workspace-git-server traffic is
    // denied at the CNI layer when networkPolicies.enabled=true (the default).
    // Render succeeds, the operator ships, every workspace op fails with an
    // opaque connection error.
    const docs = helmTemplate([
      '--set', 'workspace.backend=git-protocol',
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
    ]);

    const hostNp = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        d.metadata?.name === 'ax-test-ax-next-host-network',
    );
    expect(hostNp, 'host NetworkPolicy renders').toBeDefined();

    const egress = (hostNp?.spec?.egress as Array<{
      to?: Array<{
        podSelector?: { matchLabels?: Record<string, string> };
      }>;
      ports?: Array<{ port?: number; protocol?: string }>;
    }>) ?? [];

    const tierRule = egress.find((r) =>
      (r.to ?? []).some(
        (t) => t.podSelector?.matchLabels?.['app.kubernetes.io/name'] === STS_NAME,
      ),
    );
    expect(
      tierRule,
      'host egress includes a rule selecting the git-server tier',
    ).toBeDefined();
    expect(tierRule?.ports?.[0]?.port).toBe(7780);
    expect(tierRule?.ports?.[0]?.protocol).toBe('TCP');
  });
});
