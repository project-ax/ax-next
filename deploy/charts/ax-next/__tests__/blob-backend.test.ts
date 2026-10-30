// Chart render tests for the blob backend wiring (out-of-git design Part A,
// TASK-71). Mirrors render.test.ts's posture: shell out to `helm template`,
// parse the multi-doc YAML, and assert on the result. Gated on `helm` being on
// PATH (AX_REQUIRE_HELM=1 in CI's helm-render lane makes a missing helm a hard
// failure rather than a silent skip).
//
// We assert:
//   - default render → AX_BLOB_BACKEND=fs, no MinIO resources, no s3 env
//   - the fs root is pinned (TASK-992): AX_BLOB_FS_ROOT is always stamped,
//     byte-identical to the path the preset used to derive, on the host PVC,
//     and an empty or off-volume root fails the template, naming the path
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
import { describe, expect, it } from 'vitest';

import { HELM_REQUIRED_MESSAGE, resolveHelmGate } from './helm-required.js';

const here = dirname(fileURLToPath(import.meta.url));
const chartDir = resolve(here, '..');
const KIND_DEV_VALUES = resolve(chartDir, 'kind-dev-values.yaml');
const GKE_VALUES = resolve(chartDir, 'gke-values.yaml');
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

// The subchart fetch this file used to run in its own `beforeAll` now happens
// once per run in vitest's globalSetup — see __tests__/helm-deps.ts (TASK-316).

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

/**
 * The blob root TASK-992 pins. It is exactly what the preset used to derive on
 * GKE and on a default install (`<workspace.mountPath>/blobs`, the local
 * workspace backend), so pinning it moves nothing.
 */
const PINNED_ROOT = '/var/lib/ax-next/workspaces/blobs';

/** The two fs renders that carry real blobs: a default install and the GKE overlay. */
const FS_RENDERS: ReadonlyArray<readonly [label: string, args: readonly string[]]> = [
  ['default render', []],
  ['gke-values.yaml', ['-f', GKE_VALUES, '--set', 'sandbox.filestore.server=10.9.8.7']],
];

type HostPodSpec = {
  containers?: Array<{ volumeMounts?: Array<{ name?: string; mountPath?: string }> }>;
  volumes?: Array<{ name?: string; persistentVolumeClaim?: { claimName?: string } }>;
};

