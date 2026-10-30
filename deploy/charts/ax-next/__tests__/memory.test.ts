
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAll } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { HELM_REQUIRED_MESSAGE, resolveHelmGate } from './helm-required.js';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');
const repoRoot = resolve(here, '../../../..');
const memoryPresetSourcePath = resolve(repoRoot, 'presets/memory/src/index.ts');
const serveSourcePath = resolve(repoRoot, 'packages/cli/src/commands/serve.ts');

const KIND_DEV_VALUES = resolve(chartDir, 'kind-dev-values.yaml');
// Every render needs a durable /files home (TASK-992). A values FILE, passed
// first, so overlay files passed later and any --set still win over it.
const FILESTORE_FIXTURE = resolve(here, 'fixtures/filestore-values.yaml');

const REQUIRED = [
  '-f',
  FILESTORE_FIXTURE,
  '--set',
  'credentials.key=test',
  '--set',
  'anthropic.apiKey=test',
  '--set',
  'http.cookieKey=0000000000000000000000000000000000000000000000000000000000000000',
];

const MEMORY_VALUES = [
  '--set',
  'host.preset=memory',
  '--set',
  'memory.exports.server=nfs.example.invalid',
  '--set',
  'memory.exports.exportPath=/exports/ax-memory',
];

type K8sDoc = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
} & Record<string, unknown>;

function findHelm(): string | null {
  const probe = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' });
  if (probe.status === 0) return 'helm';
  return null;
}

const HELM = findHelm();
const GATE = resolveHelmGate(HELM, process.env.AX_REQUIRE_HELM);
const describeIfHelm = GATE.mode === 'run' ? describe : describe.skip;

if (GATE.mode === 'skip') {
  console.warn(
    'helm CLI not available; memory-preset chart tests skipped — run with helm in PATH for full coverage',
  );
}
if (GATE.mode === 'require-missing') {
  describe('chart memory preset: helm required', () => {
    it('helm must be installed when AX_REQUIRE_HELM is set', () => {
      throw new Error(HELM_REQUIRED_MESSAGE);
    });
  });
}

