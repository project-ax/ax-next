// Chart render tests for the blob backend wiring (out-of-git design Part A,
// TASK-71). Mirrors render.test.ts's posture: shell out to `helm template`,
// parse the multi-doc YAML, and assert on the result. Gated on `helm` being on
// PATH (AX_REQUIRE_HELM=1 in CI's helm-render lane makes a missing helm a hard
// failure rather than a silent skip).
//
// We assert:
//   - default render → AX_BLOB_BACKEND=fs, no MinIO resources, no s3 env
//   - blob.backend=s3 (GCS prod shape) → s3 env stamped, NO static keys
//     (Workload Identity), no MinIO resources
//   - minio.enabled=true (kind-dev shape) → MinIO Deployment+Service+Secret+Job
//     render, AX_BLOB_S3_* points at the in-cluster MinIO, static keys come
//     from the MinIO Secret via secretKeyRef (never a literal)
//   - the validateBlobBackend guard fails the template on a misconfigured s3

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAll } from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';

import { HELM_REQUIRED_MESSAGE, resolveHelmGate } from './helm-required.js';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');
const KIND_DEV_VALUES = resolve(chartDir, 'kind-dev-values.yaml');

const REQUIRED = [
  '--set',
  'credentials.key=test',
  '--set',
  'anthropic.apiKey=test',
  '--set',
  'http.cookieKey=0000000000000000000000000000000000000000000000000000000000000000',
];

type EnvVar = { name?: string; value?: string; valueFrom?: unknown };
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
    ['template', 'ax-test', chartDir, '--namespace', 'default', ...REQUIRED, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return (loadAll(out) as Array<K8sDoc | null>).filter(
    (d): d is K8sDoc => d != null && typeof d === 'object',
  );
}

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
    'helm CLI not available; blob-backend chart-render tests skipped — run with helm in PATH for full coverage',
  );
}

if (GATE.mode === 'require-missing') {
  describe('blob-backend chart-render: helm required', () => {
    it('helm must be installed when AX_REQUIRE_HELM is set', () => {
      throw new Error(HELM_REQUIRED_MESSAGE);
    });
  });
}

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

function hostDeployment(docs: K8sDoc[]): K8sDoc {
  const dep = docs.find(
    (d) => d.kind === 'Deployment' && (d.metadata?.name ?? '').endsWith('-host'),
  );
  if (dep === undefined) throw new Error('host Deployment not found in render');
  return dep;
}

function hostEnv(docs: K8sDoc[]): EnvVar[] {
  const spec = hostDeployment(docs).spec as {
    template?: { spec?: { containers?: Array<{ env?: EnvVar[] }> } };
  };
  return spec?.template?.spec?.containers?.[0]?.env ?? [];
}

function envVal(env: EnvVar[], name: string): EnvVar | undefined {
  return env.find((e) => e.name === name);
}

