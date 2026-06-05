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

import { HELM_REQUIRED_MESSAGE, resolveHelmGate } from './helm-required.js';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');

/** Stable required values so each test only sets what it's actually checking. */
const REQUIRED = [
  '--set',
  'credentials.key=test',
  '--set',
  'anthropic.apiKey=test',
  // Required since issue #39: http-server's cookie signing key. 64-hex-char
  // zero is fine for chart-render tests; these never boot the host.
  // (Auth-provider env is gone since Phase 3 — auth-better is DB-driven.)
  '--set',
  'http.cookieKey=0000000000000000000000000000000000000000000000000000000000000000',
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

const GATE = resolveHelmGate(HELM, process.env.AX_REQUIRE_HELM);
const describeIfHelm = GATE.mode === 'run' ? describe : describe.skip;

if (GATE.mode === 'skip') {
  console.warn(
    'helm CLI not available; chart-render tests skipped — run with helm in PATH for full coverage',
  );
}

// AX_REQUIRE_HELM=1 (CI's helm-render lane): helm absent is a hard failure, not
// a silent skip. This is the regression guard — without it, dropping helm from
// CI would make the guard suite green-but-empty again (the TASK-1 defect).
if (GATE.mode === 'require-missing') {
  describe('chart-render guards: helm required', () => {
    it('helm must be installed when AX_REQUIRE_HELM is set', () => {
      throw new Error(HELM_REQUIRED_MESSAGE);
    });
  });
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
//
// Bitnami's chart repo intermittently returns an empty index.yaml on CI
// (Bitnami's migration in late 2025 left their public endpoint flaky), so
// `helm dependency build` fails with "error loading bitnami-index.yaml:
// empty index.yaml file". Wrap the add+build sequence in a small retry —
// a fresh `--force-update` re-pull usually returns a populated index on
// the second attempt.
function helmRepoSync(): { ok: true } | { ok: false; reason: string } {
  if (HELM === null) return { ok: true };
  const repoAdd = spawnSync(
    HELM,
    ['repo', 'add', '--force-update', 'bitnami', 'https://charts.bitnami.com/bitnami'],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (repoAdd.status !== 0) {
    return { ok: false, reason: `helm repo add bitnami exit ${repoAdd.status}: ${repoAdd.stderr ?? ''}` };
  }
  const r = spawnSync(HELM, ['dependency', 'build', chartDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.status !== 0) {
    return { ok: false, reason: `helm dependency build exit ${r.status}: ${r.stderr ?? ''}` };
  }
  return { ok: true };
}

beforeAll(() => {
  if (!HELM) return;
  const attempts = 3;
  let lastReason = '';
  for (let i = 0; i < attempts; i += 1) {
    const out = helmRepoSync();
    if (out.ok) return;
    lastReason = out.reason;
  }
  throw new Error(`helm dependency build failed after ${attempts} attempts: ${lastReason}`);
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

  it('backend=local: host has AX_SKILLS_BUNDLE_ROOT under the workspace PVC (TASK-40)', () => {
    const docs = helmTemplate([]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));

    expect(names).toContain('AX_SKILLS_BUNDLE_ROOT');
    const mountPath = byName.AX_WORKSPACE_ROOT?.value;
    expect(mountPath).toBeDefined();
    // The bundle repo is a sibling dir on the same workspace PVC.
    expect(byName.AX_SKILLS_BUNDLE_ROOT?.value).toBe(`${mountPath}/skill-bundles`);
  });

  it('backend=git-protocol: host has no AX_SKILLS_BUNDLE_ROOT (TASK-40)', () => {
    const docs = helmTemplate([
      '--set', 'workspace.backend=git-protocol',
      '--set', 'gitServer.enabled=true',
      '--set', 'gitServer.storage=10Gi',
    ]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);
    expect(names).not.toContain('AX_SKILLS_BUNDLE_ROOT');
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

describeIfHelm('ax-next chart: titles.model wiring', () => {
  it('default: AX_TITLE_MODEL renders the values.yaml default', () => {
    const docs = helmTemplate([]);
    const env = findHostEnv(docs);
    const found = env.find((e) => e.name === 'AX_TITLE_MODEL');
    expect(found, 'AX_TITLE_MODEL env var present').toBeDefined();
    expect(found?.value).toBe('anthropic/claude-haiku-4-5-20251001');
  });

  it('overrides: titles.model=<value> stamps that value into the env', () => {
    const docs = helmTemplate([
      '--set', 'titles.model=anthropic/claude-sonnet-4-7',
    ]);
    const env = findHostEnv(docs);
    const found = env.find((e) => e.name === 'AX_TITLE_MODEL');
    expect(found?.value).toBe('anthropic/claude-sonnet-4-7');
  });
});

describeIfHelm('ax-next chart: single-replica chat guard (ARCH-1)', () => {
  // The web chat surface is single-replica-only: @ax/channel-web buffers SSE
  // chunks in an in-process per-reqId ring (chunk-buffer.ts) and the
  // chat:stream-chunk fan-in is replica-local. `replicas: 1` + Recreate are
  // the chart defaults, but without a render-time guard `--set replicas=2`
  // would ship a valid-looking Deployment that silently breaks chat. The
  // guard makes the unsupported config fail loudly at `helm template`.

  it('replicas unset (default): host Deployment renders with replicas: 1', () => {
    const docs = helmTemplate([]);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
    );
    expect(host, 'host Deployment renders').toBeDefined();
    expect(host?.spec?.replicas).toBe(1);
  });

  it('replicas=1 (explicit): renders fine with replicas: 1', () => {
    const docs = helmTemplate(['--set', 'replicas=1']);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
    );
    expect(host?.spec?.replicas).toBe(1);
  });

  it('replicas=2 → render fails with the single-replica chat message', () => {
    const r = helmTemplateExpectFailure(['--set', 'replicas=2']);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(/replicas must be 1/);
    // Names the actual gap so the operator knows WHY, not just THAT.
    expect(r.stderr).toMatch(/chat/i);
  });

  it('replicas=5 → render also fails (any value > 1)', () => {
    const r = helmTemplateExpectFailure(['--set', 'replicas=5']);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(/replicas must be 1/);
  });
});

// TASK-149: the credential-proxy TCP-Service posture (production gVisor).
// Mirrors the issue-#39 listener-split contract — the chart shape IS the
// boundary contract, so we assert the rendered Service + NetworkPolicy egress
// + host env in TCP mode and their absence in the default (hostPath) mode.
describeIfHelm('ax-next chart: credential-proxy TCP Service (TASK-149)', () => {
  const PROXY_SVC = 'ax-test-ax-next-proxy';
  const HOST_DEPLOY = 'ax-test-ax-next-host';
  const SANDBOX_NP = 'ax-test-ax-next-sandbox-restrict';

  const tcpArgs = [
    '--set', 'credentialProxy.tcp.enabled=true',
    '--set', 'credentialProxy.tcp.port=8888',
  ];

  it('default (hostPath posture): NO proxy Service renders', () => {
    const docs = helmTemplate([]);
    const svc = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === PROXY_SVC,
    );
    expect(svc, 'no proxy Service in hostPath mode').toBeUndefined();
  });

  it('TCP mode: a ClusterIP proxy Service fronts the proxy port, selecting the host pod', () => {
    const docs = helmTemplate(tcpArgs);
    const svc = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === PROXY_SVC,
    );
    expect(svc, 'proxy Service renders in TCP mode').toBeDefined();
    expect(svc?.spec?.type).toBe('ClusterIP');
    // Selects the HOST pod (the proxy listens inside the host container) —
    // the same stable selector label the host Service uses.
    expect(svc?.spec?.selector?.['app.kubernetes.io/name']).toBe('ax-test-ax-next-host');
    const ports = svc?.spec?.ports ?? [];
    expect(ports.some((p: { port?: number }) => p.port === 8888)).toBe(true);
  });

  it('TCP mode: the proxy Service name does NOT collide with the host Service under a long fullnameOverride (codex P2b)', () => {
    // Regression: `printf "%s-proxy" fullname | trunc 63` truncates AFTER
    // appending, so a 62-63 char fullname loses the `-proxy` suffix and the
    // proxy Service renders with the SAME name as the host Service — helm then
    // refuses two Services with one name. The helper must reserve the suffix
    // before truncating (like the git-server-experimental helper).
    const longName = 'a'.repeat(62);
    const docs = helmTemplate([
      ...tcpArgs,
      '--set', `fullnameOverride=${longName}`,
    ]);
    const services = docs.filter((d) => d.kind === 'Service');
    const names = services.map((s) => s.metadata?.name);
    // No two Services may share a name (helm refuses a duplicate-name install).
    expect(new Set(names).size, `Service names must be unique: ${names.join(', ')}`).toBe(
      names.length,
    );
    // The proxy Service must render with its own distinct, suffix-preserved name.
    const proxySvc = services.find(
      (s) => s.metadata?.labels?.['ax.io/service'] === 'credential-proxy',
    );
    expect(proxySvc, 'proxy Service renders').toBeDefined();
    expect(proxySvc?.metadata?.name, 'proxy name keeps a -proxy-derived form').toMatch(
      /-proxy$/,
    );
  });

  it('TCP mode: host Deployment stamps the TCP proxy env (K8S_PROXY_ENDPOINT + AX_PROXY_TCP_PORT + AX_PROXY_ADVERTISED_ENDPOINT) and NOT the hostPath env', () => {
    const docs = helmTemplate(tcpArgs);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === HOST_DEPLOY,
    );
    const env: Array<{ name: string; value?: string }> =
      host?.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(byName.AX_PROXY_TCP_PORT).toBe('8888');
    expect(byName.AX_PROXY_ADVERTISED_ENDPOINT).toMatch(
      /^tcp:\/\/ax-test-ax-next-proxy\..*\.svc\.cluster\.local:8888$/,
    );
    expect(byName.K8S_PROXY_ENDPOINT).toMatch(
      /^http:\/\/ax-test-ax-next-proxy\..*\.svc\.cluster\.local:8888$/,
    );
    // The hostPath-only env must NOT appear in TCP mode.
    expect(env.find((e) => e.name === 'K8S_PROXY_SOCKET_HOST_PATH')).toBeUndefined();
  });

  it('TCP mode: NO proxy-socket hostPath volume on the host pod', () => {
    const docs = helmTemplate(tcpArgs);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === HOST_DEPLOY,
    );
    const vols: Array<{ name: string; hostPath?: unknown }> =
      host?.spec?.template?.spec?.volumes ?? [];
    const proxyVol = vols.find((v) => v.name === 'proxy-socket');
    // The proxy-socket volume may still exist as an emptyDir (host listener
    // local), but it must NOT be a hostPath in TCP mode.
    if (proxyVol) {
      expect(proxyVol.hostPath, 'proxy-socket must not be hostPath in TCP mode').toBeUndefined();
    }
  });

  it('TCP mode: the host-network NetworkPolicy admits runner INGRESS on the proxy port (else CNI denies the connect)', () => {
    // Regression (codex P1): the sandbox-restrict egress rule opens the
    // RUNNER side, but the host pod's own ingress policy must also admit the
    // proxy port — otherwise packets to the proxy Service's target port are
    // denied at the CNI layer before reaching the host container, and every
    // TCP-mode proxy connect fails despite a correct AX_PROXY_ENDPOINT.
    const docs = helmTemplate([...tcpArgs, '--set', 'networkPolicies.enabled=true']);
    const np = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        d.metadata?.name === 'ax-test-ax-next-host-network',
    );
    expect(np, 'host-network NetworkPolicy renders').toBeDefined();
    const ingress: Array<{
      from?: Array<{ podSelector?: { matchLabels?: Record<string, string> } }>;
      ports?: Array<{ port?: number; protocol?: string }>;
    }> = np?.spec?.ingress ?? [];
    // A rule that admits the proxy port FROM runner pods (ax.io/plane: execution).
    const runnerProxyIngress = ingress.some(
      (rule) =>
        (rule.from ?? []).some(
          (f) => f.podSelector?.matchLabels?.['ax.io/plane'] === 'execution',
        ) && (rule.ports ?? []).some((p) => p.port === 8888 && p.protocol === 'TCP'),
    );
    expect(runnerProxyIngress, 'host admits runner ingress on the proxy port').toBe(true);
  });

  it('default (hostPath posture): the host-network NetworkPolicy has NO proxy ingress rule', () => {
    const docs = helmTemplate(['--set', 'networkPolicies.enabled=true']);
    const np = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        d.metadata?.name === 'ax-test-ax-next-host-network',
    );
    const ingress: Array<{ ports?: Array<{ port?: number }> }> = np?.spec?.ingress ?? [];
    const hasProxyPort = ingress.some((rule) =>
      (rule.ports ?? []).some((p) => p.port === 8888),
    );
    expect(hasProxyPort, 'no proxy ingress rule in hostPath mode').toBe(false);
  });

  it('TCP mode: the sandbox-restrict NetworkPolicy adds an egress rule to the proxy Service port', () => {
    const docs = helmTemplate([...tcpArgs, '--set', 'networkPolicies.enabled=true']);
    const np = docs.find(
      (d) => d.kind === 'NetworkPolicy' && d.metadata?.name === SANDBOX_NP,
    );
    expect(np, 'sandbox-restrict NetworkPolicy renders').toBeDefined();
    const egress: Array<{ ports?: Array<{ port?: number; protocol?: string }> }> =
      np?.spec?.egress ?? [];
    const reachesProxyPort = egress.some((rule) =>
      (rule.ports ?? []).some((p) => p.port === 8888 && p.protocol === 'TCP'),
    );
    expect(reachesProxyPort, 'runner egress reaches the proxy TCP port').toBe(true);
  });

  it('default (hostPath posture): the sandbox-restrict NetworkPolicy has NO proxy egress rule', () => {
    const docs = helmTemplate(['--set', 'networkPolicies.enabled=true']);
    const np = docs.find(
      (d) => d.kind === 'NetworkPolicy' && d.metadata?.name === SANDBOX_NP,
    );
    expect(np).toBeDefined();
    const egress: Array<{ ports?: Array<{ port?: number }> }> = np?.spec?.egress ?? [];
    const hasProxyPort = egress.some((rule) =>
      (rule.ports ?? []).some((p) => p.port === 8888),
    );
    expect(hasProxyPort, 'no proxy egress rule in hostPath mode').toBe(false);
  });
});

