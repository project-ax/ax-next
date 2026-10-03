import { describe, expect, it } from 'vitest';
import type { K8sPresetConfig } from '@ax/preset-k8s';
import { bootPluginGraph } from '@ax/test-harness';
import {
  createMemoryPlugins,
  loadMemoryConfigFromEnv,
  type MemoryPresetConfig,
} from '../index.js';

// TASK-759 — the deployed host is THIS preset, and with the memory export
// volume configured (as on kind and GKE) `@ax/memory` registers
// `sandbox:memory-mounts`. That registration closed a call cycle
//   usage-limits → chat-orchestrator → sandbox-k8s → memory → llm-openrouter → usage-limits
// and the host crash-looped on boot while CI stayed green: no test pushed this
// preset's full plugin list through the kernel's graph checks. This one does,
// for the main deployable shapes (hand-built configs plus one assembled by the
// real env loader). No Docker, no Postgres.

const baseK8s: K8sPresetConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  workspace: { backend: 'local', repoRoot: '/tmp/preset-memory-boot/ws' },
  sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' } },
  http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
};

const withVolume: MemoryPresetConfig = {
  ...baseK8s,
  factsDatabasePath: '/tmp/preset-memory-boot/facts/facts.db',
  memoryExportVolume: {
    hostRoot: '/tmp/preset-memory-boot/exports',
    backing: { server: 'nfs.example.invalid', exportPath: '/exports/ax-memory' },
  },
};

const withoutVolume: MemoryPresetConfig = (() => {
  const { memoryExportVolume: _dropped, ...rest } = withVolume;
  return rest;
})();

// The env the chart hands the host (kind/GKE shape): memory export volume,
// Filestore user-files (adds @ax/workspace-filestore → sandbox:resolve-mounts),
// and an Anthropic key (host LLM tools), assembled by the REAL env loader.
const deployedEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://stub:5432/stub',
  AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc.cluster.local:80',
  AX_WORKSPACE_BACKEND: 'local',
  AX_WORKSPACE_ROOT: '/tmp/preset-memory-boot/ws',
  AX_HTTP_HOST: '0.0.0.0',
  AX_HTTP_PORT: '9090',
  AX_HTTP_COOKIE_KEY: '0'.repeat(64),
  AX_RUNNER_BINARY: '/tmp/stub-runner.js',
  ANTHROPIC_API_KEY: 'sk-ant-stub',
  AX_FILESTORE_SERVER: 'filestore.example.invalid',
  AX_FILESTORE_EXPORT_PATH: '/exports/ax-files',
  AX_MEMORY_FACTS_DB_PATH: '/tmp/preset-memory-boot/facts/facts.db',
  AX_MEMORY_EXPORT_HOST_ROOT: '/tmp/preset-memory-boot/exports',
  AX_MEMORY_EXPORT_NFS_SERVER: 'nfs.example.invalid',
  AX_MEMORY_EXPORT_NFS_PATH: '/exports/ax-memory',
};

describe('@ax/preset-memory boots through the kernel graph checks', () => {
  it('the deployed shape still contains every OTHER link of the TASK-759 cycle', () => {
    // Guard the guard: if a refactor drops one of these edges the boot test
    // below goes green for the wrong reason, so pin the consuming side too.
    const plugins = createMemoryPlugins(withVolume);
    const byName = (n: string) => {
      const p = plugins.find((x) => x.manifest.name === n);
      expect(p, n).toBeDefined();
      return p!.manifest;
    };
    const uses = (n: string) => {
      const m = byName(n);
      return [...m.calls, ...(m.optionalCalls ?? []).map((c) => c.hook)];
    };
    const registers = (hook: string) =>
      plugins.filter((p) => p.manifest.registers.includes(hook)).map((p) => p.manifest.name);
    expect(uses('@ax/chat-orchestrator')).toContain('sandbox:open-session');
    expect(registers('sandbox:open-session')).toEqual(['@ax/sandbox-k8s']);
    expect(uses('@ax/sandbox-k8s')).toContain('sandbox:memory-mounts');
    expect(registers('sandbox:memory-mounts')).toEqual(['@ax/memory']);
    expect(uses('@ax/memory')).toContain('llm:call:openrouter');
    expect(registers('llm:call:openrouter')).toEqual(['@ax/llm-openrouter']);
    expect(uses('@ax/llm-openrouter')).toContain('usage:check');
    expect(registers('usage:check')).toEqual(['@ax/usage-limits']);
    expect(registers('agent:interrupt')).toEqual(['@ax/chat-orchestrator']);
    // The one edge TASK-759 removed. Docker-free twin of the usage-limits
    // manifest assertion (whose file needs a Postgres container).
    expect(uses('@ax/usage-limits')).not.toContain('agent:interrupt');
  });

  const shapes: Array<[string, MemoryPresetConfig]> = [
    ['assembled by loadMemoryConfigFromEnv from the deployed env', loadMemoryConfigFromEnv(deployedEnv)],
    ['with the memory export volume (deployed shape)', withVolume],
    ['without the memory export volume', withoutVolume],
    ['with host LLM tools', { ...withVolume, hostLlmTools: true }],
    [
      'on the Agent Sandbox backend',
      {
        ...withVolume,
        sandbox: { ...withVolume.sandbox, backend: 'agent-sandbox', agentSandboxApiVersion: 'v1alpha1' },
      },
    ],
  ];

  for (const [label, cfg] of shapes) {
    it(`${label}: no call cycle, no duplicate producer, no missing service`, async () => {
      await expect(bootPluginGraph(createMemoryPlugins(cfg))).resolves.toBeUndefined();
    });
  }
});
