import { describe, expect, it } from 'vitest';
import { createK8sPlugins, type K8sPresetConfig } from '@ax/preset-k8s';
import {
  createMemoryPlugins,
  loadMemoryConfigFromEnv,
  DEFAULT_COHERE_CREDENTIAL_REF,
  DEFAULT_VERTEX_CREDENTIAL_REF,
  type MemoryPresetConfig,
} from '../index.js';

const baseK8s: K8sPresetConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  workspace: { backend: 'local', repoRoot: '/tmp/preset-memory-stub/ws' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' } },
  http: {
    host: '127.0.0.1',
    port: 0,
    cookieKey: '0'.repeat(64),
    allowedOrigins: [],
  },
};

const baseConfig: MemoryPresetConfig = {
  ...baseK8s,
  factsDatabasePath: '/tmp/preset-memory-stub/facts/facts.db',
  memoryExportVolume: {
    hostRoot: '/tmp/preset-memory-stub/exports',
    backing: { server: 'nfs.example.invalid', exportPath: '/exports/ax-memory' },
  },
  memoryEmbeddings: { projectId: 'memory-canary' },
};

const names = (cfg: MemoryPresetConfig) =>
  createMemoryPlugins(cfg).map((p) => p.manifest.name);

describe('createMemoryPlugins composition', () => {
  it('drops strata, strata-index-postgres, memory-facts-postgres and the base channel-web', () => {
    const n = names(baseConfig);
    for (const dropped of [
      '@ax/memory-strata',
      '@ax/memory-strata-index-postgres',
      '@ax/memory-facts-postgres',
    ]) {
      expect(n).not.toContain(dropped);
    }
    expect(n.filter((name) => name === '@ax/channel-web')).toHaveLength(1);
  });

  it('loads the sqlite facts engine, embeddings, memory and channel-web', () => {
    const n = names(baseConfig);
    expect(n).toContain('@ax/memory-facts-sqlite');
    expect(n).toContain('@ax/embeddings');
    expect(n).toContain('@ax/memory');
    expect(n).toContain('@ax/channel-web');
  });

  it('enables the rules capability on @ax/memory', () => {
    const memory = createMemoryPlugins(baseConfig).find(
      (p) => p.manifest.name === '@ax/memory',
    );
    expect(memory?.manifest.registers).toContain('memory:rules:read');
    expect(memory?.manifest.registers).toContain('memory:rules:write');
  });

  it('keeps the k8s default assembly on strata when hostLlmTools is set', () => {
    const k8s = createK8sPlugins({ ...baseK8s, hostLlmTools: true }).map(
      (p) => p.manifest.name,
    );
    expect(k8s).toContain('@ax/memory-strata');
    expect(k8s).toContain('@ax/memory-facts-postgres');
    expect(k8s).not.toContain('@ax/memory-facts-sqlite');

    const mem = names({ ...baseConfig, hostLlmTools: true });
    expect(mem).not.toContain('@ax/memory-strata');
    expect(mem).not.toContain('@ax/memory-facts-postgres');
    expect(mem).toContain('@ax/memory-facts-sqlite');
  });

  it('has no duplicate plugin manifest names', () => {
    const n = names(baseConfig);
    expect(new Set(n).size).toBe(n.length);
  });
});

