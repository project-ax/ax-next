import { describe, expect, it } from 'vitest';
import { bootPluginGraph } from '@ax/test-harness';
import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// TASK-759 — push this preset's FULL plugin list through the kernel's real
// boot-time graph checks (call cycles, duplicate producers, missing required
// services) without Docker or Postgres. prod-bootstrap.test.ts boots it for
// real but needs a container; this is the cheap lane that always runs. The
// deployed host composes this preset inside @ax/preset-memory, which has the
// same test for its own shapes.

const stubConfig: K8sPresetConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-boot' },
  sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' } },
  http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
};

describe('@ax/preset-k8s boots through the kernel graph checks', () => {
  const shapes: Array<[string, K8sPresetConfig]> = [
    ['default', stubConfig],
    ['with host LLM tools', { ...stubConfig, hostLlmTools: true }],
    [
      'on the Agent Sandbox backend',
      {
        ...stubConfig,
        sandbox: { ...stubConfig.sandbox, backend: 'agent-sandbox', agentSandboxApiVersion: 'v1alpha1' },
      },
    ],
  ];

  for (const [label, cfg] of shapes) {
    it(`${label}: no call cycle, no duplicate producer, no missing service`, async () => {
      await expect(bootPluginGraph(createK8sPlugins(cfg))).resolves.toBeUndefined();
    });
  }
});
