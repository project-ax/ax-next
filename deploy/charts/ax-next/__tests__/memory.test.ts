
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const REQUIRED = [
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
  'memory.vertexProject=memory-canary',
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

const MEMORY_ENV_NAMES = [
  'AX_PRESET',
  'AX_MEMORY_FACTS_DB_PATH',
  'AX_MEMORY_EXPORT_HOST_ROOT',
  'AX_MEMORY_EXPORT_NFS_SERVER',
  'AX_MEMORY_EXPORT_NFS_PATH',
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

  it('default render stamps no memory env, mounts, volumes, or PVC', () => {
    const docs = render(['-f', KIND_DEV_VALUES]);
    const { container, spec } = hostSpec(hostDeployment(docs));
    const env = envMap(container);
    for (const name of MEMORY_ENV_NAMES) {
      expect(env.has(name), `${name} must not appear in the default render`).toBe(false);
    }
    const mounts = container.volumeMounts ?? [];
    expect(mounts.find((m) => m.name === 'memory-facts')).toBeUndefined();
    expect(mounts.find((m) => m.name === 'memory-exports')).toBeUndefined();
    const volumes = spec.volumes ?? [];
    expect(volumes.find((v) => v.name === 'memory-facts')).toBeUndefined();
    expect(volumes.find((v) => v.name === 'memory-exports')).toBeUndefined();
    expect(docs.find((d) => (d.metadata?.name ?? '').endsWith('-memory-facts'))).toBeUndefined();
  });

  it('memory mode stamps AX_PRESET + all seven memory env vars from values', () => {
    const { container } = hostSpec(hostDeployment(render(['-f', KIND_DEV_VALUES, ...MEMORY_VALUES])));
    const env = envMap(container);
    expect(env.get('AX_PRESET')).toBe('memory');
    expect(env.get('AX_MEMORY_FACTS_DB_PATH')).toBe('/var/lib/ax-next/memory-facts/facts.db');
    expect(env.get('AX_MEMORY_EXPORT_HOST_ROOT')).toBe('/var/lib/ax-next/memory-exports');
    expect(env.get('AX_MEMORY_EXPORT_NFS_SERVER')).toBe('nfs.example.invalid');
    expect(env.get('AX_MEMORY_EXPORT_NFS_PATH')).toBe('/exports/ax-memory');
    expect(env.get('AX_MEMORY_VERTEX_PROJECT')).toBe('memory-canary');
    expect(env.get('AX_MEMORY_VERTEX_CREDENTIAL_REF')).toBe('provider:vertex');
    expect(env.get('AX_MEMORY_COHERE_CREDENTIAL_REF')).toBe('provider:cohere');
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

  it('channelWeb.agentWorkspace stays off in memory mode — no forced AX_AGENT_WORKSPACE_PREVIEW', () => {
    const { container } = hostSpec(hostDeployment(render(MEMORY_VALUES)));
    const env = envMap(container);
    expect(env.has('AX_AGENT_WORKSPACE_PREVIEW')).toBe(false);
  });

  it('rejects an unknown host.preset', () => {
    const out = renderFails(['--set', 'host.preset=bogus']);
    expect(out).toContain('host.preset');
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
    'host.preset=memory,memory.exports.server=nfs.example.invalid,memory.exports.exportPath=/e',
    'host.preset=memory,memory.vertexProject=p,memory.exports.exportPath=/e',
    'host.preset=memory,memory.vertexProject=p,memory.exports.server=nfs.example.invalid',
  ])('render fails on missing memory fields even with the schema out of the way: %s', (sets) => {
    const out = renderFails(['--set', sets], schemaSkippedChart());
    expect(out).toContain('memory.');
  });

  it.each([
    ['memory.vertexProject', 'host.preset=memory,memory.exports.server=nfs.example.invalid,memory.exports.exportPath=/e'],
    ['memory.exports.server', 'host.preset=memory,memory.vertexProject=p,memory.exports.exportPath=/e'],
    ['memory.exports.exportPath', 'host.preset=memory,memory.vertexProject=p,memory.exports.server=nfs.example.invalid'],
  ])('render fails when %s is missing under host.preset=memory', (field, sets) => {
    const out = renderFails(['--set', sets]);
    expect(out).toContain(field);
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
      '--set',
      'channelWeb.agentWorkspace=true',
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
      '--set',
      'channelWeb.agentWorkspace=true',
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
