import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@ax/core';
import { runServeCommand } from '../commands/serve.js';


const k8sLoader = vi.hoisted(() => vi.fn());
const k8sFactory = vi.hoisted(() => vi.fn());
const memoryLoader = vi.hoisted(() => vi.fn());
const memoryFactory = vi.hoisted(() => vi.fn());

vi.mock('@ax/preset-k8s', () => ({
  loadK8sConfigFromEnv: k8sLoader,
  createK8sPlugins: k8sFactory,
}));
vi.mock('@ax/preset-memory', () => ({
  loadMemoryConfigFromEnv: memoryLoader,
  createMemoryPlugins: memoryFactory,
}));

function providerStub(): Plugin {
  return {
    manifest: {
      name: '@ax/serve-preset-test-stub',
      version: '0.0.0',
      registers: ['http:register-route', 'session:create', 'agent:invoke'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('http:register-route', '@ax/serve-preset-test-stub', async () => ({
        unregister: () => undefined,
      }));
      bus.registerService('session:create', '@ax/serve-preset-test-stub', async () => ({
        sessionId: 'stub',
        token: 'stub',
      }));
      bus.registerService('agent:invoke', '@ax/serve-preset-test-stub', async () => ({
        kind: 'complete',
        messages: [],
      }));
    },
  };
}

function run(env: NodeJS.ProcessEnv): Promise<{
  code: number;
  stderr: string[];
}> {
  return new Promise((resolve, reject) => {
    const stderr: string[] = [];
    void runServeCommand({
      argv: [],
      env,
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
      onReady: ({ close }) => {
        void close().then(() => resolve({ code: 0, stderr }));
      },
    })
      .then((code) => resolve({ code, stderr }))
      .catch(reject);
  });
}

describe('serve AX_PRESET selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to the k8s preset when AX_PRESET is unset', async () => {
    k8sLoader.mockReturnValue({});
    k8sFactory.mockReturnValue([providerStub()]);
    const { code } = await run({ AX_SERVE_TOKEN: 'x' });
    expect(code).toBe(0);
    expect(k8sLoader).toHaveBeenCalled();
    expect(k8sFactory).toHaveBeenCalled();
    expect(memoryFactory).not.toHaveBeenCalled();
  });

  it('selects the memory preset when AX_PRESET=memory', async () => {
    memoryLoader.mockReturnValue({});
    memoryFactory.mockReturnValue([providerStub()]);
    const { code } = await run({ AX_SERVE_TOKEN: 'x', AX_PRESET: 'memory' });
    expect(code).toBe(0);
    expect(memoryLoader).toHaveBeenCalled();
    expect(memoryFactory).toHaveBeenCalled();
    expect(k8sFactory).not.toHaveBeenCalled();
  });

  it('rejects an unknown AX_PRESET with a static message', async () => {
    const { code, stderr } = await run({ AX_PRESET: 'bogus' });
    expect(code).toBe(2);
    expect(stderr.some((l) => l.includes('unknown AX_PRESET'))).toBe(true);
    expect(k8sLoader).not.toHaveBeenCalled();
    expect(memoryLoader).not.toHaveBeenCalled();
  });

  it('returns 2 with the loader message when the memory env is incomplete', async () => {
    memoryLoader.mockImplementation(() => {
      throw new Error('AX_MEMORY_FACTS_DB_PATH is required');
    });
    const { code, stderr } = await run({ AX_PRESET: 'memory' });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('AX_MEMORY_FACTS_DB_PATH is required');
  });

  it('returns 2 when the memory factory throws on invalid config', async () => {
    memoryLoader.mockReturnValue({});
    memoryFactory.mockImplementation(() => {
      throw new Error('memory export volume hostRoot must be an absolute path');
    });
    const { code, stderr } = await run({ AX_PRESET: 'memory' });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('hostRoot');
  });
});