function render(extraArgs: readonly string[]): K8sDoc[] {
  if (!HELM) throw new Error('helm not available');
  const out = execFileSync(
    HELM,
    ['template', 'ax-test', chartDir, '--namespace', 'default', ...REQUIRED, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return (loadAll(out) as Array<K8sDoc | null>).filter(
    (d): d is K8sDoc => d != null && typeof d === 'object',
  );
}

function renderFails(extraArgs: readonly string[], dir = chartDir): string {
  if (!HELM) throw new Error('helm not available');
  const r = spawnSync(
    HELM,
    ['template', 'ax-test', dir, '--namespace', 'default', ...REQUIRED, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  expect(r.status).not.toBe(0);
  return `${r.stdout}\n${r.stderr}`;
}

let noSchemaChart = '';

function schemaSkippedChart(): string {
  if (noSchemaChart === '') {
    noSchemaChart = mkdtempSync(join(tmpdir(), 'ax-next-chart-noschema-'));
    for (const entry of ['Chart.yaml', 'Chart.lock', 'values.yaml', 'templates', 'charts']) {
      cpSync(resolve(chartDir, entry), join(noSchemaChart, entry), { recursive: true });
    }
    rmSync(join(noSchemaChart, 'values.schema.json'), { force: true });
  }
  return noSchemaChart;
}

function hostDeployment(docs: K8sDoc[]): K8sDoc {
  const dep = docs.find(
    (d) => d.kind === 'Deployment' && (d.metadata?.name ?? '').endsWith('-host'),
  );
  if (dep === undefined) throw new Error('host Deployment not found in render');
  return dep;
}

type Container = {
  env?: Array<{ name?: string; value?: string }>;
  volumeMounts?: Array<{ name?: string; mountPath?: string; readOnly?: boolean }>;
};
type PodSpec = {
  containers?: Container[];
  volumes?: Array<Record<string, unknown> & { name?: string }>;
};

function hostSpec(dep: K8sDoc): { container: Container; spec: PodSpec } {
  const spec = (dep.spec as { template?: { spec?: PodSpec } })?.template?.spec;
  const container = spec?.containers?.[0];
  if (spec === undefined || container === undefined) {
    throw new Error('host Deployment has no container spec');
  }
  return { container, spec };
}

function envMap(container: Container): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of container.env ?? []) {
    if (typeof e.name === 'string') m.set(e.name, e.value ?? '');
  }
  return m;
}

// Optional, all-or-none (TASK-576): stamped only when memory.exports is set.
const OPTIONAL_EXPORT_ENV_NAMES = [
  'AX_MEMORY_EXPORT_HOST_ROOT',
  'AX_MEMORY_EXPORT_NFS_SERVER',
  'AX_MEMORY_EXPORT_NFS_PATH',
];

// TASK-523: embeddings + rerank moved to OpenRouter on `provider:openrouter`,
// which the Provider keys screen writes. There is no Vertex project and no
// per-provider credential ref left to configure, so none of these may render.
const RETIRED_MEMORY_ENV_NAMES = [
  'AX_MEMORY_VERTEX_PROJECT',
  'AX_MEMORY_VERTEX_CREDENTIAL_REF',
  'AX_MEMORY_COHERE_CREDENTIAL_REF',
];

describeIfHelm('memory preset opt-in (TASK-496)', () => {
  afterAll(() => {
    if (noSchemaChart !== '') {
      rmSync(noSchemaChart, { recursive: true, force: true });
      noSchemaChart = '';
    }
  });

  it('TASK-576: kind-dev-values.yaml renders memory by default, with NO extra --set', () => {
    // kind-dev-values.yaml folds in the former kind-memory-values.yaml overlay
    // (dev NFS server address) — host.preset itself comes from the chart's
    // own default (values.yaml), not from kind-dev-values.yaml.
    const docs = render(['-f', KIND_DEV_VALUES]);
    const { container, spec } = hostSpec(hostDeployment(docs));
    const env = envMap(container);
    expect(env.get('AX_PRESET')).toBe('memory');
    const mounts = container.volumeMounts ?? [];
    expect(mounts.find((m) => m.name === 'memory-facts')).toBeDefined();
    expect(mounts.find((m) => m.name === 'memory-exports')).toBeDefined();
    const volumes = spec.volumes ?? [];
    expect(volumes.find((v) => v.name === 'memory-facts')).toBeDefined();
    expect(volumes.find((v) => v.name === 'memory-exports')).toBeDefined();
    expect(docs.find((d) => (d.metadata?.name ?? '').endsWith('-memory-facts'))).toBeDefined();
  });

  it('TASK-608: host.preset=k8s (the old default) FAILS render with a pointer to the facts-memory runbook', () => {
    const out = renderFails(['-f', KIND_DEV_VALUES, '--set', 'host.preset=k8s']);
    expect(out).toContain('host.preset=k8s');
    expect(out).toContain('TASK-608');
    expect(out).toContain('deploy/README.md');
    expect(out).toContain('Switching an existing deployment to facts memory');
  });

  it('TASK-576: a bare default render SUCCEEDS on facts memory, with no export env or NFS volume', () => {
    const docs = render([]);
    const { container, spec } = hostSpec(hostDeployment(docs));
    const env = envMap(container);
    expect(env.get('AX_PRESET')).toBe('memory');
    expect(env.get('AX_MEMORY_FACTS_DB_PATH')).toBe('/var/lib/ax-next/memory-facts/facts.db');
    for (const name of OPTIONAL_EXPORT_ENV_NAMES) {
      expect(env.has(name), `${name} must not render without memory.exports`).toBe(false);
    }
    const mounts = container.volumeMounts ?? [];
    expect(mounts.find((m) => m.name === 'memory-facts')).toBeDefined();
    expect(mounts.find((m) => m.name === 'memory-exports')).toBeUndefined();
    const volumes = spec.volumes ?? [];
    expect(volumes.find((v) => v.name === 'memory-facts')).toBeDefined();
    expect(volumes.find((v) => v.name === 'memory-exports')).toBeUndefined();
    expect(volumes.some((v) => 'nfs' in v)).toBe(false);
    expect(
      docs.find(
        (d) => d.kind === 'PersistentVolumeClaim' && (d.metadata?.name ?? '').endsWith('-memory-facts'),
      ),
      'facts PVC still renders without exports',
    ).toBeDefined();
  });

  it('gke-values.yaml plus a Filestore server renders facts memory, exports optional', () => {
    const gke = readFileSync(resolve(chartDir, 'gke-values.yaml'), 'utf8');
    const parsed = loadAll(gke)[0] as { host?: { preset?: string } };
    expect(parsed.host?.preset, 'gke-values.yaml pins host.preset explicitly').toBe('memory');
    const { container, spec } = hostSpec(hostDeployment(render([
      '-f',
      resolve(chartDir, 'gke-values.yaml'),
      '--set',
      'sandbox.filestore.server=10.9.8.7',
    ])));
    const env = envMap(container);
    expect(env.get('AX_PRESET')).toBe('memory');
    expect(env.has('AX_MEMORY_EXPORT_NFS_SERVER')).toBe(false);
    expect((spec.volumes ?? []).find((v) => v.name === 'memory-exports')).toBeUndefined();
  });

  it('gke-values.yaml alone fails until a Filestore server is set', () => {
    // TASK-992: the committed overlay is a template and ships `server: ""`;
    // the real address lives in the operator's gke-values.local.yaml.
    const out = renderFails(['-f', resolve(chartDir, 'gke-values.yaml')]);
    expect(out).toContain('sandbox.filestore.server is empty');
  });

  it('TASK-576: gke-values.yaml with memory.exports set renders memory', () => {
    const { container } = hostSpec(hostDeployment(render([
      '-f',
      resolve(chartDir, 'gke-values.yaml'),
      '--set',
      'sandbox.filestore.server=10.9.8.7',
      '--set',
      'memory.exports.server=192.0.2.3',
      '--set',
      'memory.exports.exportPath=/memory_vol',
    ])));
    const env = envMap(container);
    expect(env.get('AX_PRESET')).toBe('memory');
    expect(env.get('AX_MEMORY_EXPORT_NFS_SERVER')).toBe('192.0.2.3');
    expect(env.get('AX_MEMORY_EXPORT_NFS_PATH')).toBe('/memory_vol');
  });

  it('TASK-576: memory.exports colliding with sandbox.filestore fails template, in both directions', () => {
    const filestoreArgs = [
      '--set', 'sandbox.filestore.server=192.0.2.9',
      '--set', 'sandbox.filestore.exportPath=/shared',
    ];
    const memoryArgs = [
      '--set', 'memory.exports.server=192.0.2.9',
      '--set', 'memory.exports.exportPath=/shared',
    ];
    // Order on the command line doesn't matter (both --set), but check both
    // orderings anyway: whichever export "arrived second" conceptually, the
    // failure fires the same way.
    for (const args of [
      [...filestoreArgs, ...memoryArgs],
      [...memoryArgs, ...filestoreArgs],
    ]) {
      const out = renderFails(args);
      expect(out).toContain('memory.exports and sandbox.filestore point at the same NFS export');
    }
  });

  it('memory.exports and sandbox.filestore on one server with different export paths render (the kind layout)', () => {
    // One NFS server, two exports: the overlap guard compares server AND
    // export path, so a shared server alone must never trip it.
    const { container } = hostSpec(hostDeployment(render([
      '--set', 'sandbox.filestore.server=10.96.200.49',
      '--set', 'sandbox.filestore.exportPath=/files',
      '--set', 'memory.exports.server=10.96.200.49',
      '--set', 'memory.exports.exportPath=/memory',
    ])));
    const env = envMap(container);
    expect(env.get('AX_PRESET')).toBe('memory');
    expect(env.get('AX_FILESTORE_SERVER')).toBe('10.96.200.49');
    expect(env.get('AX_FILESTORE_EXPORT_PATH')).toBe('/files');
    expect(env.get('AX_MEMORY_EXPORT_NFS_SERVER')).toBe('10.96.200.49');
    expect(env.get('AX_MEMORY_EXPORT_NFS_PATH')).toBe('/memory');
  });

  it('memory mode stamps AX_PRESET + all four memory env vars from values', () => {
    const { container } = hostSpec(hostDeployment(render(['-f', KIND_DEV_VALUES, ...MEMORY_VALUES])));
    const env = envMap(container);
    expect(env.get('AX_PRESET')).toBe('memory');
    expect(env.get('AX_MEMORY_FACTS_DB_PATH')).toBe('/var/lib/ax-next/memory-facts/facts.db');
    expect(env.get('AX_MEMORY_EXPORT_HOST_ROOT')).toBe('/var/lib/ax-next/memory-exports');
    expect(env.get('AX_MEMORY_EXPORT_NFS_SERVER')).toBe('nfs.example.invalid');
    expect(env.get('AX_MEMORY_EXPORT_NFS_PATH')).toBe('/exports/ax-memory');
    for (const name of RETIRED_MEMORY_ENV_NAMES) {
      expect(env.has(name), `${name} is retired (TASK-523) and must not render`).toBe(false);
    }
  });

  it('memory mode renders with no Vertex settings at all (TASK-523)', () => {
    // A stale value left over from a pre-TASK-523 release is ignored, not fatal:
    // the schema does not forbid unknown memory.* keys, so an upgrade that
    // carries `memory.vertexProject` forward still renders.
    const { container } = hostSpec(hostDeployment(render([
      '-f', KIND_DEV_VALUES, ...MEMORY_VALUES, '--set', 'memory.vertexProject=left-over',
    ])));
    const env = envMap(container);
    for (const name of RETIRED_MEMORY_ENV_NAMES) {
      expect(env.has(name), `${name} is retired (TASK-523) and must not render`).toBe(false);
    }
  });

  it('memory mode mounts the facts PVC and the SAME NFS export read-write on the host', () => {
    const { container, spec } = hostSpec(hostDeployment(render(['-f', KIND_DEV_VALUES, ...MEMORY_VALUES])));
    const mounts = container.volumeMounts ?? [];
    const factsMount = mounts.find((m) => m.name === 'memory-facts');
    const exportsMount = mounts.find((m) => m.name === 'memory-exports');
    expect(factsMount?.mountPath).toBe('/var/lib/ax-next/memory-facts');
    expect(exportsMount?.mountPath).toBe('/var/lib/ax-next/memory-exports');
    expect(exportsMount?.readOnly ?? false, 'host writes exports — read-write mount').toBe(false);

    const volumes = spec.volumes ?? [];
    const factsVol = volumes.find((v) => v.name === 'memory-facts') as
      | { persistentVolumeClaim?: { claimName?: string } }
      | undefined;
    expect(factsVol?.persistentVolumeClaim?.claimName).toContain('-memory-facts');
    const exportsVol = volumes.find((v) => v.name === 'memory-exports') as
      | { nfs?: { server?: string; path?: string; readOnly?: boolean } }
      | undefined;
    expect(exportsVol?.nfs?.server).toBe('nfs.example.invalid');
    expect(exportsVol?.nfs?.path).toBe('/exports/ax-memory');
    expect(exportsVol?.nfs?.readOnly ?? false, 'host is the only writer').toBe(false);
  });

  it('memory mode renders the dedicated facts PVC, RWO with keep annotation', () => {
    const docs = render(['-f', KIND_DEV_VALUES, ...MEMORY_VALUES]);
    const pvc = docs.find(
      (d) => d.kind === 'PersistentVolumeClaim' && (d.metadata?.name ?? '').endsWith('-memory-facts'),
    );
    expect(pvc, 'memory-facts PVC').toBeDefined();
    expect(pvc?.metadata?.annotations?.['helm.sh/resource-policy']).toBe('keep');
    const spec = pvc?.spec as {
      accessModes?: string[];
      resources?: { requests?: { storage?: string } };
    };
    expect(spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(spec?.resources?.requests?.storage).toBe('10Gi');
  });

  it('memory mode honors memory.facts.storage / storageClassName', () => {
    const docs = render([
      '-f',
      KIND_DEV_VALUES,
      ...MEMORY_VALUES,
      '--set',
      'memory.facts.storage=25Gi',
      '--set',
      'memory.facts.storageClassName=premium-rwo',
    ]);
    const pvc = docs.find(
      (d) => d.kind === 'PersistentVolumeClaim' && (d.metadata?.name ?? '').endsWith('-memory-facts'),
    );
    const spec = pvc?.spec as {
      storageClassName?: string;
      resources?: { requests?: { storage?: string } };
    };
    expect(spec?.resources?.requests?.storage).toBe('25Gi');
    expect(spec?.storageClassName).toBe('premium-rwo');
  });

  it('memory mode stamps neither retired workspace env name (TASK-360), even when the old value is set', () => {
    for (const extra of [[], ['--set', 'channelWeb.agentWorkspace=false']]) {
      const env = envMap(hostSpec(hostDeployment(render([...MEMORY_VALUES, ...extra]))).container);
      expect(env.has('AX_AGENT_WORKSPACE')).toBe(false);
      expect(env.has('AX_AGENT_WORKSPACE_PREVIEW')).toBe(false);
    }
  });

  it('rejects an unknown host.preset', () => {
    const out = renderFails(['--set', 'host.preset=bogus']);
    expect(out).toMatch(/host[./]preset/);
  });

  it.each([
    ['bogus', 'host.preset=bogus'],
    ['false', 'host.preset=false'],
    ['0', 'host.preset=0'],
    ['empty', 'host.preset='],
  ])('rejects %s host.preset with the schema out of the way', (_label, set) => {
    const out = renderFails(['--set', set], schemaSkippedChart());
    expect(out).toContain('host.preset');
  });

  it.each([
    'host.preset=memory,memory.exports.exportPath=/e',
    'host.preset=memory,memory.exports.server=nfs.example.invalid',
  ])('render fails on exactly one memory.exports field even with the schema out of the way: %s', (sets) => {
    const out = renderFails(['--set', sets], schemaSkippedChart());
    expect(out).toContain('memory.exports.server and memory.exports.exportPath must be set together');
  });

  it.each([
    ['server only', 'memory.exports.server=192.0.2.4'],
    ['exportPath only', 'memory.exports.exportPath=/e'],
  ])('render fails when memory.exports has %s (both-or-neither)', (_label, set) => {
    const out = renderFails(['--set', set]);
    expect(out).toContain('memory.exports.server');
    expect(out).toContain('memory.exports.exportPath');
    expect(out).toContain('both-or-neither');
  });

  it('memory.exports set (no kind overlay) stamps the export env and the host NFS mount', () => {
    const { container, spec } = hostSpec(hostDeployment(render([
      '--set', 'memory.exports.server=192.0.2.5',
      '--set', 'memory.exports.exportPath=/memory_vol',
    ])));
    const env = envMap(container);
    expect(env.get('AX_MEMORY_EXPORT_HOST_ROOT')).toBe('/var/lib/ax-next/memory-exports');
    expect(env.get('AX_MEMORY_EXPORT_NFS_SERVER')).toBe('192.0.2.5');
    expect(env.get('AX_MEMORY_EXPORT_NFS_PATH')).toBe('/memory_vol');
    expect((container.volumeMounts ?? []).find((m) => m.name === 'memory-exports')?.mountPath)
      .toBe('/var/lib/ax-next/memory-exports');
    const vol = (spec.volumes ?? []).find((v) => v.name === 'memory-exports') as
      | { nfs?: { server?: string; path?: string } }
      | undefined;
    expect(vol?.nfs).toMatchObject({ server: '192.0.2.5', path: '/memory_vol' });
  });

  it('with memory.exports unset, the loader reads nothing the render leaves out except the optional export vars', () => {
    const src = readFileSync(memoryPresetSourcePath, 'utf8');
    const loaderReads = new Set<string>(['AX_PRESET']);
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) loaderReads.add(m[1]!);
    // The export vars are read by name from a list, not `env.X` — pin that the
    // source still names each one so this test can't pass vacuously.
    for (const n of OPTIONAL_EXPORT_ENV_NAMES) expect(src).toContain(`'${n}'`);
    const env = envMap(hostSpec(hostDeployment(render([]))).container);
    const missing = [...loaderReads].filter((n) => !env.has(n));
    expect(missing.filter((n) => !OPTIONAL_EXPORT_ENV_NAMES.includes(n))).toEqual([]);
  });

  it('every env var the memory preset loader reads is stamped in memory mode', () => {
    const src = readFileSync(memoryPresetSourcePath, 'utf8');
    const loaderReads = new Set<string>();
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
      loaderReads.add(m[1]!);
    }
    const serveSrc = readFileSync(serveSourcePath, 'utf8');
    expect(/\benv\.AX_PRESET\b/.test(serveSrc)).toBe(true);
    loaderReads.add('AX_PRESET');

    const { container } = hostSpec(hostDeployment(render([
      '-f',
      KIND_DEV_VALUES,
      ...MEMORY_VALUES,
    ])));
    const env = envMap(container);
    const missing = [...loaderReads].filter((n) => !env.has(n));
    expect(missing, `memory loader reads env vars the render doesn't stamp: ${missing.join(', ')}`).toEqual([]);
  });

  it('every AX_MEMORY_* / AX_PRESET stamped in memory mode is read by the loader or serve.ts', () => {
    const { container } = hostSpec(hostDeployment(render([
      '-f',
      KIND_DEV_VALUES,
      ...MEMORY_VALUES,
    ])));
    const env = envMap(container);
    const presetSrc = readFileSync(memoryPresetSourcePath, 'utf8');
    const serveSrc = readFileSync(serveSourcePath, 'utf8');
    const stamped = [...env.keys()].filter(
      (n) => n === 'AX_PRESET' || n.startsWith('AX_MEMORY_'),
    );
    expect(stamped.length).toBeGreaterThan(0);
    const unread = stamped.filter(
      (n) =>
        !new RegExp(`\\benv\\.${n}\\b`).test(presetSrc) &&
        !new RegExp(`\\benv\\.${n}\\b`).test(serveSrc),
    );
    expect(unread, `render stamps memory env vars nothing reads: ${unread.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The kind overlay (TASK-519). kind has no Filestore, so the rung-5 walk runs
// against the dev NFS server in deploy/kind/memory-nfs/. kubelet mounts NFS
// from the NODE, which cannot resolve cluster DNS, so the overlay names the
// server by the Service's pinned ClusterIP. Those two literals live in two
// files; this is what stops them drifting apart.
// ---------------------------------------------------------------------------
const KIND_MEMORY_VALUES = resolve(chartDir, 'kind-memory-values.yaml');
const KIND_NFS_MANIFEST = resolve(repoRoot, 'deploy/kind/memory-nfs/nfs-server.yaml');
const KIND_NFS_ENTRYPOINT = resolve(repoRoot, 'deploy/kind/memory-nfs/entrypoint.sh');

type NfsVolume = {
  name?: string;
  emptyDir?: Record<string, unknown>;
  persistentVolumeClaim?: { claimName?: string };
};
type NfsPodSpec = {
  containers?: Array<{ volumeMounts?: Array<{ name?: string; mountPath?: string }> }>;
  volumes?: NfsVolume[];
};

function kindNfsDocs(): K8sDoc[] {
  return (loadAll(readFileSync(KIND_NFS_MANIFEST, 'utf8')) as Array<K8sDoc | null>).filter(
    (d): d is K8sDoc => d != null && typeof d === 'object',
  );
}

function kindNfsClusterIP(): string {
  const service = kindNfsDocs().find((d) => d.kind === 'Service');
  const clusterIP = (service?.spec as { clusterIP?: string } | undefined)?.clusterIP;
  expect(clusterIP).toMatch(/^10\.96\.\d+\.\d+$/);
  return clusterIP!;
}

describeIfHelm('kind memory overlay (TASK-519)', () => {
  it('renders with no --set at all — the overlay is complete on its own (TASK-523)', () => {
    const { container } = hostSpec(hostDeployment(render([
      '-f', KIND_DEV_VALUES, '-f', KIND_MEMORY_VALUES,
    ])));
    expect(envMap(container).get('AX_PRESET')).toBe('memory');
  });

  it('points the host export mount at the dev NFS Service by its pinned ClusterIP', () => {
    const docs = render([
      '-f', KIND_DEV_VALUES, '-f', KIND_MEMORY_VALUES,
    ]);
    const { container, spec } = hostSpec(hostDeployment(docs));
    const nfsDocs = loadAll(readFileSync(KIND_NFS_MANIFEST, 'utf8')) as K8sDoc[];
    const service = nfsDocs.find((d) => d.kind === 'Service');
    const clusterIP = (service?.spec as { clusterIP?: string } | undefined)?.clusterIP;
    expect(clusterIP).toMatch(/^10\.96\.\d+\.\d+$/);

    const exportsVol = (spec.volumes ?? []).find((v) => v.name === 'memory-exports') as
      | { nfs?: { server?: string; path?: string } }
      | undefined;
    expect(exportsVol?.nfs?.server).toBe(clusterIP);
    expect(exportsVol?.nfs?.path).toBe('/memory');
    expect(envMap(container).get('AX_MEMORY_EXPORT_NFS_SERVER')).toBe(clusterIP);
  });

  // TASK-992: the same dev server also serves every agent's durable home.
  it('points sandbox.filestore at the same dev NFS Service, on its own /files export', () => {
    // REQUIRED passes the chart-test fixture first (another server, /vol1);
    // kind-dev-values.yaml, passed after it, must override both.
    const { container, spec } = hostSpec(hostDeployment(render(['-f', KIND_DEV_VALUES])));
    const env = envMap(container);
    const clusterIP = kindNfsClusterIP();
    expect(env.get('AX_FILESTORE_SERVER')).toBe(clusterIP);
    expect(env.get('AX_FILESTORE_EXPORT_PATH')).toBe('/files');
    expect(env.get('AX_MEMORY_EXPORT_NFS_PATH')).toBe('/memory');
    expect(env.get('AX_FILESTORE_EXPORT_PATH')).not.toBe(env.get('AX_MEMORY_EXPORT_NFS_PATH'));
    expect(env.get('AX_FILESTORE_HOST_READ_PATH')).toBe('/user-files');

    const readVol = (spec.volumes ?? []).find((v) => v.name === 'user-files-read') as
      | { nfs?: { server?: string; path?: string; readOnly?: boolean } }
      | undefined;
    expect(readVol?.nfs).toMatchObject({ server: clusterIP, path: '/files', readOnly: true });
    expect((container.volumeMounts ?? []).find((m) => m.name === 'user-files-read'))
      .toMatchObject({ mountPath: '/user-files', readOnly: true });
  });

  it('the dev NFS server keeps /files on a PVC, not the emptyDir', () => {
    const docs = kindNfsDocs();
    const pvc = docs.find((d) => d.kind === 'PersistentVolumeClaim');
    expect(pvc, 'nfs-server.yaml declares a PersistentVolumeClaim').toBeDefined();
    const claimName = pvc!.metadata?.name;
    // deploy/kind/memory-nfs/README.md's wipe recipe deletes it by this name.
    expect(claimName).toBe('ax-next-files-nfs');

    const dep = docs.find((d) => d.kind === 'Deployment');
    expect(pvc!.metadata).toMatchObject({ namespace: (dep?.metadata as { namespace?: string })?.namespace });
    // No storageClassName at all, so kind's default class provisions it. An
    // empty string would instead disable provisioning and leave it Pending.
    expect((pvc!.spec as { storageClassName?: string }).storageClassName).toBeUndefined();

    const podSpec = (dep?.spec as { template?: { spec?: NfsPodSpec } } | undefined)?.template?.spec;
    const volumes = podSpec?.volumes ?? [];
    const mounts = podSpec?.containers?.[0]?.volumeMounts ?? [];
    const mountPathsOf = (vol: NfsVolume | undefined) =>
      mounts.filter((m) => vol !== undefined && m.name === vol.name).map((m) => m.mountPath);

    const claimVol = volumes.find((v) => v.persistentVolumeClaim?.claimName === claimName);
    expect(claimVol, 'the Deployment has a volume backed by that claim').toBeDefined();
    expect(mountPathsOf(claimVol)).toEqual(['/exports/files']);

    const scratchVol = volumes.find((v) => v.emptyDir !== undefined);
    expect(scratchVol, 'the /memory projection stays on an emptyDir').toBeDefined();
    expect(mountPathsOf(scratchVol)).toEqual(['/exports']);
  });

  it('the entrypoint exports /exports/files separately, to the node only', () => {
    const sh = readFileSync(KIND_NFS_ENTRYPOINT, 'utf8');
    expect(sh).toContain('FILES_DIR="$EXPORT_ROOT/files"');
    expect(sh).toContain('"$EXPORT_ROOT $NODE_ADDR(');
    expect(sh).toContain('"$FILES_DIR $NODE_ADDR(');
    // Explicit fsids: on kind both directories sit on one node filesystem, so
    // a device-derived fsid cannot tell the two exports apart.
    expect(sh).toMatch(/"\$EXPORT_ROOT \$NODE_ADDR\([^)]*\bfsid=0\b/);
    expect(sh).toMatch(/"\$FILES_DIR \$NODE_ADDR\([^)]*\bfsid=1\b/);
    // Never a wildcard client: only the node (kubelet) may mount.
    expect(sh).not.toContain('*(');
  });

  it('the entrypoint refuses to serve /files when the PVC is not mounted there (an old manifest)', () => {
    const sh = readFileSync(KIND_NFS_ENTRYPOINT, 'utf8');
    // The kernel's mount table, not busybox `mountpoint`: on kind the PVC and
    // the emptyDir live on the SAME node filesystem, and busybox compares
    // device numbers with the parent, so it calls a correctly mounted PVC
    // "not a mountpoint" and the server would never start.
    // An exact match on the mount-point field (5), not a substring.
    expect(sh).toMatch(/\bawk\b[^\n]*\$5 == p[^\n]*"\$\{2:-\/proc\/self\/mountinfo\}"/);
    expect(sh).toMatch(/^if ! is_mounted "\$FILES_DIR"; then$/m);
    expect(sh).not.toMatch(/\bmountpoint\b[^\n]*FILES_DIR/);
    const lines = sh.split('\n');
    const at = lines.findIndex((l) => l.includes('refusing to serve agent homes from scratch space'));
    expect(at, 'the refusal message is in the entrypoint').toBeGreaterThan(-1);
    expect(lines[at]).toMatch(/^\s*echo .*>&2\s*$/);
    expect(lines[at + 1]?.trim()).toBe('exit 1');
    // ...and it refuses before anything is exported or served.
    const refusal = sh.indexOf(lines[at]!);
    for (const step of ['> /etc/exports', 'exportfs -ra', 'rpc.nfsd -N']) {
      expect(sh.indexOf(step), `${step} is in the entrypoint`).toBeGreaterThan(-1);
      expect(refusal, `the refusal comes before ${step}`).toBeLessThan(sh.indexOf(step));
    }
  });

  it('is_mounted really decides from the mount table (run against fixture mountinfo files)', () => {
    // The text checks above cannot catch a guard that always succeeds (say,
    // `END { exit 0 }`). Run the entrypoint's own function body instead.
    const sh = readFileSync(KIND_NFS_ENTRYPOINT, 'utf8');
    const fn = /^is_mounted\(\) \{\n[\s\S]*?\n\}$/m.exec(sh)?.[0];
    expect(fn, 'is_mounted() is defined in the entrypoint').toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), 'ax-kind-nfs-mountinfo-'));
    try {
      const withPvc = join(dir, 'with-pvc');
      const withoutPvc = join(dir, 'without-pvc');
      const rootLine = '22 1 0:21 / / rw,relatime - overlay overlay rw';
      const emptyDirLine = '30 22 8:1 /pods/x/volumes/empty /exports rw,relatime - ext4 /dev/sda1 rw';
      const pvcLine = '31 30 8:1 /local-path/pvc-1 /exports/files rw,relatime - ext4 /dev/sda1 rw';
      // A look-alike path: a substring match would wrongly accept it.
      const lookAlike = '32 30 8:1 /local-path/pvc-2 /exports/files-old rw,relatime - ext4 /dev/sda1 rw';
      writeFileSync(withPvc, [rootLine, emptyDirLine, pvcLine].join('\n') + '\n');
      writeFileSync(withoutPvc, [rootLine, emptyDirLine, lookAlike].join('\n') + '\n');
      const run = (file: string) =>
        spawnSync('sh', ['-c', `${fn}\nis_mounted /exports/files "$1"`, 'sh', file], {
          encoding: 'utf8',
        }).status;
      expect(run(withPvc), 'PVC mounted at /exports/files').toBe(0);
      expect(run(withoutPvc), 'only the emptyDir (and a look-alike) mounted').not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the dev NFS pod does not start serving until /exports/files is really exported (a stale image)', () => {
    // The entrypoint guard cannot see the other way round: the NEW manifest
    // running an image built before TASK-992. That image still listens on 2049
    // but exports only /exports, and the kernel then serves /exports/files from
    // the emptyDir directory UNDER the PVC mount, so agents' files would vanish
    // with the pod. A startup probe on the export list keeps such a pod out of
    // the Service; the tcpSocket readiness probe alone would pass it.
    const dep = kindNfsDocs().find((d) => d.kind === 'Deployment');
    type Probe = { exec?: { command?: string[] }; tcpSocket?: { port?: number } };
    const container = (
      dep?.spec as {
        template?: { spec?: { containers?: Array<{ startupProbe?: Probe; readinessProbe?: Probe }> } };
      } | undefined
    )?.template?.spec?.containers?.[0];
    const startup = (container?.startupProbe?.exec?.command ?? []).join(' ');
    expect(startup).toContain('exportfs');
    expect(startup).toContain('^/exports/files');
    expect(container?.readinessProbe?.tcpSocket?.port).toBe(2049);
  });
});
