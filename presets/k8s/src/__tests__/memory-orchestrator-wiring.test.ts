/**
 * The preset must hand @ax/memory-strata an orchestrator route.
 *
 * This is the regression this file exists for, and it is the TASK-347 defect
 * itself: the orchestrator degrades to BM25 silently, so wiring that quietly
 * goes missing costs retrieval quality on every deployment and breaks no test
 * and no log. It has already happened once — the previous wiring was gated on
 * `XAI_API_KEY`, which had no chart value, so the orchestrator was dark in
 * production for its entire life.
 *
 * `memory-strata`'s manifest cannot carry the evidence: the orchestrator hook
 * is gated at runtime with `bus.hasService` (so a deployment without the
 * provider degrades instead of failing `verifyCalls` at boot), which means it
 * is deliberately absent from `manifest.calls`. So this asserts on what the
 * preset PASSES, which is the only place the wiring is visible.
 */
import { describe, expect, it, vi } from 'vitest';
import type { K8sPresetConfig } from '../index.js';

const createMemoryStrataPlugin = vi.fn(() => ({
  manifest: {
    name: '@ax/memory-strata',
    version: '0.0.0',
    registers: [],
    calls: [],
    subscribes: [],
  },
  async init() {},
}));

vi.mock('@ax/memory-strata', async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>('@ax/memory-strata');
  return { ...actual, createMemoryStrataPlugin };
});

const { createK8sPlugins } = await import('../index.js');

/** Minimum that `createK8sPlugins` needs to assemble. Mirrors preset.test.ts. */
const stubConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
  sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' } },
  http: {
    host: '127.0.0.1',
    port: 0,
    cookieKey: '0'.repeat(64),
    allowedOrigins: [],
  },
} as unknown as K8sPresetConfig;

function orchestratorConfig(): Record<string, unknown> {
  createMemoryStrataPlugin.mockClear();
  createK8sPlugins({ ...stubConfig, hostLlmTools: true });
  expect(
    createMemoryStrataPlugin,
    'preset constructs @ax/memory-strata',
  ).toHaveBeenCalledTimes(1);
  const cfg = createMemoryStrataPlugin.mock.calls[0]![0] as
    | { orchestrator?: Record<string, unknown> }
    | undefined;
  return cfg?.orchestrator ?? {};
}

describe('memory-strata orchestrator wiring', () => {
  it('routes the orchestrator through the OpenRouter provider hook', () => {
    // Not a client: a client carries its own API key, and a key needs a way in
    // — which is exactly what was missing before. The hook resolves its
    // credential through the provider, per call.
    const orch = orchestratorConfig();
    expect(orch['hook']).toBe('llm:call:openrouter');
    expect(orch['client']).toBeUndefined();
  });

  it('names a bare provider-native model', () => {
    const model = orchestratorConfig()['model'];
    expect(typeof model).toBe('string');
    expect(model).not.toBe('');
    // `openrouter/x-ai/...` would be routed twice — the hook name already
    // carries the provider.
    expect(String(model)).not.toContain('openrouter/');
  });

  it('lets an operator override the model', () => {
    createMemoryStrataPlugin.mockClear();
    createK8sPlugins({
      ...stubConfig,
      hostLlmTools: true,
      memoryOrchestratorModel: 'some/other-fast-model',
    });
    const cfg = createMemoryStrataPlugin.mock.calls[0]![0] as {
      orchestrator?: { model?: string };
    };
    expect(cfg.orchestrator?.model).toBe('some/other-fast-model');
  });
});
