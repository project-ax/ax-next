import { describe, it, expect, vi } from 'vitest';
import {
  HookBus,
  makeChatContext,
  createLogger,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
} from '@ax/core';
// Integration test: wire the real sandbox plugin alongside tool-bash so the
// end-to-end sandbox:spawn path runs in one process. This is test-only — the
// plugin's runtime deps in package.json stay free of cross-plugin references,
// so the no-restricted-imports rule still protects every non-test file.
// eslint-disable-next-line no-restricted-imports
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createToolBashPlugin, bashToolDescriptor } from '../index.js';

const ctx = (rootPath: string) =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
    workspace: { rootPath },
  });

describe('tool-bash', () => {
  it('registers tool:execute:bash', async () => {
    const bus = new HookBus();
    await createToolBashPlugin().init({ bus, config: {} });
    expect(bus.hasService('tool:execute:bash')).toBe(true);
  });

  it('descriptor input schema names command and timeoutMs', () => {
    expect(bashToolDescriptor.name).toBe('bash');
    const required = (bashToolDescriptor.inputSchema as { required: string[] }).required;
    expect(required).toContain('command');
    const props = (bashToolDescriptor.inputSchema as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['command', 'timeoutMs']));
  });

  it('delegates to sandbox:spawn with /bin/bash -c <command>, env:{}, cwd=workspace.rootPath', async () => {
    const bus = new HookBus();
    const spy = vi.fn(
      async (_c: unknown, _i: SandboxSpawnInput): Promise<SandboxSpawnResult> => ({
        exitCode: 0,
        signal: null,
        stdout: 'ran',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        timedOut: false,
      }),
    );
    bus.registerService<SandboxSpawnInput, SandboxSpawnResult>(
      'sandbox:spawn',
      'fake-sandbox',
      spy,
    );
    await createToolBashPlugin().init({ bus, config: {} });

    const r = await bus.call('tool:execute:bash', ctx('/tmp/ws'), {
      command: 'echo hi',
    });
    expect(r).toMatchObject({ stdout: 'ran', stderr: '', exitCode: 0, timedOut: false });

    expect(spy).toHaveBeenCalledOnce();
    const arg = spy.mock.calls[0]![1];
    expect(arg.argv).toEqual(['/bin/bash', '-c', 'echo hi']);
    expect(arg.env).toEqual({});
    expect(arg.cwd).toBe('/tmp/ws');
    expect(arg.timeoutMs).toBe(30_000);
  });

  it('rejects oversize command (>16 KiB) at Zod BEFORE invoking sandbox:spawn', async () => {
    const bus = new HookBus();
    const spy = vi.fn();
    bus.registerService('sandbox:spawn', 'fake', spy);
    await createToolBashPlugin().init({ bus, config: {} });
    await expect(
      bus.call('tool:execute:bash', ctx('/tmp'), { command: 'x'.repeat(16_385) }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('honors caller timeoutMs', async () => {
    const bus = new HookBus();
    let seen: SandboxSpawnInput | null = null;
    bus.registerService<SandboxSpawnInput, SandboxSpawnResult>(
      'sandbox:spawn',
      'fake',
      async (_c, i) => {
        seen = i;
        return {
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          truncated: { stdout: false, stderr: false },
          timedOut: false,
        };
      },
    );
    await createToolBashPlugin().init({ bus, config: {} });
    await bus.call('tool:execute:bash', ctx('/tmp'), {
      command: 'sleep 1',
      timeoutMs: 15_000,
    });
    expect(seen!.timeoutMs).toBe(15_000);
  });

  it('integrates with real @ax/sandbox-subprocess: echo hello', async () => {
    const bus = new HookBus();
    await createSandboxSubprocessPlugin().init({ bus, config: {} });
    await createToolBashPlugin().init({ bus, config: {} });
    const r = await bus.call<unknown, { stdout: string; exitCode: number | null }>(
      'tool:execute:bash',
      ctx(process.cwd()),
      { command: 'echo hello' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });
});
