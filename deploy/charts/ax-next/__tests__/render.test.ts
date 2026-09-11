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
import { describe, expect, it } from 'vitest';

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

// The subchart tarballs (postgresql) that `helm template` needs in charts/ are
// fetched once per run by vitest's globalSetup — see __tests__/helm-deps.ts.
// This file used to do it from its own `beforeAll`, as did blob-backend and
// env-shape; three parallel copies raced on the shared helm cache (TASK-316).

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
    // Trailing dot on `svc.cluster.local.` is REQUIRED — see the
    // ax-next.hostIpcUrl helper. It makes the name absolute so the runner's
    // resolver skips the ndots:5 search-domain walk that, on gVisor, times out
    // the 5s session.get-config IPC and kills the runner at boot.
    expect(byName.AX_PROXY_ADVERTISED_ENDPOINT).toMatch(
      /^tcp:\/\/ax-test-ax-next-proxy\..*\.svc\.cluster\.local\.:8888$/,
    );
    expect(byName.K8S_PROXY_ENDPOINT).toMatch(
      /^http:\/\/ax-test-ax-next-proxy\..*\.svc\.cluster\.local\.:8888$/,
    );
    // The hostPath-only env must NOT appear in TCP mode.
    expect(env.find((e) => e.name === 'K8S_PROXY_SOCKET_HOST_PATH')).toBeUndefined();
  });

  it('host Deployment stamps AX_K8S_HOST_IPC_URL as an ABSOLUTE FQDN (trailing dot) so the runner skips the ndots search-domain walk', () => {
    // Regression: without the trailing dot, the 4-dot service name is relative
    // under the pod's default ndots:5, so the resolver queries every search
    // domain first. On GKE Sandbox (gVisor) those UDP search-miss lookups to
    // kube-dns take ~6s — longer than the runner's 5s session.get-config IPC
    // timeout — so every runner died at boot with `get-config: timeout` while
    // the name itself resolved fine. The trailing dot collapses it to one fast
    // query. This URL becomes AX_RUNNER_ENDPOINT on every runner pod.
    const docs = helmTemplate(tcpArgs);
    const host = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata?.name === HOST_DEPLOY,
    );
    const env: Array<{ name: string; value?: string }> =
      host?.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(byName.AX_K8S_HOST_IPC_URL).toMatch(
      /^http:\/\/ax-test-ax-next-host\..*\.svc\.cluster\.local\.:80$/,
    );
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

describeIfHelm('ax-next chart: LB health-check NetworkPolicy ingress (lbHealthCheckCidrs)', () => {
  // Cloud LBs (GKE GCLB) probe the pod IP directly from provider ranges; with an
  // enforcing CNI those must be admitted on the public surface or the backend
  // shows UNHEALTHY (502s) despite a healthy pod. Empty default = no rule (kind /
  // non-cloud unaffected); the cloud overlay sets the ranges.
  const HOST_NP = 'ax-test-ax-next-host-network';

  it('default (empty): host NetworkPolicy has NO ipBlock health-check rule', () => {
    const docs = helmTemplate(['--set', 'networkPolicies.enabled=true']);
    const np = docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === HOST_NP);
    const ingress = (np?.spec?.ingress ?? []) as Array<{
      from?: Array<{ ipBlock?: { cidr?: string } }>;
    }>;
    expect(ingress.some((r) => (r.from ?? []).some((f) => f.ipBlock))).toBe(false);
  });

  it('lbHealthCheckCidrs set: an ipBlock rule admits those CIDRs on the public-http port', () => {
    const docs = helmTemplate([
      '--set', 'networkPolicies.enabled=true',
      '--set-json', 'networkPolicies.lbHealthCheckCidrs=["35.191.0.0/16","130.211.0.0/22"]',
    ]);
    const np = docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === HOST_NP);
    const ingress = (np?.spec?.ingress ?? []) as Array<{
      from?: Array<{ ipBlock?: { cidr?: string } }>;
      ports?: Array<{ port?: number; protocol?: string }>;
    }>;
    const rule = ingress.find((r) => (r.from ?? []).some((f) => f.ipBlock));
    expect(rule, 'health-check ipBlock rule present').toBeDefined();
    const cidrs = (rule?.from ?? []).map((f) => f.ipBlock?.cidr);
    expect(cidrs).toContain('35.191.0.0/16');
    expect(cidrs).toContain('130.211.0.0/22');
    // Admitted on the public surface (9090), not the IPC port.
    expect(rule?.ports?.some((p) => p.port === 9090 && p.protocol === 'TCP')).toBe(true);
  });
});