// TASK-157 — dev-services in the runner sandbox render as native k8s sidecars
// (initContainers with restartPolicy: Always), which require Kubernetes 1.29+
// (SidecarContainers GA). On older kubelets the restartPolicy is ignored and
// the service runs as a BLOCKING init container, hanging the pod. The chart's
// `ax-next.validateDevServicesKubeVersion` preflight fails fast when the
// operator declares dev-services intent (sandbox.devServices.enabled=true) on a
// cluster that can't be confirmed 1.29+.
//
// NOTE on `helm template` + `.Capabilities.KubeVersion`: with no `--kube-version`
// flag, helm uses its BUILT-IN stub version (v1.28.0 in the pinned CI helm),
// which is below 1.29 — so the "enabled, no kube-version" case is expected to
// FAIL. The tests pass `--kube-version` explicitly to exercise both sides of the
// 1.29 boundary deterministically, independent of which helm build runs them.
describeIfHelm('ax-next chart: dev-services k8s 1.29+ guard (TASK-157)', () => {
  it('default values (devServices disabled): renders cleanly, guard is inert', () => {
    // The whole rest of the suite already renders with devServices off; this
    // asserts the guard adds nothing to the default posture even when the
    // built-in stub version is < 1.29.
    const docs = helmTemplate([]);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
    );
    expect(host, 'host Deployment renders with devServices off').toBeDefined();
  });

  it('devServices.enabled=true on a < 1.29 cluster → render fails with the 1.29+ message', () => {
    const r = helmTemplateExpectFailure([
      '--set', 'sandbox.devServices.enabled=true',
      '--kube-version', '1.27.0',
    ]);
    expect(r.status, 'helm template should fail on an old cluster').not.toBe(0);
    expect(r.stderr).toMatch(/requires Kubernetes 1\.29\+/);
    // The failure mode is spelled out so an operator hitting this knows WHY.
    expect(r.stderr).toMatch(/BLOCKING init container/);
    expect(r.stderr).toMatch(/skipKubeVersionCheck/);
  });

  it('devServices.enabled=true on a 1.29+ cluster → renders cleanly', () => {
    const docs = helmTemplate([
      '--set', 'sandbox.devServices.enabled=true',
      '--kube-version', '1.29.4',
    ]);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
    );
    expect(host, 'host Deployment renders on a 1.29+ cluster').toBeDefined();
  });

  it('devServices.enabled=true on a newer cluster (1.30) → renders cleanly', () => {
    const docs = helmTemplate([
      '--set', 'sandbox.devServices.enabled=true',
      '--kube-version', '1.30.2',
    ]);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
    );
    expect(host, 'host Deployment renders on a 1.30 cluster').toBeDefined();
  });

  it('skipKubeVersionCheck=true bypasses the guard even on a < 1.29 cluster', () => {
    const docs = helmTemplate([
      '--set', 'sandbox.devServices.enabled=true',
      '--set', 'sandbox.devServices.skipKubeVersionCheck=true',
      '--kube-version', '1.27.0',
    ]);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === 'ax-test-ax-next-host',
    );
    expect(host, 'escape hatch lets the render through').toBeDefined();
  });
});

