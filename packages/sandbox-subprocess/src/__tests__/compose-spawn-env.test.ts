import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { defaultComposeRunner } from '../compose.js';

describe('defaultComposeRunner', () => {
  it('docker is spawned without the host env', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
      stdin: { end: () => {} },
    });
    spawnMock.mockReturnValue(child);
    process.env.AX_TEST_SECRET = 'sentinel';
    try {
      const p = defaultComposeRunner(['compose', 'version']);
      child.emit('close', 0);
      await p;
    } finally {
      delete process.env.AX_TEST_SECRET;
    }
    const opts = spawnMock.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env).toBeDefined();
    expect(opts.env.AX_TEST_SECRET).toBeUndefined();
    expect(Object.keys(opts.env).every((k) => k === 'PATH' || k === 'HOME' || k.startsWith('DOCKER_'))).toBe(true);
  });
});