describe('createMemoryPlugins guards', () => {
  it('rejects a relative or root factsDatabasePath', () => {
    expect(() =>
      createMemoryPlugins({ ...baseConfig, factsDatabasePath: 'facts.db' }),
    ).toThrow(/factsDatabasePath/);
    expect(() =>
      createMemoryPlugins({ ...baseConfig, factsDatabasePath: '/' }),
    ).toThrow(/factsDatabasePath/);
  });

  it('rejects a memory exportPath equal to or nested under the filestore exportPath', () => {
    const filestore = {
      server: 'filestore.example.invalid',
      exportPath: '/exports/shared',
    };
    for (const exportPath of [
      '/exports/shared',
      '/exports/shared/memory',
      '/exports',
    ]) {
      expect(() =>
        createMemoryPlugins({
          ...baseConfig,
          filestore,
          memoryExportVolume: {
            hostRoot: '/tmp/preset-memory-stub/exports',
            backing: { server: 'other.example.invalid', exportPath },
          },
        }),
      ).toThrow(/exportPath/);
    }
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        filestore,
        memoryExportVolume: {
          hostRoot: '/tmp/preset-memory-stub/exports',
          backing: {
            server: 'other.example.invalid',
            exportPath: '/exports/memory',
          },
        },
      }),
    ).not.toThrow();
  });

  it.each([
    { filestorePath: '/exports/shared/', memoryPath: '/exports/shared/memory' },
    { filestorePath: '/exports/shared/memory', memoryPath: '/exports/shared/' },
    { filestorePath: '/', memoryPath: '/exports/ax-memory' },
    { filestorePath: '/exports/files', memoryPath: '/' },
    { filestorePath: '/exports/shared/../shared', memoryPath: '/exports/shared/memory' },
  ])(
    'rejects normalized/root export path overlap (filestore $filestorePath vs memory $memoryPath)',
    ({ filestorePath, memoryPath }) => {
      expect(() =>
        createMemoryPlugins({
          ...baseConfig,
          filestore: {
            server: 'filestore.example.invalid',
            exportPath: filestorePath,
          },
          memoryExportVolume: {
            hostRoot: '/tmp/preset-memory-stub/exports',
            backing: { server: 'other.example.invalid', exportPath: memoryPath },
          },
        }),
      ).toThrow(/exportPath/);
    },
  );

  it('rejects a filestore mountPath that normalizes to / or /memory', () => {
    for (const mountPath of ['/', '/tmp/../memory/']) {
      expect(() =>
        createMemoryPlugins({
          ...baseConfig,
          filestore: {
            server: 'filestore.example.invalid',
            exportPath: '/exports/files',
            mountPath,
          },
        }),
      ).toThrow(/mountPath/);
    }
  });

  it('rejects host roots at the filesystem root', () => {
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        workspace: { backend: 'local', repoRoot: '/' },
      }),
    ).toThrow(/hostRoot/);
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        sandbox: { userFilesHostReadRoot: '/' },
      }),
    ).toThrow(/hostRoot/);
  });

  it.each([
    '/tmp/preset-memory-stub/exports/facts.db',
    '/tmp/preset-memory-stub/ws/facts.db',
    '/tmp/preset-memory-stub/userfiles/facts.db',
  ])('rejects factsDatabasePath inside an exposed tree: %s', (factsDatabasePath) => {
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        factsDatabasePath,
        sandbox: { userFilesHostReadRoot: '/tmp/preset-memory-stub/userfiles' },
      }),
    ).toThrow(/factsDatabasePath/);
  });

  it('allows a factsDatabasePath sibling to the exposed roots', () => {
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        factsDatabasePath: '/tmp/preset-memory-stub/facts-dir/facts.db',
        sandbox: { userFilesHostReadRoot: '/tmp/preset-memory-stub/userfiles' },
      }),
    ).not.toThrow();
  });

  it('rejects hostRoot overlapping the workspace repoRoot or userFilesHostReadRoot', () => {
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        memoryExportVolume: {
          hostRoot: '/tmp/preset-memory-stub/ws/exports',
          backing: { server: 'nfs.example.invalid', exportPath: '/e' },
        },
      }),
    ).toThrow(/hostRoot/);
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        sandbox: { userFilesHostReadRoot: '/tmp/preset-memory-stub/exports' },
      }),
    ).toThrow(/hostRoot/);
  });

  it('rejects a filestore mountPath overlapping /memory', () => {
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        filestore: {
          server: 'filestore.example.invalid',
          exportPath: '/exports/files',
          mountPath: '/memory',
        },
      }),
    ).toThrow(/mountPath/);
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        filestore: {
          server: 'filestore.example.invalid',
          exportPath: '/exports/files',
          mountPath: '/files',
        },
      }),
    ).not.toThrow();
  });

  it('rejects a non-boolean agentWorkspacePreview and blank projectId', () => {
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        agentWorkspacePreview: 'yes' as unknown as boolean,
      }),
    ).toThrow(/agentWorkspacePreview/);
    expect(() =>
      createMemoryPlugins({
        ...baseConfig,
        memoryEmbeddings: { projectId: '' },
      }),
    ).toThrow(/projectId/);
  });
});