describeIfHelm('ax-next chart: ingress backend port (GKE ingress fix)', () => {
  // Regression: the Ingress backend targeted a service port named `http`,
  // but the host Service only exposes `ipc` and `public-http`. A GCE/any
  // Ingress pointing at a non-existent port name wires no backend — the LB
  // returns 404/502 and there's no loud failure. The fix points the backend
  // at `public-http` (the public surface). This guard pins the wiring so it
  // can't silently rebreak.
  const HOST_SVC = 'ax-test-ax-next-host';
  const ingressArgs = [
    '--set', 'ingress.enabled=true',
    '--set', 'ingress.host=ax.example.com',
  ];

  it('ingress.enabled=true: backend targets the host Service port named public-http', () => {
    const docs = helmTemplate(ingressArgs);
    const ing = docs.find((d) => d.kind === 'Ingress');
    expect(ing, 'Ingress renders when enabled').toBeDefined();
    const backend =
      ing?.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service;
    expect(backend?.name).toBe(HOST_SVC);
    expect(backend?.port?.name).toBe('public-http');
  });

  it('the public-http port name actually exists on the host Service (cross-check)', () => {
    // Belt-and-suspenders: the backend port name is only meaningful if the
    // Service truly publishes it. Assert both halves from one render so a
    // future rename of the Service port can't desync the Ingress.
    const docs = helmTemplate(ingressArgs);
    const svc = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === HOST_SVC,
    );
    const portNames = (svc?.spec?.ports ?? []).map(
      (p: { name?: string }) => p.name,
    );
    expect(portNames).toContain('public-http');

    const ing = docs.find((d) => d.kind === 'Ingress');
    const backendPortName =
      ing?.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service?.port?.name;
    expect(portNames).toContain(backendPortName);
  });

  it('ingress.enabled=false (default): no Ingress renders', () => {
    const docs = helmTemplate([]);
    expect(docs.find((d) => d.kind === 'Ingress')).toBeUndefined();
  });
});

