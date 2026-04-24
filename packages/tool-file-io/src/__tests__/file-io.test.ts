import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  HookBus,
  PluginError,
  makeChatContext,
  createLogger,
} from '@ax/core';
import { createToolFileIoPlugin } from '../plugin.js';

async function mkRoot() {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-fileio-')));
}

const ctx = (rootPath: string) =>
  makeChatContext({
    sessionId: 's', agentId: 'a', userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
    workspace: { rootPath },
  });

async function makeBus() {
  const bus = new HookBus();
  await createToolFileIoPlugin().init({ bus, config: {} });
  return bus;
}

describe('tool-file-io', () => {
  it('read_file returns contents for a file inside workspace', async () => {
    const root = await mkRoot();
    await fs.writeFile(path.join(root, 'a.txt'), 'hello');
    const bus = await makeBus();
    const r = await bus.call('tool:execute:read_file', ctx(root), { path: 'a.txt' });
    expect(r).toMatchObject({ path: 'a.txt', content: 'hello', bytes: 5 });
  });

  it('read_file rejects a path outside workspace', async () => {
    const root = await mkRoot();
    const bus = await makeBus();
    await expect(bus.call('tool:execute:read_file', ctx(root), { path: '../etc/passwd' }))
      .rejects.toBeInstanceOf(PluginError);
  });

  it('read_file rejects files larger than 1 MiB (pre-read stat check)', async () => {
    const root = await mkRoot();
    await fs.writeFile(path.join(root, 'big.txt'), Buffer.alloc(1_048_577, 'x'));
    const bus = await makeBus();
    const err = await bus.call('tool:execute:read_file', ctx(root), { path: 'big.txt' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.message).toContain('file exceeds');
  });

  it('write_file writes bytes inside workspace and returns byte count', async () => {
    const root = await mkRoot();
    const bus = await makeBus();
    const r = await bus.call<unknown, { path: string; bytes: number }>(
      'tool:execute:write_file',
      ctx(root),
      { path: 'out.txt', content: 'hello' },
    );
    expect(r).toMatchObject({ path: 'out.txt', bytes: 5 });
    expect(await fs.readFile(path.join(root, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('write_file rejects a path outside workspace', async () => {
    const root = await mkRoot();
    const bus = await makeBus();
    await expect(bus.call('tool:execute:write_file', ctx(root), {
      path: '../escape.txt', content: 'x',
    })).rejects.toBeInstanceOf(PluginError);
  });

  it('I4: write_file rejects a multi-byte string that exceeds 1 MiB in UTF-8', async () => {
    const root = await mkRoot();
    const bus = await makeBus();
    // "😀" is 4 UTF-8 bytes but 2 UTF-16 code units. 300_000 * 4 = 1_200_000 bytes > 1 MiB,
    // while str.length = 600_000 (would pass a naive Zod .max(1_048_576) check on strings).
    const s = '😀'.repeat(300_000);
    const err = await bus.call('tool:execute:write_file', ctx(root), {
      path: 'big.txt', content: s,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.message).toContain('write exceeds');
    // Prove nothing was written.
    await expect(fs.stat(path.join(root, 'big.txt'))).rejects.toThrow();
  });

  it('write_file accepts a 1 KiB ASCII string', async () => {
    const root = await mkRoot();
    const bus = await makeBus();
    const r = await bus.call<unknown, { path: string; bytes: number }>(
      'tool:execute:write_file',
      ctx(root),
      { path: 'ok.txt', content: 'x'.repeat(1024) },
    );
    expect(r.bytes).toBe(1024);
  });

  it('write_file creates missing parent directories', async () => {
    const root = await mkRoot();
    const bus = await makeBus();
    await bus.call('tool:execute:write_file', ctx(root), {
      path: 'a/b/c.txt', content: 'hi',
    });
    expect(await fs.readFile(path.join(root, 'a/b/c.txt'), 'utf8')).toBe('hi');
  });
});
