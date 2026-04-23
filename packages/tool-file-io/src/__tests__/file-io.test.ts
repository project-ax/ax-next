import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeChatContext,
  createLogger,
  type ChatContext,
} from '@ax/core';
import { toolFileIoPlugin } from '../plugin.js';

function ctx(workspaceRoot: string): ChatContext {
  return makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
    workspaceRoot,
  });
}

describe('@ax/tool-file-io', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ax-file-io-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function busWithPlugin(): Promise<HookBus> {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [toolFileIoPlugin()], config: {} });
    return bus;
  }

  it('read_file returns content and bytes', async () => {
    writeFileSync(join(root, 'hello.txt'), 'hello world');
    const bus = await busWithPlugin();
    const result = await bus.call<unknown, { content: string; bytes: number }>(
      'tool:execute:read_file',
      ctx(root),
      { path: 'hello.txt' },
    );
    expect(result.content).toBe('hello world');
    expect(result.bytes).toBe(11);
  });

  it('read_file rejects paths that escape the workspace', async () => {
    const bus = await busWithPlugin();
    await expect(
      bus.call('tool:execute:read_file', ctx(root), { path: '../../etc/passwd' }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('read_file rejects files larger than 1 MiB', async () => {
    const big = 'a'.repeat(1_048_577);
    writeFileSync(join(root, 'big.txt'), big);
    const bus = await busWithPlugin();
    await expect(
      bus.call('tool:execute:read_file', ctx(root), { path: 'big.txt' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('content too large') });
  });

  it('write_file writes content and returns byte count', async () => {
    const bus = await busWithPlugin();
    const result = await bus.call<unknown, { bytes: number }>(
      'tool:execute:write_file',
      ctx(root),
      { path: 'out.txt', content: 'hello' },
    );
    expect(result.bytes).toBe(5);
    expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('write_file rejects paths that escape the workspace', async () => {
    const bus = await busWithPlugin();
    await expect(
      bus.call('tool:execute:write_file', ctx(root), {
        path: '../../etc/pwned',
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('write_file rejects 2 MiB content via Zod before hitting fs', async () => {
    const bus = await busWithPlugin();
    const huge = 'a'.repeat(2 * 1_048_576);
    await expect(
      bus.call('tool:execute:write_file', ctx(root), { path: 'out.txt', content: huge }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