describeIfHelm('ax-next chart: serve /chat bearer token (AX_SERVE_TOKEN)', () => {
  // `serve.existingSecret` wires AX_SERVE_TOKEN from an operator-created Secret so
  // POST /chat requires a bearer token. Default-empty preserves the current
  // (open, with a boot warning) behaviour so nothing breaks for port-forward
  // deploys; a public-ingress deploy is expected to set it.
  it('default: no AX_SERVE_TOKEN env (open /chat preserved, no breakage)', () => {
    const env = findHostEnv(helmTemplate([]));
    expect(env.find((e) => e.name === 'AX_SERVE_TOKEN')).toBeUndefined();
  });

  it('serve.existingSecret set: AX_SERVE_TOKEN sourced from that Secret, key defaults to token', () => {
    const env = findHostEnv(helmTemplate(['--set', 'serve.existingSecret=my-serve-secret']));
    const t = env.find((e) => e.name === 'AX_SERVE_TOKEN');
    const ref = (t?.valueFrom as { secretKeyRef?: { name?: string; key?: string } } | undefined)
      ?.secretKeyRef;
    expect(ref?.name).toBe('my-serve-secret');
    expect(ref?.key).toBe('token');
  });

  it('serve.secretKey overrides the Secret key', () => {
    const env = findHostEnv(
      helmTemplate(['--set', 'serve.existingSecret=my-serve-secret', '--set', 'serve.secretKey=bearer']),
    );
    const t = env.find((e) => e.name === 'AX_SERVE_TOKEN');
    const ref = (t?.valueFrom as { secretKeyRef?: { key?: string } } | undefined)?.secretKeyRef;
    expect(ref?.key).toBe('bearer');
  });
});

