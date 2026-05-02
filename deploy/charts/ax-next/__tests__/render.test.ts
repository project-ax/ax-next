// Chart render tests for the experimental sharded git-server tier
// (Phase 1 of the workspace redesign — see
// docs/plans/2026-05-01-workspace-redesign-phase-1-plan.md).
//
// Strategy: shell out to `helm template`, parse the multi-doc YAML, and
// assert on the resulting resources. The tests gate on `helm` being on the
// PATH; if it's not, every test inside the suite is skipped with a clear
// console.warn so CI doesn't silently pass over a missing dep.
//
// Why shell out instead of vendoring a Go-template engine: the chart is the
// source of truth. Anything other than `helm template` would only ever
// approximate what helm itself does, and a render test that disagrees with
// `helm install` is worse than no render test at all.

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
];

/** A rendered k8s resource. Loose typing — tests narrow as needed. */
type K8sDoc = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
} & Record<string, unknown>;

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
    ['template', 'ax-test', chartDir, ...REQUIRED, ...extraArgs],
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
    ['template', 'ax-test', chartDir, ...REQUIRED, ...extraArgs],
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

describeIfHelm('ax-next chart: experimental sharded git-server', () => {
  // Pull subchart tarballs (postgresql) into charts/ before any render. They
  // ship via Chart.yaml dependency declaration and are gitignored, so a fresh
  // checkout (CI, new clones) needs `helm dependency build` once. Idempotent;
  // a no-op when the tarballs are already present.
  //
  // The bitnami repo also has to be registered locally for `dependency build`
  // to resolve postgresql. `helm repo add ... --force-update` is idempotent.
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

  it('toggle off (default): only legacy git-server resources render', () => {
    const docs = helmTemplate(['--set', 'gitServer.enabled=true']);

    const gitServerDocs = docs.filter((d) =>
      (d.metadata?.name ?? '').includes('git-server'),
    );

    // Legacy resources MUST render.
    expect(
      gitServerDocs.some(
        (d) =>
          d.kind === 'Deployment' &&
          d.metadata?.name === 'ax-test-ax-next-git-server',
      ),
      'legacy Deployment',
    ).toBe(true);
    expect(
      gitServerDocs.some(
        (d) =>
          d.kind === 'Service' &&
          d.metadata?.name === 'ax-test-ax-next-git-server',
      ),
      'legacy ClusterIP Service',
    ).toBe(true);
    expect(
      gitServerDocs.some(
        (d) =>
          d.kind === 'PersistentVolumeClaim' &&
          d.metadata?.name === 'ax-test-ax-next-git-server-repo',
      ),
      'legacy single PVC',
    ).toBe(true);

    // New experimental resources MUST NOT render.
    expect(
      gitServerDocs.some((d) => d.kind === 'StatefulSet'),
      'no StatefulSet when toggle off',
    ).toBe(false);
    expect(
      gitServerDocs.some(
        (d) =>
          d.kind === 'Service' && d.spec?.clusterIP === 'None',
      ),
      'no headless Service when toggle off',
    ).toBe(false);
    expect(
      gitServerDocs.some(
        (d) =>
          d.kind === 'NetworkPolicy' &&
          (d.metadata?.name ?? '').includes('git-server-experimental'),
      ),
      'no experimental NetworkPolicy when toggle off',
    ).toBe(false);
  });

  it('toggle on: legacy + experimental resources render in parallel', () => {
    const docs = helmTemplate([
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
    ]);

    // Both Deployment AND StatefulSet present.
    const legacyDeployment = docs.find(
      (d) =>
        d.kind === 'Deployment' &&
        d.metadata?.name === 'ax-test-ax-next-git-server',
    );
    const sts = docs.find(
      (d) =>
        d.kind === 'StatefulSet' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental',
    );
    expect(legacyDeployment, 'legacy Deployment').toBeDefined();
    expect(sts, 'experimental StatefulSet').toBeDefined();

    // Both ClusterIP Service AND headless Service present.
    const legacyService = docs.find(
      (d) =>
        d.kind === 'Service' &&
        d.metadata?.name === 'ax-test-ax-next-git-server',
    );
    const headlessService = docs.find(
      (d) =>
        d.kind === 'Service' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental-headless',
    );
    expect(legacyService, 'legacy ClusterIP Service').toBeDefined();
    expect(headlessService, 'experimental headless Service').toBeDefined();

    // Both NetworkPolicies render.
    const legacyNp = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-network',
    );
    const expNp = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental-network',
    );
    expect(legacyNp, 'legacy NetworkPolicy').toBeDefined();
    expect(expNp, 'experimental NetworkPolicy').toBeDefined();

    // StatefulSet shape.
    expect(sts?.spec?.replicas, 'replicas defaults to gitServer.shards=1').toBe(1);
    expect(sts?.spec?.podManagementPolicy).toBe('Parallel');
    expect(sts?.spec?.updateStrategy?.type).toBe('RollingUpdate');

    // volumeClaimTemplates: single template, RWO, resource-policy keep, 10Gi.
    const vcts = sts?.spec?.volumeClaimTemplates;
    expect(Array.isArray(vcts) && vcts.length).toBe(1);
    const vct = vcts[0];
    expect(vct.metadata?.annotations?.['helm.sh/resource-policy']).toBe('keep');
    expect(vct.spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(vct.spec?.resources?.requests?.storage).toBe('10Gi');

    // Container env contains the four storage-tier-specific keys, with the
    // shard index sourced from the downward API.
    const container = sts?.spec?.template?.spec?.containers?.[0];
    const env: Array<{
      name: string;
      value?: string;
      valueFrom?: { fieldRef?: { fieldPath?: string } } | Record<string, unknown>;
    }> = container?.env ?? [];
    const envByName = Object.fromEntries(env.map((e) => [e.name, e]));
    expect(envByName.AX_GIT_SERVER_TOKEN).toBeDefined();
    expect(envByName.AX_GIT_SERVER_REPO_ROOT?.value).toBe('/var/lib/ax-next/repo');
    expect(envByName.AX_GIT_SERVER_PORT?.value).toBe('7780');
    expect(envByName.AX_GIT_SERVER_SHARD_INDEX?.valueFrom?.fieldRef?.fieldPath).toBe(
      "metadata.labels['apps.kubernetes.io/pod-index']",
    );
    // Drain timeout = (grace - 10) * 1000 = 50_000ms at the default grace=60.
    expect(envByName.AX_GIT_SERVER_DRAIN_TIMEOUT_MS?.value).toBe('50000');

    // Container hardening.
    expect(container?.securityContext?.runAsNonRoot).toBe(true);
    expect(container?.securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(container?.securityContext?.capabilities?.drop).toEqual(['ALL']);

    // Lifecycle preStop sends SIGTERM to PID 1, then sleeps (grace - 5)s.
    const preStopCmd: string[] | undefined =
      container?.lifecycle?.preStop?.exec?.command;
    expect(preStopCmd?.length, 'preStop command set').toBeGreaterThan(0);
    expect(preStopCmd?.join(' ')).toMatch(/kill\s+-TERM\s+1/);
    // Default grace=60 → sleep 55s.
    expect(preStopCmd?.join(' ')).toMatch(/sleep\s+55\b/);

    // Pod-level grace period bumped to 60.
    expect(sts?.spec?.template?.spec?.terminationGracePeriodSeconds).toBe(60);
  });

  it('shards: 3 → replicas: 3 with a single volumeClaimTemplate', () => {
    const docs = helmTemplate([
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
      '--set',
      'gitServer.shards=3',
    ]);
    const sts = docs.find(
      (d) =>
        d.kind === 'StatefulSet' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental',
    );
    expect(sts?.spec?.replicas).toBe(3);
    // STS instantiates 3 PVCs at runtime; the chart still emits 1 template.
    expect(sts?.spec?.volumeClaimTemplates?.length).toBe(1);
  });

  it('headless Service: clusterIP None, port matches gitServer.service.port', () => {
    const docs = helmTemplate([
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
    ]);
    const headless = docs.find(
      (d) =>
        d.kind === 'Service' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental-headless',
    );
    expect(headless?.spec?.clusterIP).toBe('None');
    expect(headless?.spec?.selector?.['app.kubernetes.io/name']).toBe(
      'ax-test-ax-next-git-server-experimental',
    );
    const ports = headless?.spec?.ports ?? [];
    expect(ports.length).toBe(1);
    expect(ports[0]?.port).toBe(7780);
    expect(ports[0]?.targetPort).toBe('git');
  });

  it('experimental NetworkPolicy: ingress from host only, egress empty', () => {
    const docs = helmTemplate([
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
    ]);
    const np = docs.find(
      (d) =>
        d.kind === 'NetworkPolicy' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental-network',
    );
    expect(np).toBeDefined();
    expect(np?.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name']).toBe(
      'ax-test-ax-next-git-server-experimental',
    );
    expect(np?.spec?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(np?.spec?.egress).toEqual([]);

    // Ingress allowed only from host pods.
    const ingress = np?.spec?.ingress ?? [];
    expect(ingress.length).toBe(1);
    const from = ingress[0]?.from ?? [];
    expect(from.length).toBe(1);
    expect(
      from[0]?.podSelector?.matchLabels?.['app.kubernetes.io/name'],
    ).toBe('ax-test-ax-next-host');
  });

  it('toggle on without gitServer.storage → required-value failure', () => {
    const r = helmTemplateExpectFailure([
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=',
    ]);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(/gitServer\.storage is required/);
  });

  it('long fullnameOverride: -experimental suffix preserved (no collision with legacy)', () => {
    // 63-char fullname is the worst case — naive truncation drops the
    // "-experimental" tail and aliases the new StatefulSet onto the legacy
    // Deployment's labels. The helper must reserve space for the suffix.
    const longName = 'x'.repeat(63);
    const docs = helmTemplate([
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
      '--set',
      `fullnameOverride=${longName}`,
    ]);
    // Find the experimental git-server StatefulSet specifically — there's
    // also a postgresql StatefulSet rendered by the chart.
    const sts = docs.find(
      (d) =>
        d.kind === 'StatefulSet' &&
        (d.metadata?.name ?? '').includes('git-server'),
    );
    expect(sts, 'experimental git-server StatefulSet rendered').toBeDefined();
    const name = sts?.metadata?.name ?? '';
    expect(name.endsWith('-experimental'), `name=${name}`).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
    // It must NOT equal the legacy gitServerComponentName, which is what the
    // pre-fix truncation produced.
    const legacy = docs.find(
      (d) => d.kind === 'Deployment' && (d.metadata?.name ?? '').includes('git-server'),
    );
    if (legacy) {
      expect(sts?.metadata?.name).not.toBe(legacy.metadata?.name);
    }
  });

  it('terminationGracePeriodSeconds=20 → render fails with explicit message', () => {
    // Anything below 35 leaves no room for the listener's drain budget; the
    // chart must reject the install rather than quietly truncating it.
    const r = helmTemplateExpectFailure([
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
      '--set',
      'gitServer.terminationGracePeriodSeconds=20',
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
  // beforeAll already ran for the suite above (helm dependency build is
  // idempotent), but the suites are independent — re-run for safety. A
  // no-op when the tarballs are already present.
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

  it('backend=local (default): host has AX_WORKSPACE_ROOT only', () => {
    const docs = helmTemplate([]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);

    expect(names).toContain('AX_WORKSPACE_BACKEND');
    expect(env.find((e) => e.name === 'AX_WORKSPACE_BACKEND')?.value).toBe('local');
    expect(names).toContain('AX_WORKSPACE_ROOT');
    expect(names).not.toContain('AX_WORKSPACE_GIT_HTTP_URL');
    expect(names).not.toContain('AX_WORKSPACE_GIT_HTTP_TOKEN');
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_URL');
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_TOKEN');
  });

  it('backend=http + gitServer.enabled: host has AX_WORKSPACE_GIT_HTTP_*, no _SERVER_*', () => {
    const docs = helmTemplate([
      '--set',
      'workspace.backend=http',
      '--set',
      'gitServer.enabled=true',
    ]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));

    expect(byName.AX_WORKSPACE_BACKEND?.value).toBe('http');
    expect(byName.AX_WORKSPACE_GIT_HTTP_URL?.value).toBe(
      'http://ax-test-ax-next-git-server.default.svc.cluster.local:7780',
    );
    expect(byName.AX_WORKSPACE_GIT_HTTP_TOKEN?.valueFrom).toBeDefined();
    expect(names).not.toContain('AX_WORKSPACE_ROOT');
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_URL');
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_TOKEN');
  });

  it('backend=git-protocol + both toggles: host has AX_WORKSPACE_GIT_SERVER_*, experimental Service + STS render', () => {
    const docs = helmTemplate([
      '--set',
      'workspace.backend=git-protocol',
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
    ]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));

    // Host env: ONLY the new vars, NO local/http vars.
    expect(byName.AX_WORKSPACE_BACKEND?.value).toBe('git-protocol');
    expect(byName.AX_WORKSPACE_GIT_SERVER_URL?.value).toBe(
      'http://ax-test-ax-next-git-server-experimental.default.svc.cluster.local:7780',
    );
    expect(byName.AX_WORKSPACE_GIT_SERVER_TOKEN?.valueFrom).toBeDefined();
    expect(names).not.toContain('AX_WORKSPACE_ROOT');
    expect(names).not.toContain('AX_WORKSPACE_GIT_HTTP_URL');
    expect(names).not.toContain('AX_WORKSPACE_GIT_HTTP_TOKEN');

    // The new ClusterIP Service renders (regular, NOT headless).
    const expService = docs.find(
      (d) =>
        d.kind === 'Service' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental',
    );
    expect(expService, 'experimental ClusterIP Service').toBeDefined();
    expect(expService?.spec?.clusterIP).not.toBe('None'); // regular ClusterIP
    expect(expService?.spec?.selector?.['app.kubernetes.io/name']).toBe(
      'ax-test-ax-next-git-server-experimental',
    );
    const expPorts = expService?.spec?.ports ?? [];
    expect(expPorts.length).toBe(1);
    expect(expPorts[0]?.port).toBe(7780);
    expect(expPorts[0]?.targetPort).toBe('git');

    // The StatefulSet renders.
    const sts = docs.find(
      (d) =>
        d.kind === 'StatefulSet' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental',
    );
    expect(sts, 'experimental StatefulSet').toBeDefined();

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
    // at first workspace op. Error must mention the toggle name so the
    // operator knows what to flip.
    const r = helmTemplateExpectFailure([
      '--set',
      'workspace.backend=git-protocol',
    ]);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(
      /workspace\.backend=git-protocol requires gitServer\.enabled=true/,
    );
  });

  it('backend=git-protocol without gitServer.experimental.gitProtocol → render fails with sanitized error', () => {
    const r = helmTemplateExpectFailure([
      '--set',
      'workspace.backend=git-protocol',
      '--set',
      'gitServer.enabled=true',
    ]);
    expect(r.status, 'helm template should fail').not.toBe(0);
    expect(r.stderr).toMatch(
      /workspace\.backend=git-protocol requires gitServer\.experimental\.gitProtocol=true/,
    );
  });

  it('backend=git-protocol: host egress NetworkPolicy opens a rule to the experimental git-server tier', () => {
    // Without this rule, the host pod's @ax/workspace-git-server traffic is
    // denied at the CNI layer when networkPolicies.enabled=true (the default)
    // — the legacy egress rule only matches `component: git-server`, but the
    // experimental STS pods carry `component: git-server-experimental`.
    // Render succeeds, the operator ships, every workspace op fails with an
    // opaque connection error.
    const docs = helmTemplate([
      '--set',
      'workspace.backend=git-protocol',
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
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

    // Find a rule whose `to` selects the experimental tier.
    const expRule = egress.find((r) =>
      (r.to ?? []).some(
        (t) =>
          t.podSelector?.matchLabels?.['app.kubernetes.io/name'] ===
          'ax-test-ax-next-git-server-experimental',
      ),
    );
    expect(
      expRule,
      'host egress includes a rule selecting the experimental git-server tier',
    ).toBeDefined();
    expect(expRule?.ports?.[0]?.port).toBe(7780);
    expect(expRule?.ports?.[0]?.protocol).toBe('TCP');
  });

  it('backend=http + experimental.gitProtocol=false: host egress only includes the legacy git-server rule', () => {
    // Symmetric guardrail: when the experimental toggle is off, the new
    // egress rule must NOT render. Otherwise `helm template` would emit a
    // dangling rule that selects pods that don't exist — harmless but
    // confusing, and a sign the gate condition leaked.
    const docs = helmTemplate([
      '--set',
      'workspace.backend=http',
      '--set',
      'gitServer.enabled=true',
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
    }>) ?? [];

    // Legacy rule is present.
    const legacyRule = egress.find((r) =>
      (r.to ?? []).some(
        (t) =>
          t.podSelector?.matchLabels?.['app.kubernetes.io/name'] ===
          'ax-test-ax-next-git-server',
      ),
    );
    expect(legacyRule, 'legacy egress rule present').toBeDefined();

    // Experimental rule MUST NOT render.
    const expRule = egress.find((r) =>
      (r.to ?? []).some(
        (t) =>
          t.podSelector?.matchLabels?.['app.kubernetes.io/name'] ===
          'ax-test-ax-next-git-server-experimental',
      ),
    );
    expect(
      expRule,
      'no experimental egress rule when experimental.gitProtocol is off',
    ).toBeUndefined();
  });

  it('backend=http + experimental.gitProtocol=true: legacy host wiring + experimental tier in canary-preflight', () => {
    // The "stand the new tier up next to the live one and watch it idle"
    // posture. Host traffic still goes to the legacy git-server-http
    // backend; the experimental STS + Service render but receive no
    // traffic (no host env points at them). This is the safe pre-cutover
    // configuration.
    const docs = helmTemplate([
      '--set',
      'workspace.backend=http',
      '--set',
      'gitServer.enabled=true',
      '--set',
      'gitServer.experimental.gitProtocol=true',
      '--set',
      'gitServer.storage=10Gi',
    ]);
    const env = findHostEnv(docs);
    const names = env.map((e) => e.name);
    const byName = Object.fromEntries(env.map((e) => [e.name, e]));

    // Host pod still uses the legacy http path.
    expect(byName.AX_WORKSPACE_BACKEND?.value).toBe('http');
    expect(byName.AX_WORKSPACE_GIT_HTTP_URL?.value).toBe(
      'http://ax-test-ax-next-git-server.default.svc.cluster.local:7780',
    );
    expect(byName.AX_WORKSPACE_GIT_HTTP_TOKEN?.valueFrom).toBeDefined();
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_URL');
    expect(names).not.toContain('AX_WORKSPACE_GIT_SERVER_TOKEN');

    // But the experimental tier is provisioned and ready.
    const sts = docs.find(
      (d) =>
        d.kind === 'StatefulSet' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental',
    );
    expect(sts, 'experimental StatefulSet renders even when host points at legacy').toBeDefined();
    const expService = docs.find(
      (d) =>
        d.kind === 'Service' &&
        d.metadata?.name === 'ax-test-ax-next-git-server-experimental',
    );
    expect(expService, 'experimental ClusterIP Service renders').toBeDefined();
  });
});