describeIfHelm('ax-next chart: GKE BackendConfig + SSE timeout (TASK-168)', () => {
  // The GCE Application LB defaults backend timeoutSec=30, which cuts long-lived
  // SSE chat streams mid-answer ("Connection lost"). The fix is a BackendConfig
  // (cloud.google.com/v1) with a generous timeoutSec + the host Service's
  // cloud.google.com/backend-config annotation binding the LB backend to it.
  // Templating both into the chart (gated behind ingress.backendConfig.enabled)
  // keeps them surviving `helm upgrade` — a hand-applied annotation drops on the
  // next re-render and the timeout silently reverts to 30s. The CRD is GKE-only
  // (kind has no cloud.google.com/v1 type), so it must stay off by default.
  const HOST_SVC = 'ax-test-ax-next-host';
  const BC_NAME = 'ax-test-ax-next-host-bc';
  const bcArgs = ['--set', 'ingress.backendConfig.enabled=true'];

  it('default (off): no BackendConfig renders', () => {
    const docs = helmTemplate([]);
    const bc = docs.find((d) => d.kind === 'BackendConfig');
    expect(bc, 'no BackendConfig in the default (non-GKE) posture').toBeUndefined();
  });

  it('default (off): host Service has NO backend-config annotation', () => {
    const docs = helmTemplate([]);
    const svc = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === HOST_SVC,
    );
    expect(svc, 'host Service renders').toBeDefined();
    expect(svc?.metadata?.annotations?.['cloud.google.com/backend-config']).toBeUndefined();
  });

  it('enabled: a BackendConfig renders with apiVersion cloud.google.com/v1 and the default timeoutSec=3600', () => {
    const docs = helmTemplate(bcArgs);
    const bc = docs.find((d) => d.kind === 'BackendConfig');
    expect(bc, 'BackendConfig renders when enabled').toBeDefined();
    expect(bc?.apiVersion).toBe('cloud.google.com/v1');
    expect(bc?.metadata?.name).toBe(BC_NAME);
    expect(bc?.spec?.timeoutSec).toBe(3600);
  });

  it('enabled: ingress.backendConfig.timeoutSec overrides the default', () => {
    const docs = helmTemplate([...bcArgs, '--set', 'ingress.backendConfig.timeoutSec=120']);
    const bc = docs.find((d) => d.kind === 'BackendConfig');
    expect(bc?.spec?.timeoutSec).toBe(120);
  });

  it('enabled: host Service carries the backend-config annotation pointing at the BackendConfig name', () => {
    const docs = helmTemplate(bcArgs);
    const svc = docs.find(
      (d) => d.kind === 'Service' && d.metadata?.name === HOST_SVC,
    );
    const annotation = svc?.metadata?.annotations?.['cloud.google.com/backend-config'];
    expect(annotation, 'backend-config annotation present').toBeDefined();
    // The value is the JSON GKE expects: {"default":"<bc-name>"}.
    const parsed = JSON.parse(annotation as string);
    expect(parsed).toEqual({ default: BC_NAME });

    // Cross-check: the annotation must reference the SAME name the BackendConfig
    // renders with, or the LB binds to a backend object that doesn't exist.
    const bc = docs.find((d) => d.kind === 'BackendConfig');
    expect(parsed.default).toBe(bc?.metadata?.name);
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

// TASK-169: `auth.secret` value lets an operator SUPPLY AX_AUTH_SECRET at install
// instead of accepting a chart-generated random one. The pain: standing up a fresh
// cluster against an existing DB (the GKE Autopilot→Standard migration, PR #330)
// mints a NEW auth-secret, so every Google-linked account can no longer decrypt its
// stored OAuth tokens → broken logins. The value collapses the old backup+kubectl
// patch workaround to one `--set`. It mirrors credentials-key/http-cookie-key:
// existing in-cluster value wins → else `--set auth.secret | b64enc` → else
// randBytes (today's default, preserved so fresh installs still work without it).
describeIfHelm('ax-next chart: auth.secret value (TASK-169)', () => {
  const SECRET_NAME = 'ax-test-ax-next-secrets';

  /** Pull the rendered host Secret's data map. */
  function secretData(extraArgs: readonly string[]): Record<string, string> {
    const docs = helmTemplate(extraArgs);
    const secret = docs.find(
      (d) => d.kind === 'Secret' && d.metadata?.name === SECRET_NAME,
    );
    expect(secret, 'host Secret renders').toBeDefined();
    return (secret!.data ?? {}) as Record<string, string>;
  }

  it('default (no --set auth.secret): auth-secret is auto-generated and non-empty', () => {
    const data = secretData([]);
    expect(data['auth-secret'], 'auth-secret key present').toBeDefined();
    // 32 bytes base64 = 44 chars (ending in `=`). Just assert non-trivial length;
    // we don't pin the exact value (it's random).
    expect((data['auth-secret'] ?? '').length).toBeGreaterThan(20);
  });

  it('--set auth.secret=<raw>: data.auth-secret is base64(<raw>)', () => {
    const raw = 'my-operator-supplied-auth-secret-value';
    const data = secretData(['--set', `auth.secret=${raw}`]);
    expect(data['auth-secret']).toBe(Buffer.from(raw, 'utf8').toString('base64'));
  });

  it('--set auth.secret is deterministic across renders (the value path, not random)', () => {
    const raw = 'stable-secret-across-renders';
    const a = secretData(['--set', `auth.secret=${raw}`]);
    const b = secretData(['--set', `auth.secret=${raw}`]);
    expect(a['auth-secret']).toBe(b['auth-secret']);
    expect(a['auth-secret']).toBe(Buffer.from(raw, 'utf8').toString('base64'));
  });

  it('auto-gen path stays RANDOM: two default renders differ (we did not break generation)', () => {
    const a = secretData([]);
    const b = secretData([]);
    expect(a['auth-secret']).not.toBe(b['auth-secret']);
  });

  it('credentials-key / http-cookie-key are unaffected (still b64enc of the --set value)', () => {
    // Guards that adding the auth.secret branch didn't disturb the sibling keys.
    const raw = 'whatever';
    const data = secretData(['--set', `auth.secret=${raw}`]);
    // REQUIRED passes credentials.key=test, http.cookieKey=000...0
    expect(data['credentials-key']).toBe(Buffer.from('test', 'utf8').toString('base64'));
    expect(data['http-cookie-key']).toBe(
      Buffer.from('0'.repeat(64), 'utf8').toString('base64'),
    );
  });
});

// The agent-centric workspace surface (TASK-325). The whole UI shipped in the
// image on 2026-08-24 and no operator could turn it on: the preset gates route
// registration on AX_AGENT_WORKSPACE_PREVIEW, and the chart had no value for
// it, so `helm show values` never mentioned it and enabling it took a
// hand-written `host.env` block in a gitignored overlay.
//
// Nothing caught that, and the reason is worth keeping: the env-shape guard's
// two gates are "every REQUIRED var is stamped" and "every stamped var is
// read". This var is read as a bare `process.env` lookup and is OPTIONAL, so
// it fell between both. These assertions are the replacement — and the OFF
// case is the load-bearing one, because a flag that silently defaults ON is a
// capability nobody granted.
describeIfHelm('ax-next chart: channelWeb.agentWorkspace', () => {
  function hostEnvEntries(docs: K8sDoc[]): Array<{ name: string; value?: string }> {
    const dep = docs.find(
      (d) => d.kind === 'Deployment' && /-host$/.test(String(d.metadata?.name ?? '')),
    );
    const containers =
      ((dep?.spec as { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } })
        ?.template?.spec?.containers) ?? [];
    return containers[0]?.env ?? [];
  }

  it('does NOT stamp AX_AGENT_WORKSPACE_PREVIEW by default', () => {
    // `/api/workspace/*` is never registered without this, so an absent var is
    // a real capability boundary and not a cosmetic default (invariant #5).
    expect(
      hostEnvEntries(helmTemplate([])).filter(
        (e) => e.name === 'AX_AGENT_WORKSPACE_PREVIEW',
      ),
    ).toEqual([]);
  });

  it('stamps it exactly once, as "1", when opted in', () => {
    const entries = hostEnvEntries(
      helmTemplate(['--set', 'channelWeb.agentWorkspace=true']),
    ).filter((e) => e.name === 'AX_AGENT_WORKSPACE_PREVIEW');
    // Exactly once: an operator mid-migration may still carry the legacy
    // `host.env` entry, and two entries with the same name is legal YAML whose
    // winner depends on template ordering. If this ever reads 2, the values
    // comment telling operators to remove the old block is being ignored.
    expect(entries).toEqual([{ name: 'AX_AGENT_WORKSPACE_PREVIEW', value: '1' }]);
  });

  it('is independent of channelWeb.enabled — the SPA and the surface are separate', () => {
    // The bundle being served and the workspace ROUTES existing are two
    // different grants; a headless deploy could want the API surface without
    // the SPA, and serving the SPA must not silently mount the routes.
    const entries = hostEnvEntries(
      helmTemplate([
        '--set',
        'channelWeb.enabled=false',
        '--set',
        'channelWeb.agentWorkspace=true',
      ]),
    ).filter((e) => e.name === 'AX_AGENT_WORKSPACE_PREVIEW');
    expect(entries).toHaveLength(1);
  });
});

// filestore-user-files (design §4/§9) — Filestore config env stamping + the
// scoped NetworkPolicy egress widening.
describeIfHelm('ax-next chart: sandbox.filestore wiring', () => {
  const FILESTORE = [
    '--set', 'sandbox.filestore.server=10.9.8.7',
    '--set', 'sandbox.filestore.exportPath=/vol1',
    '--set', 'sandbox.filestore.mountPath=/files',
  ];

  function hostEnv(docs: K8sDoc[]): Record<string, unknown> {
    const dep = docs.find(
      (d) => d.kind === 'Deployment' && /-host$/.test(String(d.metadata?.name ?? '')),
    );
    const containers =
      ((dep?.spec as { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } })
        ?.template?.spec?.containers) ?? [];
    const env = containers[0]?.env ?? [];
    return Object.fromEntries(env.map((e) => [e.name, e.value]));
  }

  function sandboxRestrict(docs: K8sDoc[]) {
    return docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        String(d.metadata?.name ?? '').endsWith('-sandbox-restrict'),
    );
  }

  it('stamps AX_FILESTORE_* on the host deployment when a Filestore server is set', () => {
    const env = hostEnv(helmTemplate(FILESTORE));
    expect(env.AX_FILESTORE_SERVER).toBe('10.9.8.7');
    expect(env.AX_FILESTORE_EXPORT_PATH).toBe('/vol1');
    expect(env.AX_FILESTORE_MOUNT_PATH).toBe('/files');
  });

  it('omits AX_FILESTORE_* when no Filestore server is configured (default)', () => {
    const env = hostEnv(helmTemplate([]));
    expect(env.AX_FILESTORE_SERVER).toBeUndefined();
    expect(env.AX_FILESTORE_EXPORT_PATH).toBeUndefined();
  });

  it('opens runner egress to ONLY the Filestore IP on :2049 + :111 (TCP+UDP)', () => {
    const np = sandboxRestrict(helmTemplate(FILESTORE));
    expect(np, 'sandbox-restrict NetworkPolicy renders').toBeDefined();
    const egress = (np?.spec?.egress as Array<{
      to?: Array<{ ipBlock?: { cidr?: string } }>;
      ports?: Array<{ port?: number; protocol?: string }>;
    }>) ?? [];

    const fsRule = egress.find((r) =>
      (r.to ?? []).some((t) => t.ipBlock?.cidr === '10.9.8.7/32'),
    );
    expect(fsRule, 'an egress rule scoped to the Filestore /32 exists').toBeDefined();

    // Exactly the NFS ports — 2049 + 111, both protocols. Nothing wider.
    const portKeys = (fsRule?.ports ?? [])
      .map((p) => `${p.protocol}:${p.port}`)
      .sort();
    expect(portKeys).toEqual(['TCP:111', 'TCP:2049', 'UDP:111', 'UDP:2049']);
    // The Filestore rule targets a /32 ipBlock — never a CIDR/internet wildcard.
    expect((fsRule?.to ?? []).every((t) => t.ipBlock?.cidr === '10.9.8.7/32')).toBe(true);
  });

  it('does NOT open any Filestore egress when no server is configured (default)', () => {
    const np = sandboxRestrict(helmTemplate([]));
    const egress = (np?.spec?.egress as Array<{
      to?: Array<{ ipBlock?: { cidr?: string } }>;
    }>) ?? [];
    const hasIpBlock = egress.some((r) => (r.to ?? []).some((t) => t.ipBlock !== undefined));
    expect(hasIpBlock).toBe(false);
  });

  // ---- the host-mounted read (sandbox.filestore.hostReadPath) ------------
  // Three things have to line up or the feature is broken in a way that does
  // not look like this feature: the env the preset reads, the read-only
  // volume + mount, and the host's NFS egress. Each gets its own assertion,
  // and each is asserted ABSENT by default — an unused grant is still a grant.

  const HOST_READ = [...FILESTORE, '--set', 'sandbox.filestore.hostReadPath=/user-files'];

  function hostDeployment(docs: K8sDoc[]) {
    return docs.find(
      (d) => d.kind === 'Deployment' && /-host$/.test(String(d.metadata?.name ?? '')),
    );
  }

  function hostPodSpec(docs: K8sDoc[]) {
    return (
      hostDeployment(docs)?.spec as {
        template?: {
          spec?: {
            containers?: Array<{
              volumeMounts?: Array<{ name: string; mountPath?: string; readOnly?: boolean }>;
            }>;
            volumes?: Array<{
              name: string;
              nfs?: { server?: string; path?: string; readOnly?: boolean };
            }>;
          };
        };
      }
    )?.template?.spec;
  }

  function hostNetwork(docs: K8sDoc[]) {
    return docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        String(d.metadata?.name ?? '').endsWith('-host-network'),
    );
  }

  it('stamps AX_FILESTORE_HOST_READ_PATH when hostReadPath is set', () => {
    expect(hostEnv(helmTemplate(HOST_READ)).AX_FILESTORE_HOST_READ_PATH).toBe(
      '/user-files',
    );
  });

  it('omits AX_FILESTORE_HOST_READ_PATH by default, even with a Filestore server', () => {
    // The default posture: the export is mounted into RUNNER pods but not into
    // the host, so the host has no path to any agent's files at all and the
    // provider keeps its pod-per-call read.
    expect(hostEnv(helmTemplate(FILESTORE)).AX_FILESTORE_HOST_READ_PATH).toBeUndefined();
  });

  it('mounts the export into the host pod READ-ONLY at hostReadPath', () => {
    const spec = hostPodSpec(helmTemplate(HOST_READ));
    const mount = (spec?.containers?.[0]?.volumeMounts ?? []).find(
      (m) => m.name === 'user-files-read',
    );
    expect(mount, 'the host container mounts user-files-read').toBeDefined();
    expect(mount?.mountPath).toBe('/user-files');
    // The property the whole design rests on. If this ever renders false or
    // undefined, the UI's read path can write to every agent's files.
    expect(mount?.readOnly).toBe(true);

    const vol = (spec?.volumes ?? []).find((v) => v.name === 'user-files-read');
    expect(vol?.nfs?.server).toBe('10.9.8.7');
    expect(vol?.nfs?.path).toBe('/vol1');
    expect(vol?.nfs?.readOnly).toBe(true);
  });

  it('does NOT mount anything into the host pod by default', () => {
    const spec = hostPodSpec(helmTemplate(FILESTORE));
    expect(
      (spec?.containers?.[0]?.volumeMounts ?? []).some((m) => m.name === 'user-files-read'),
    ).toBe(false);
    expect((spec?.volumes ?? []).some((v) => v.name === 'user-files-read')).toBe(false);
  });

  it('opens HOST egress to ONLY the Filestore IP on :2049 + :111 when host-read is on', () => {
    const np = hostNetwork(helmTemplate(HOST_READ));
    expect(np, 'host-network NetworkPolicy renders').toBeDefined();
    const egress = (np?.spec?.egress as Array<{
      to?: Array<{ ipBlock?: { cidr?: string } }>;
      ports?: Array<{ port?: number; protocol?: string }>;
    }>) ?? [];
    const fsRule = egress.find((r) =>
      (r.to ?? []).some((t) => t.ipBlock?.cidr === '10.9.8.7/32'),
    );
    expect(fsRule, 'a host egress rule scoped to the Filestore /32 exists').toBeDefined();
    expect((fsRule?.ports ?? []).map((p) => `${p.protocol}:${p.port}`).sort()).toEqual([
      'TCP:111',
      'TCP:2049',
      'UDP:111',
      'UDP:2049',
    ]);
  });

  it('does NOT open host NFS egress when host-read is off', () => {
    const np = hostNetwork(helmTemplate(FILESTORE));
    const egress = (np?.spec?.egress as Array<{
      to?: Array<{ ipBlock?: { cidr?: string } }>;
    }>) ?? [];
    expect(
      egress.some((r) => (r.to ?? []).some((t) => t.ipBlock?.cidr === '10.9.8.7/32')),
    ).toBe(false);
  });
});

