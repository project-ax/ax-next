import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ sandbox: undefined as Record<string, unknown> | undefined }));
vi.mock('@ax/sandbox-k8s', async importOriginal => {
  const actual = await importOriginal<typeof import('@ax/sandbox-k8s')>();
  return { ...actual, createSandboxK8sPlugin: (config: Parameters<typeof actual.createSandboxK8sPlugin>[0]) => {
    state.sandbox = config as Record<string, unknown>; return actual.createSandboxK8sPlugin(config);
  } };
});
const { createK8sPlugins, loadK8sConfigFromEnv } = await import('../index.js');
const environment = () => ({ DATABASE_URL: 'postgres://u:p@db:5432/ax', AX_K8S_HOST_IPC_URL: 'http://host:8080',
  AX_WORKSPACE_BACKEND: 'local', AX_WORKSPACE_ROOT: '/tmp/ax-preset', AX_HTTP_HOST: '0.0.0.0', AX_HTTP_PORT: '8080',
  AX_HTTP_COOKIE_KEY: '0'.repeat(64), K8S_SANDBOX_BACKEND: 'agent-sandbox', K8S_PROXY_ENDPOINT: 'http://proxy:8888',
  K8S_SHARED_POOL_REPLICAS: '2', K8S_SHARED_POOL_PREFIX: 'shared', K8S_SHARED_POOL_STORAGE_NAMESPACE: 'storage',
  K8S_SHARED_POOL_SERVER_NAME: 'storage.storage.svc', AX_FILESTORE_SERVER: '10.0.0.9', AX_FILESTORE_EXPORT_PATH: '/files',
  AX_MEMORY_EXPORT_NFS_SERVER: '10.0.0.10', AX_MEMORY_EXPORT_NFS_PATH: '/memory' });
describe('shared pool production assembly', () => {
  it('threads chart configuration, both runner binaries, and resolver backing into the real sandbox plugin', () => {
    const config = loadK8sConfigFromEnv(environment()); createK8sPlugins(config);
    const pool = state.sandbox?.sharedPool as { runnerBinaries: Record<string, string> };
    expect(pool).toMatchObject({ replicas: 2, prefix: 'shared', storageNamespace: 'storage',
      tlsDirectory: '/var/run/ax-storage-tls', serverName: 'storage.storage.svc',
      userFiles: { server: '10.0.0.9', exportPath: '/files' }, memory: { server: '10.0.0.10', exportPath: '/memory' } });
    expect(Object.keys(pool.runnerBinaries).sort()).toEqual(['aisdk', 'claude-sdk']);
    expect(pool.runnerBinaries['claude-sdk']).toContain('agent-claude-sdk-runner');
    expect(pool.runnerBinaries.aisdk).toContain('agent-aisdk-runner');
  });
  it('refuses enabling the shared path without its durable mount resolver', () => {
    const env: NodeJS.ProcessEnv = environment(); delete env.AX_FILESTORE_SERVER;
    expect(() => loadK8sConfigFromEnv(env)).toThrow('configured Filestore');
  });
});