describeIfHelm('ax-next chart: blob backend wiring (out-of-git Part A)', () => {
  it('default render stamps AX_BLOB_BACKEND=fs and renders no MinIO', () => {
    const docs = helmTemplate([]);
    const env = hostEnv(docs);
    expect(envVal(env, 'AX_BLOB_BACKEND')?.value).toBe('fs');
    // TASK-992: the fs root is explicit config, stamped on every fs render.
    expect(envVal(env, 'AX_BLOB_FS_ROOT')?.value).toBe(PINNED_ROOT);
    // No s3 env on the fs path.
    expect(envVal(env, 'AX_BLOB_S3_BUCKET')).toBeUndefined();
    // No MinIO resources.
    const minio = docs.filter((d) => (d.metadata?.name ?? '').includes('-minio'));
    expect(minio).toEqual([]);
  });

  it('explicit blob.fs.root stamps AX_BLOB_FS_ROOT', () => {
    // Under the workspace volume's mount: a root off it fails by design (below).
    const env = hostEnv(
      helmTemplate(['--set', 'blob.fs.root=/var/lib/ax-next/workspaces/custom-blobs']),
    );
    expect(envVal(env, 'AX_BLOB_FS_ROOT')?.value).toBe('/var/lib/ax-next/workspaces/custom-blobs');
  });

  it('the pinned root is byte-identical to the old derivation', () => {
    // The preset used to derive `${AX_WORKSPACE_ROOT}/blobs` when nothing was
    // stamped. Any other value here would quietly start a new, empty blob
    // store and orphan every existing attachment, artifact and skill file.
    for (const [label, args] of FS_RENDERS) {
      const env = hostEnv(helmTemplate(args));
      const root = envVal(env, 'AX_BLOB_FS_ROOT')?.value;
      expect(root, label).toBe(`${envVal(env, 'AX_WORKSPACE_ROOT')?.value}/blobs`);
      expect(root, label).toBe(PINNED_ROOT);
    }
  });

  it('AX_BLOB_FS_ROOT lies on the host PVC mount', () => {
    // The `<release>-workspace` PVC holds blobs/ as well as the bare repos.
    // When the workspace backend goes away (TASK-995, chart cleanup), this
    // goes red unless the PVC and its host mount stay.
    for (const [label, args] of FS_RENDERS) {
      const docs = helmTemplate(args);
      const pvcName = docs.find(
        (d) =>
          d.kind === 'PersistentVolumeClaim' && (d.metadata?.name ?? '').endsWith('-workspace'),
      )?.metadata?.name;
      expect(pvcName, `${label}: the host's -workspace PVC renders`).toBeDefined();

      const podSpec = (hostDeployment(docs).spec as { template?: { spec?: HostPodSpec } })
        ?.template?.spec;
      const volume = (podSpec?.volumes ?? []).find(
        (v) => v.persistentVolumeClaim?.claimName === pvcName,
      );
      expect(volume, `${label}: a host volume claims ${pvcName}`).toBeDefined();
      const mountPath = (podSpec?.containers?.[0]?.volumeMounts ?? []).find(
        (m) => m.name === volume?.name,
      )?.mountPath;
      expect(mountPath, `${label}: the host container mounts ${volume?.name}`).toBeDefined();

      const root = envVal(hostEnv(docs), 'AX_BLOB_FS_ROOT')?.value ?? '';
      expect(root.startsWith(`${mountPath}/`), `${label}: ${root} is under ${mountPath}/`).toBe(
        true,
      );
    }
  });

  it('an empty blob.fs.root fails the render and names the path to pin', () => {
    // What a `helm upgrade --reuse-values` from a pre-TASK-992 release sees:
    // the live values carry the old default, an empty root. Failing, with the
    // exact `--set` to pin, beats silently starting a new blob directory.
    const atDefault = helmTemplateExpectFailure(['--set', 'blob.fs.root=']);
    expect(atDefault.status).not.toBe(0);
    expect(atDefault.stderr).toContain('blob.fs.root is empty');
    expect(atDefault.stderr).toContain(`--set blob.fs.root=${PINNED_ROOT}`);

    // The hint is computed from workspace.mountPath, so a custom mount gets
    // its own path, not the default one.
    const custom = helmTemplateExpectFailure([
      '--set',
      'blob.fs.root=',
      '--set',
      'workspace.mountPath=/data/ws',
    ]);
    expect(custom.status).not.toBe(0);
    expect(custom.stderr).toContain('blob.fs.root is empty');
    expect(custom.stderr).toContain('--set blob.fs.root=/data/ws/blobs');
  });

  it('a blob.fs.root off the workspace volume fails the render', () => {
    for (const root of [
      '/mnt/custom-blobs',
      // A sibling that merely shares the mount path's spelling is still off it.
      '/var/lib/ax-next/workspaces-old/blobs',
    ]) {
      const r = helmTemplateExpectFailure(['--set', `blob.fs.root=${root}`]);
      expect(r.status, root).not.toBe(0);
      expect(r.stderr, root).toContain("is not on the host's workspace volume");
      expect(r.stderr, root).toContain(PINNED_ROOT);
    }
  });

  it('a custom workspace.mountPath with the default blob root fails, naming <mountPath>/blobs', () => {
    // An install with its own mountPath that upgrades with `-f` values (not
    // --reuse-values) picks up the pinned default, which is off its PVC.
    const r = helmTemplateExpectFailure(['--set', 'workspace.mountPath=/data/ws']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not on the host's workspace volume");
    expect(r.stderr).toContain('/data/ws/blobs');

    // ...and pinning the path the message names renders (with or without a
    // trailing slash on the mount path).
    for (const mountPath of ['/data/ws', '/data/ws/']) {
      const env = hostEnv(
        helmTemplate([
          '--set',
          `workspace.mountPath=${mountPath}`,
          '--set',
          'blob.fs.root=/data/ws/blobs',
        ]),
      );
      expect(envVal(env, 'AX_BLOB_FS_ROOT')?.value, mountPath).toBe('/data/ws/blobs');
    }
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
    // s3 has no fs root: the pinned blob.fs.root is not stamped here.
    expect(envVal(env, 'AX_BLOB_FS_ROOT')).toBeUndefined();
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

  it('the mkbucket Job sets MC_CONFIG_DIR to a writable path (non-root crashloop fix)', () => {
    // TASK-80 regression: the Job runs as runAsUser 1000 with no HOME, so `mc`
    // tried to write its config to the default ~/.mc (== /.mc) and crashlooped
    // with `mkdir /.mc: permission denied`. It must point MC_CONFIG_DIR at a
    // world-writable path (under /tmp) so a non-root user can write its config.
    const docs = helmTemplate(['-f', KIND_DEV_VALUES]);
    const job = docs.find(
      (d) =>
        d.kind === 'Job' &&
        (d.metadata?.name ?? '').includes('-minio') &&
        (d.metadata?.name ?? '').endsWith('-mkbucket'),
    );
    expect(job, 'mkbucket Job should render under helm template (it is a hook)').toBeDefined();
    const spec = (job as K8sDoc).spec as {
      template?: { spec?: { containers?: Array<{ env?: EnvVar[] }> } };
    };
    const env = spec?.template?.spec?.containers?.[0]?.env ?? [];
    const cfgDir = env.find((e) => e.name === 'MC_CONFIG_DIR');
    expect(cfgDir, 'MC_CONFIG_DIR must be set so `mc` can write config as non-root').toBeDefined();
    expect(typeof cfgDir?.value).toBe('string');
    // Must resolve under /tmp (world-writable) and not the un-writable root
    // home dir that caused the crashloop.
    expect(cfgDir?.value).toMatch(/^\/tmp\//);
    expect(cfgDir?.value).not.toBe('/.mc');
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