// ── TASK-326: config.models.default is a real override, not decoration ──
//
// The key rendered into the (unread) ax.config.yaml ConfigMap and nothing
// else, so an operator could pin a model, see it in `helm get values`, and
// believe it. It is now stamped onto the host Deployment as
// AX_AGENT_MODELS_ALLOWED, which is what @ax/agents' resolveAllowedModels
// actually reads (packages/agents/src/store.ts).
//
// It is an OVERRIDE, not a mirror: empty (the default) stamps nothing, so
// the deployment keeps @ax/agents' built-in DEFAULT_ALLOWED_MODELS as the
// single source of truth for the default set. Shipping a non-empty default
// here would silently narrow the live allow-list to whatever this file
// happened to list — which is the bug in the other direction.
describeIfHelm('ax-next chart: config.models.default → AX_AGENT_MODELS_ALLOWED (TASK-326)', () => {
  const envValue = (extraArgs: readonly string[]): string | undefined =>
    findHostEnv(helmTemplate(extraArgs)).find(
      (e) => e.name === 'AX_AGENT_MODELS_ALLOWED',
    )?.value;

  it('a single configured model is stamped onto the host Deployment', () => {
    expect(envValue(['--set', 'config.models.default={anthropic/claude-opus-4-7}']))
      .toBe('anthropic/claude-opus-4-7');
  });

  it('several configured models are comma-joined with no padding', () => {
    expect(
      envValue([
        '--set',
        'config.models.default={anthropic/claude-opus-4-7,anthropic/claude-haiku-4-5-20251001}',
      ]),
    ).toBe('anthropic/claude-opus-4-7,anthropic/claude-haiku-4-5-20251001');
  });

  it('a routing-style ref keeps every slash after the first', () => {
    // parseModelRef splits on the FIRST slash, so provider=openrouter and
    // modelId=x-ai/grok-4.6. A join that mangled the rest would produce an
    // allow-list entry no agent can match.
    expect(envValue(['--set', 'config.models.default={openrouter/x-ai/grok-4.6}']))
      .toBe('openrouter/x-ai/grok-4.6');
  });

  it('default values stamp NOTHING, so @ax/agents keeps its built-in allow-list', () => {
    expect(envValue([])).toBeUndefined();
  });

  it('an explicitly empty list stamps nothing either', () => {
    // --set-json, not --set: `--set x=[]` hands helm the two-character STRING
    // "[]", which is a different (and separately guarded) case.
    expect(envValue(['--set-json', 'config.models.default=[]'])).toBeUndefined();
  });

  it('a non-list value is named at render time, not left to Go internals', () => {
    // The `--set x=[]` an operator reaches for first. Without the type check
    // the render dies with "range can't iterate over []", which says nothing
    // about which key is wrong.
    const r = helmTemplateExpectFailure(['--set', 'config.models.default=[]']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('config.models.default must be a LIST');
  });

  it('renders cleanly when the whole config.models block is absent', () => {
    // An operator who replaces `config:` wholesale leaves .Values.config.models
    // nil; a naive `.Values.config.models.default` lookup dies on the nil
    // intermediate and takes the entire render with it.
    expect(envValue(['--set', 'config.models=null'])).toBeUndefined();
  });

  it('a bare model id fails the render instead of crash-looping the host', () => {
    // resolveAllowedModels throws PluginError at plugin init on a ref with no
    // provider, so a bare id here means the host pod crash-loops after a
    // successful-looking `helm upgrade`. Catch it at render time and name the
    // offending value.
    const r = helmTemplateExpectFailure([
      '--set', 'config.models.default={claude-sonnet-4-6}',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('claude-sonnet-4-6');
    expect(r.stderr).toContain('provider/model-id');
  });
});



// ── TASK-347: knobs the chart could not reach ──
//
// Found by the new third gate in env-shape.test.ts: the preset read these and
// no template stamped them, so no operator could set them.
//
// XAI_API_KEY was the third, and it is NOT here — the fix for that one was to
// stop reading it. memory_search's orchestrator now routes through
// @ax/llm-openrouter and resolves its credential like every other LLM call, so
// there is no orchestrator key for the chart to carry at all. What replaced it
// is a model knob, which is not a secret.
describeIfHelm('ax-next chart: previously unstampable env (TASK-347)', () => {
  const hostEnv = (extraArgs: readonly string[]) =>
    findHostEnv(helmTemplate(extraArgs));

  it('stamps none of them by default', () => {
    const names = hostEnv([]).map((e) => e.name);
    expect(names).not.toContain('AX_AUTH_SESSION_LIFETIME_SECONDS');
    expect(names).not.toContain('AX_CHAT_TIMEOUT_MS');
    expect(names).not.toContain('AX_MEMORY_ORCHESTRATOR_MODEL');
  });

  it('never stamps an orchestrator API key, because there is no longer one', () => {
    // Regression guard on the direction of the TASK-347 fix. Re-introducing a
    // dedicated orchestrator key would mean a second credential path for the
    // same provider, which is what this removed.
    const names = hostEnv([
      '--set', 'memory.orchestratorModel=x-ai/grok-4-fast',
    ]).map((e) => e.name);
    expect(names).not.toContain('XAI_API_KEY');
  });

  it('auth.sessionLifetimeSeconds is stamped as the loader expects it', () => {
    const found = hostEnv([
      '--set', 'auth.sessionLifetimeSeconds=3600',
    ]).find((e) => e.name === 'AX_AUTH_SESSION_LIFETIME_SECONDS');
    // Quoted: the loader Number()s the string, and an unquoted 3600 renders
    // as a YAML int, which k8s rejects for an env value.
    expect(found?.value).toBe('3600');
  });

  it('chat.timeoutMs is stamped as the loader expects it', () => {
    const found = hostEnv([
      '--set', 'chat.timeoutMs=900000',
    ]).find((e) => e.name === 'AX_CHAT_TIMEOUT_MS');
    expect(found?.value).toBe('900000');
  });

  it('memory.orchestratorModel is stamped as a bare provider-native id', () => {
    const found = hostEnv([
      '--set', 'memory.orchestratorModel=x-ai/grok-4-fast',
    ]).find((e) => e.name === 'AX_MEMORY_ORCHESTRATOR_MODEL');
    // Bare, not `openrouter/x-ai/...`: the hook name already carries the
    // provider, and a prefixed id would be routed twice.
    expect(found?.value).toBe('x-ai/grok-4-fast');
  });
});
