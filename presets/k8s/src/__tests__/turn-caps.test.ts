import { describe, expect, it } from 'vitest';
import { checkNodeFit, checkTurnCaps } from '../turn-caps.js';

describe('checkTurnCaps', () => {
  it('refuses a turn cap within 20 min of the pod ceiling', () => {
    // 6 h pod: 120 min + 20 min is fine; 340 min + 20 min is exactly the ceiling.
    expect(() => checkTurnCaps({ maxTurnMinutes: 120, activeDeadlineSeconds: 21600 })).not.toThrow();
    expect(() => checkTurnCaps({ maxTurnMinutes: 340, activeDeadlineSeconds: 21600 })).not.toThrow();
    expect(() => checkTurnCaps({ maxTurnMinutes: 341, activeDeadlineSeconds: 21600 })).toThrow(
      /maxTurnMinutes=341/,
    );
    expect(() => checkTurnCaps({ maxTurnMinutes: 120, activeDeadlineSeconds: 7200 })).toThrow(/20 minutes/);
  });
});

describe('checkNodeFit', () => {
  it('node-fit warns when runner max plus a service set exceeds the node', () => {
    const w = checkNodeFit({ runnerMaxMiB: 16384, largestServiceSetMiB: 3072, nodeAllocatableMiB: 12000 });
    expect(w).toMatch(/19456 MiB/);
    expect(w).toMatch(/12000 MiB/);
  });
  it('is quiet when it fits, or when the node size is unknown', () => {
    expect(checkNodeFit({ runnerMaxMiB: 8192, largestServiceSetMiB: 3072, nodeAllocatableMiB: 12000 })).toBeNull();
    expect(checkNodeFit({ runnerMaxMiB: 16384, largestServiceSetMiB: 3072 })).toBeNull();
  });
});

describe('runner max env', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    AX_K8S_HOST_IPC_URL: 'http://host:80',
    AX_HTTP_HOST: '0.0.0.0',
    AX_HTTP_PORT: '9090',
    AX_HTTP_COOKIE_KEY: '0'.repeat(64),
    AX_CONTENT_ORIGIN: 'http://127.0.0.1:9091',
    AX_CONTENT_PORT: '0',
    AX_CONTENT_FRAME_ANCESTORS: 'http://localhost:9090',
    AX_HTTP_ALLOWED_ORIGINS: 'https://admin.ax-next.example',
    AX_FILESTORE_SERVER: '10.9.8.7',
    AX_FILESTORE_EXPORT_PATH: '/vol1',
    AX_BLOB_FS_ROOT: '/var/lib/ax-next/blobs',
  };
  it('K8S_RUNNER_MAX_CPU_MILLIS and K8S_RUNNER_MAX_MEMORY_MIB load as numbers', async () => {
    const { loadK8sConfigFromEnv } = await import('../index.js');
    const cfg = loadK8sConfigFromEnv({ ...base, K8S_RUNNER_MAX_CPU_MILLIS: '8000', K8S_RUNNER_MAX_MEMORY_MIB: '16384' });
    expect(cfg.sandbox?.runnerMaxCpuMillis).toBe(8000);
    expect(cfg.sandbox?.runnerMaxMemoryMiB).toBe(16384);
    expect(() => loadK8sConfigFromEnv({ ...base, K8S_RUNNER_MAX_CPU_MILLIS: '8k' })).toThrow(/K8S_RUNNER_MAX_CPU_MILLIS/);
  });

  it('AX_CHAT_MAX_TURN_MINUTES and AX_CHAT_MAX_IDLE_MINUTES load as numbers', async () => {
    const { loadK8sConfigFromEnv } = await import('../index.js');
    const cfg = loadK8sConfigFromEnv({ ...base, AX_CHAT_MAX_TURN_MINUTES: '120', AX_CHAT_MAX_IDLE_MINUTES: '60' });
    expect(cfg.chat?.maxTurnMinutes).toBe(120);
    expect(cfg.chat?.maxIdleMinutes).toBe(60);
    expect(loadK8sConfigFromEnv(base).chat?.maxIdleMinutes).toBeUndefined();
    expect(() => loadK8sConfigFromEnv({ ...base, AX_CHAT_MAX_IDLE_MINUTES: '0' })).toThrow(/AX_CHAT_MAX_IDLE_MINUTES/);
  });
});