describeIfHelm('ax-next chart: blob backend wiring (out-of-git Part A)', () => {
  beforeAll(() => {
    if (!HELM) return;
    let lastReason = '';
    for (let i = 0; i < 3; i += 1) {
      const out = helmRepoSync();
      if (out.ok) return;
      lastReason = out.reason;
    }
    throw new Error(`helm dependency build failed after 3 attempts: ${lastReason}`);
  });

  it('default render stamps AX_BLOB_BACKEND=fs and renders no MinIO', () => {
    const docs = helmTemplate([]);
    const env = hostEnv(docs);
    expect(envVal(env, 'AX_BLOB_BACKEND')?.value).toBe('fs');
    // fs.root defaults empty → preset derives it → no AX_BLOB_FS_ROOT stamped.
    expect(envVal(env, 'AX_BLOB_FS_ROOT')).toBeUndefined();
    // No s3 env on the fs path.
    expect(envVal(env, 'AX_BLOB_S3_BUCKET')).toBeUndefined();
    // No MinIO resources.
    const minio = docs.filter((d) => (d.metadata?.name ?? '').includes('-minio'));
    expect(minio).toEqual([]);
  });

  it('explicit blob.fs.root stamps AX_BLOB_FS_ROOT', () => {
    const env = hostEnv(helmTemplate(['--set', 'blob.fs.root=/mnt/custom-blobs']));
    expect(envVal(env, 'AX_BLOB_FS_ROOT')?.value).toBe('/mnt/custom-blobs');
  });

  it('GCS prod shape (s3 + explicit endpoint, no MinIO) stamps s3 env with NO static keys', () => {
    const docs = helmTemplate([
      '--set',
      'blob.backend=s3',
      '--set',
      'blob.s3.bucket=ax-prod-blobs',
      '--set',
      'blob.s3.endpoint=https://storage.googleapis.com',
      '--set',
      'blob.s3.region=us-central1',
    ]);
    const env = hostEnv(docs);
    expect(envVal(env, 'AX_BLOB_BACKEND')?.value).toBe('s3');
    expect(envVal(env, 'AX_BLOB_S3_BUCKET')?.value).toBe('ax-prod-blobs');
    expect(envVal(env, 'AX_BLOB_S3_ENDPOINT')?.value).toBe('https://storage.googleapis.com');
    expect(envVal(env, 'AX_BLOB_S3_REGION')?.value).toBe('us-central1');
    expect(envVal(env, 'AX_BLOB_S3_FORCE_PATH_STYLE')?.value).toBe('true');
    // The whole point of the GCS path: NO static keys in the tree (Workload
    // Identity). Neither key var is stamped.
    expect(envVal(env, 'AX_BLOB_S3_ACCESS_KEY_ID')).toBeUndefined();
    expect(envVal(env, 'AX_BLOB_S3_SECRET_ACCESS_KEY')).toBeUndefined();
    // No MinIO on the prod path.
    expect(docs.filter((d) => (d.metadata?.name ?? '').includes('-minio'))).toEqual([]);
  });

  it('kind-dev shape (minio.enabled) renders MinIO + points the host s3 client at it', () => {
    const docs = helmTemplate(['-f', KIND_DEV_VALUES]);
    // MinIO Deployment + Service + Secret render (the Job is a hook, excluded
    // from `helm template` default output, so we don't assert it here).
    const kinds = docs
      .filter((d) => (d.metadata?.name ?? '').includes('-minio'))
      .map((d) => d.kind)
      .sort();
    expect(kinds).toContain('Deployment');
    expect(kinds).toContain('Service');
    expect(kinds).toContain('Secret');

    const env = hostEnv(docs);
    expect(envVal(env, 'AX_BLOB_BACKEND')?.value).toBe('s3');
    expect(envVal(env, 'AX_BLOB_S3_BUCKET')?.value).toBe('ax-blobs');
    expect(envVal(env, 'AX_BLOB_S3_ENDPOINT')?.value).toContain('-minio.');
    // Dev static keys come from the MinIO Secret via secretKeyRef — never a
    // literal in the manifest (no committed / inlined secret).
    const accessKey = envVal(env, 'AX_BLOB_S3_ACCESS_KEY_ID');
    const secretKey = envVal(env, 'AX_BLOB_S3_SECRET_ACCESS_KEY');
    expect(accessKey?.valueFrom).toBeDefined();
    expect(accessKey?.value).toBeUndefined();
    expect(secretKey?.valueFrom).toBeDefined();
    expect(secretKey?.value).toBeUndefined();
  });

  it('the MinIO Secret never inlines a plaintext password value', () => {
    const docs = helmTemplate(['-f', KIND_DEV_VALUES]);
    const secret = docs.find(
      (d) => d.kind === 'Secret' && (d.metadata?.name ?? '').includes('-minio'),
    );
    expect(secret).toBeDefined();
    // The password lives base64'd under data.root-password — it's a generated
    // value, not the (empty) values default. We only assert it's present +
    // non-empty; the point is it's NOT sourced from a committed literal.
    const data = (secret as { data?: Record<string, string> }).data ?? {};
    expect(typeof data['root-password']).toBe('string');
    expect((data['root-password'] ?? '').length).toBeGreaterThan(0);
  });

  it('validateBlobBackend FAILS the template for s3 with no endpoint and no MinIO', () => {
    const { status, stderr } = helmTemplateExpectFailure(['--set', 'blob.backend=s3']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/blob\.backend=s3 requires/);
  });
});
