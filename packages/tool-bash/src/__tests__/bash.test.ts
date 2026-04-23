import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeChatContext,
  createLogger,
  type ChatContext,
} from '@ax/core';
import { sandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { toolBashPlugin } from '../plugin.js';
import type { BashResult } from '../types.js';

const ctx = (): ChatContext =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
    workspaceRoot: process.cwd(),
  });

async function makeBus(): Promise<HookBus> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [sandboxSubprocessPlugin(), toolBashPlugin()],
    config: {},
  });
  return bus;
}

describe('@ax/tool-bash', () => {
  it('runs echo and captures stdout', async () => {
    const bus = await makeBus();
    const result = await bus.call<unknown, BashResult>(
      'tool:execute:bash',
      ctx(),
      { command: 'echo hello' },
    );
    expect(result.stdout).toContain('hello');
    expect(result.exitCode).toBe(0);
    expect(result.truncated.stdout).toBe(false);
  });

  it('reports nonzero exit code', async () => {
    const bus = await makeBus();
    const result = await bus.call<unknown, BashResult>(
      'tool:execute:bash',
      ctx(),
      { command: 'false' },
    );
    expect(result.exitCode).toBe(1);
  });

  it('captures stderr separately', async () => {
    const bus = await makeBus();
    const result = await bus.call<unknown, BashResult>(
      'tool:execute:bash',
      ctx(),
      { command: 'echo oops 1>&2' },
    );
    expect(result.stderr).toContain('oops');
  });

  it('rejects oversize commands (>16 KiB) with invalid-payload', async () => {
    const bus = await makeBus();
    try {
      await bus.call<unknown, BashResult>('tool:execute:bash', ctx(), {
        command: 'x'.repeat(20_000),
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      const pe = err as PluginError;
      expect(pe.code).toBe('invalid-payload');
      expect(pe.hookName).toBe('tool:execute:bash');
    }
  });

  it('honors timeoutMs and reports timedOut', async () => {
    const bus = await makeBus();
    const result = await bus.call<unknown, BashResult>(
      'tool:execute:bash',
      ctx(),
      { command: 'sleep 2', timeoutMs: 100 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('rejects empty command with invalid-payload', async () => {
    const bus = await makeBus();
    try {
      await bus.call<unknown, BashResult>('tool:execute:bash', ctx(), {
        command: '',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      const pe = err as PluginError;
      expect(pe.code).toBe('invalid-payload');
    }
  });
});