describe('loadMemoryConfigFromEnv', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://x',
    AX_K8S_HOST_IPC_URL: 'http://host:80',
    AX_WORKSPACE_BACKEND: 'local',
    AX_WORKSPACE_ROOT: '/var/lib/ax-next/workspaces',
    AX_HTTP_HOST: '0.0.0.0',
    AX_HTTP_PORT: '9090',
    AX_HTTP_COOKIE_KEY: '0'.repeat(64),
    AX_MEMORY_FACTS_DB_PATH: '/var/lib/ax-next/memory-facts/facts.db',
    AX_MEMORY_EXPORT_HOST_ROOT: '/var/lib/ax-next/memory-exports',
    AX_MEMORY_EXPORT_NFS_SERVER: 'nfs.example.invalid',
    AX_MEMORY_EXPORT_NFS_PATH: '/exports/ax-memory',
    AX_MEMORY_VERTEX_PROJECT: 'memory-canary',
  };

  it('loads a complete config with credential-ref defaults', () => {
    const cfg = loadMemoryConfigFromEnv(baseEnv);
    expect(cfg.factsDatabasePath).toBe('/var/lib/ax-next/memory-facts/facts.db');
    expect(cfg.memoryExportVolume).toEqual({
      hostRoot: '/var/lib/ax-next/memory-exports',
      backing: {
        server: 'nfs.example.invalid',
        exportPath: '/exports/ax-memory',
      },
    });
    expect(cfg.memoryEmbeddings).toEqual({
      projectId: 'memory-canary',
      embedCredentialRef: DEFAULT_VERTEX_CREDENTIAL_REF,
      rerankCredentialRef: DEFAULT_COHERE_CREDENTIAL_REF,
    });
    expect(cfg.agentWorkspacePreview).toBe(false);
    expect(cfg.database).toEqual({ connectionString: 'postgres://x' });
  });

  it.each([
    'AX_MEMORY_FACTS_DB_PATH',
    'AX_MEMORY_EXPORT_HOST_ROOT',
    'AX_MEMORY_EXPORT_NFS_SERVER',
    'AX_MEMORY_EXPORT_NFS_PATH',
    'AX_MEMORY_VERTEX_PROJECT',
  ])('throws naming %s when it is missing', (name) => {
    const env = { ...baseEnv };
    delete env[name];
    expect(() => loadMemoryConfigFromEnv(env)).toThrow(new RegExp(name));
  });

  it('honors explicit credential refs', () => {
    const cfg = loadMemoryConfigFromEnv({
      ...baseEnv,
      AX_MEMORY_VERTEX_CREDENTIAL_REF: 'provider:vertex-alt',
      AX_MEMORY_COHERE_CREDENTIAL_REF: 'provider:cohere-alt',
    });
    expect(cfg.memoryEmbeddings.embedCredentialRef).toBe('provider:vertex-alt');
    expect(cfg.memoryEmbeddings.rerankCredentialRef).toBe('provider:cohere-alt');
  });

  it('parses AX_AGENT_WORKSPACE_PREVIEW strictly', () => {
    expect(
      loadMemoryConfigFromEnv({ ...baseEnv, AX_AGENT_WORKSPACE_PREVIEW: '1' })
        .agentWorkspacePreview,
    ).toBe(true);
    expect(
      loadMemoryConfigFromEnv({ ...baseEnv, AX_AGENT_WORKSPACE_PREVIEW: 'false' })
        .agentWorkspacePreview,
    ).toBe(false);
    expect(() =>
      loadMemoryConfigFromEnv({ ...baseEnv, AX_AGENT_WORKSPACE_PREVIEW: 'yes' }),
    ).toThrow(/AX_AGENT_WORKSPACE_PREVIEW/);
    for (const bad of ['TRUE', 'False', '2', 'on']) {
      expect(() =>
        loadMemoryConfigFromEnv({ ...baseEnv, AX_AGENT_WORKSPACE_PREVIEW: bad }),
      ).toThrow(/AX_AGENT_WORKSPACE_PREVIEW/);
    }
  });
});
