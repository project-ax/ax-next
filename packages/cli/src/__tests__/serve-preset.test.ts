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

// TASK-360: the agent workspace is always on. `AX_AGENT_WORKSPACE` and the
// older `AX_AGENT_WORKSPACE_PREVIEW` are retired — serve warns once per name
// and boots anyway, whatever the value. It never promotes, parses or rejects.
describe('serve retired agent-workspace env names', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    k8sLoader.mockReturnValue({});
    k8sFactory.mockReturnValue([providerStub()]);
  });

  function envSeenByLoader(): NodeJS.ProcessEnv {
    expect(k8sLoader).toHaveBeenCalledTimes(1);
    return k8sLoader.mock.calls[0]![0] as NodeJS.ProcessEnv;
  }

  const retiredLines = (stderr: string[]): string[] =>
    stderr.filter((l) => /AX_AGENT_WORKSPACE/.test(l));

  it.each(['AX_AGENT_WORKSPACE', 'AX_AGENT_WORKSPACE_PREVIEW'])(
    'warns exactly once for %s=1 and boots',
    async (name) => {
      const { code, stderr } = await run({ AX_SERVE_TOKEN: 'x', [name]: '1' });
      expect(code).toBe(0);
      const lines = retiredLines(stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${name} is retired`);
      expect(lines[0]).toMatch(/always on now/);
      expect(lines[0]).toMatch(/can delete it/);
    },
  );

  it.each([
    ['AX_AGENT_WORKSPACE', '0'],
    ['AX_AGENT_WORKSPACE', 'false'],
    ['AX_AGENT_WORKSPACE_PREVIEW', '0'],
  ])('says the web interface is still ON for %s=%s, and boots', async (name, value) => {
    const { code, stderr } = await run({ AX_SERVE_TOKEN: 'x', [name]: value });
    expect(code).toBe(0);
    const lines = retiredLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${name}=${value}`);
    expect(lines[0]).toMatch(/web interface is still ON/);
    expect(k8sFactory).toHaveBeenCalled();
  });

  it('warns once per name when both are set', async () => {
    const { code, stderr } = await run({
      AX_SERVE_TOKEN: 'x',
      AX_AGENT_WORKSPACE: '0',
      AX_AGENT_WORKSPACE_PREVIEW: '1',
    });
    expect(code).toBe(0);
    const lines = retiredLines(stderr);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('AX_AGENT_WORKSPACE=0'))).toBe(true);
    expect(lines.some((l) => l.includes('AX_AGENT_WORKSPACE_PREVIEW is retired'))).toBe(true);
  });

  it('does not echo an arbitrary value into the log, and still boots', async () => {
    const { code, stderr } = await run({ AX_SERVE_TOKEN: 'x', AX_AGENT_WORKSPACE: 'garbage' });
    expect(code).toBe(0);
    const lines = retiredLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('garbage');
  });

  it('says nothing when neither name is set, and passes the env through as-is', async () => {
    const env = { AX_SERVE_TOKEN: 'x' };
    const { code, stderr } = await run(env);
    expect(code).toBe(0);
    expect(envSeenByLoader()).toBe(env);
    expect(retiredLines(stderr)).toEqual([]);
    expect(stderr.some((l) => /retired/.test(l))).toBe(false);
  });

  it('never promotes or mutates: the loader sees exactly the caller env', async () => {
    const env: NodeJS.ProcessEnv = { AX_SERVE_TOKEN: 'x', AX_AGENT_WORKSPACE_PREVIEW: 'true' };
    await run(env);
    expect('AX_AGENT_WORKSPACE' in env).toBe(false);
    expect(envSeenByLoader()).toBe(env);
    expect(envSeenByLoader().AX_AGENT_WORKSPACE).toBeUndefined();
  });

  it('warns for the memory preset too', async () => {
    memoryLoader.mockReturnValue({});
    memoryFactory.mockReturnValue([providerStub()]);
    const { code, stderr } = await run({
      AX_SERVE_TOKEN: 'x',
      AX_PRESET: 'memory',
      AX_AGENT_WORKSPACE: '0',
    });
    expect(code).toBe(0);
    expect(retiredLines(stderr)).toHaveLength(1);
    expect(memoryFactory).toHaveBeenCalled();
  });
});
