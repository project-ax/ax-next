import { describe, expect, it } from 'vitest';
import {
  blobConfigFromEnv,
  createK8sPlugins,
  loadK8sConfigFromEnv,
  type K8sPresetConfig,
} from '../index.js';

// ---------------------------------------------------------------------------
// TASK-71 — per-deployment fs|s3 blob backend selection.
//
// The k8s preset registers EXACTLY ONE of @ax/blob-store-fs / @ax/blob-store-s3
// behind the storage-agnostic blob:* hook, mirroring the storage-sqlite /
// storage-postgres and workspace local / git-protocol splits. Two registrants
// of blob:put would make bootstrap throw, so "exactly one" is load-bearing.
// ---------------------------------------------------------------------------

const baseConfig: Omit<K8sPresetConfig, 'blob'> = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinary: '/tmp/stub-runner.js' },
  http: {
    host: '127.0.0.1',
    port: 0,
    cookieKey: '0'.repeat(64),
    allowedOrigins: [],
  },
};

const blobBackends = (cfg: K8sPresetConfig): string[] =>
  createK8sPlugins(cfg)
    .filter((p) =>
      ['@ax/blob-store-fs', '@ax/blob-store-s3'].includes(p.manifest.name),
    )
    .map((p) => p.manifest.name);

describe('blob backend selection in createK8sPlugins', () => {
  it('defaults to the fs backend when blob config is absent', () => {
    expect(blobBackends({ ...baseConfig })).toEqual(['@ax/blob-store-fs']);
  });

  it('selects ONLY the fs backend when blob.backend=fs', () => {
    expect(
      blobBackends({ ...baseConfig, blob: { backend: 'fs', root: '/tmp/blobs' } }),
    ).toEqual(['@ax/blob-store-fs']);
  });

  it('selects ONLY the s3 backend when blob.backend=s3', () => {
    expect(
      blobBackends({
        ...baseConfig,
        blob: {
          backend: 's3',
          bucket: 'ax-blobs',
          endpoint: 'http://minio.ax-next.svc.cluster.local:9000',
          region: 'us-east-1',
        },
      }),
    ).toEqual(['@ax/blob-store-s3']);
  });

  it('registers exactly one blob:put registrant regardless of backend', () => {
    for (const cfg of [
      { ...baseConfig },
      { ...baseConfig, blob: { backend: 'fs' as const, root: '/tmp/b' } },
      {
        ...baseConfig,
        blob: {
          backend: 's3' as const,
          bucket: 'b',
          endpoint: 'http://minio:9000',
        },
      },
    ]) {
      const registrants = createK8sPlugins(cfg).filter((p) =>
        p.manifest.registers.includes('blob:put'),
      );
      expect(registrants.map((p) => p.manifest.name)).toHaveLength(1);
    }
  });
});