describeIfHelm('ax-next chart: host RBAC Role (TASK-160)', () => {
  it('grants pods verbs + a narrow pods/log:get for sidecar-failure diagnosis', () => {
    const docs = helmTemplate([]);
    const role = docs.find(
      (d) =>
        d.kind === 'Role' &&
        d.metadata?.name === 'ax-test-ax-next-runner-manager',
    );
    expect(role, 'host runner-manager Role renders').toBeDefined();
    const rules = (role!.rules ?? []) as Array<{
      resources?: string[];
      verbs?: string[];
    }>;
    const podsRule = rules.find((r) => (r.resources ?? []).includes('pods'));
    expect(podsRule?.verbs?.sort()).toEqual(
      ['create', 'delete', 'get', 'list', 'watch'].sort(),
    );
    // pods/log is granted ONLY `get` (TASK-160) — no list/watch/follow.
    const logRule = rules.find((r) => (r.resources ?? []).includes('pods/log'));
    expect(logRule, 'pods/log rule present').toBeDefined();
    expect(logRule!.verbs).toEqual(['get']);
    // Defense-in-depth: still no exec/attach/portforward anywhere in the Role.
    const allResources = rules.flatMap((r) => r.resources ?? []);
    expect(allResources).not.toContain('pods/exec');
    expect(allResources).not.toContain('pods/attach');
    expect(allResources).not.toContain('pods/portforward');
  });
});