describe('blobConfigFromEnv', () => {
  it('defaults to fs with a root derived from the workspace root', () => {
    const cfg = blobConfigFromEnv(
      { AX_WORKSPACE_ROOT: '/var/lib/ax-next/workspaces' },
      { backend: 'local', repoRoot: '/var/lib/ax-next/workspaces' },
    );
    expect(cfg).toEqual({
      backend: 'fs',
      root: '/var/lib/ax-next/workspaces/blobs',
    });
  });

  it('honors an explicit AX_BLOB_FS_ROOT for the fs backend', () => {
    const cfg = blobConfigFromEnv(
      { AX_BLOB_BACKEND: 'fs', AX_BLOB_FS_ROOT: '/mnt/blobs' },
      { backend: 'local', repoRoot: '/var/lib/ax-next/workspaces' },
    );
    expect(cfg).toEqual({ backend: 'fs', root: '/mnt/blobs' });
  });

  it('reads the s3 backend env (no static keys = Workload Identity path)', () => {
    const cfg = blobConfigFromEnv(
      {
        AX_BLOB_BACKEND: 's3',
        AX_BLOB_S3_BUCKET: 'ax-prod-blobs',
        AX_BLOB_S3_ENDPOINT: 'https://storage.googleapis.com',
        AX_BLOB_S3_REGION: 'us-central1',
      },
      { backend: 'git-protocol', baseUrl: 'http://gs', token: 't' },
    );
    expect(cfg).toEqual({
      backend: 's3',
      bucket: 'ax-prod-blobs',
      endpoint: 'https://storage.googleapis.com',
      region: 'us-central1',
    });
  });

  it('reads optional s3 static keys (MinIO dev) when present', () => {
    const cfg = blobConfigFromEnv(
      {
        AX_BLOB_BACKEND: 's3',
        AX_BLOB_S3_BUCKET: 'ax-blobs',
        AX_BLOB_S3_ENDPOINT: 'http://minio:9000',
        AX_BLOB_S3_ACCESS_KEY_ID: 'minioadmin',
        AX_BLOB_S3_SECRET_ACCESS_KEY: 'minio-secret',
        AX_BLOB_S3_FORCE_PATH_STYLE: 'true',
      },
      { backend: 'local', repoRoot: '/w' },
    );
    expect(cfg).toMatchObject({
      backend: 's3',
      bucket: 'ax-blobs',
      endpoint: 'http://minio:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minio-secret',
      forcePathStyle: true,
    });
  });

  it('throws when s3 backend is selected without a bucket', () => {
    expect(() =>
      blobConfigFromEnv(
        { AX_BLOB_BACKEND: 's3', AX_BLOB_S3_ENDPOINT: 'http://minio:9000' },
        { backend: 'local', repoRoot: '/w' },
      ),
    ).toThrow(/AX_BLOB_S3_BUCKET/);
  });

  it('throws on an unknown backend value', () => {
    expect(() =>
      blobConfigFromEnv({ AX_BLOB_BACKEND: 'gcs-native' }, {
        backend: 'local',
        repoRoot: '/w',
      }),
    ).toThrow(/AX_BLOB_BACKEND/);
  });

  it('never echoes the secret key in a thrown error', () => {
    // Missing bucket but a secret present — the error must name the missing
    // var, never leak the secret literal into a log line.
    let msg = '';
    try {
      blobConfigFromEnv(
        {
          AX_BLOB_BACKEND: 's3',
          AX_BLOB_S3_ENDPOINT: 'http://minio:9000',
          AX_BLOB_S3_SECRET_ACCESS_KEY: 'super-secret-do-not-leak',
        },
        { backend: 'local', repoRoot: '/w' },
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('super-secret-do-not-leak');
  });
});

describe('loadK8sConfigFromEnv blob wiring', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://x',
    AX_K8S_HOST_IPC_URL: 'http://host:80',
    AX_WORKSPACE_BACKEND: 'local',
    AX_WORKSPACE_ROOT: '/var/lib/ax-next/workspaces',
    AX_HTTP_HOST: '0.0.0.0',
    AX_HTTP_PORT: '9090',
    AX_HTTP_COOKIE_KEY: '0'.repeat(64),
  };

  it('defaults the blob backend to fs (root under the workspace PVC)', () => {
    const cfg = loadK8sConfigFromEnv(baseEnv);
    expect(cfg.blob).toEqual({
      backend: 'fs',
      root: '/var/lib/ax-next/workspaces/blobs',
    });
  });

  it('selects s3 when AX_BLOB_BACKEND=s3 + required vars are set', () => {
    const cfg = loadK8sConfigFromEnv({
      ...baseEnv,
      AX_BLOB_BACKEND: 's3',
      AX_BLOB_S3_BUCKET: 'ax-blobs',
      AX_BLOB_S3_ENDPOINT: 'http://minio.ax-next.svc.cluster.local:9000',
    });
    expect(cfg.blob).toMatchObject({ backend: 's3', bucket: 'ax-blobs' });
  });
});
