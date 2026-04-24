import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLocalDispatcher } from '@ax/agent-runner-core';
import { registerWithDispatcher } from '../register.js';

async function mkRoot() {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-file-io-impl-reg-')));
}

describe('registerWithDispatcher', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkRoot();
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('registers read_file and write_file on the dispatcher', () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, { workspaceRoot });
    expect(dispatcher.has('read_file')).toBe(true);
    expect(dispatcher.has('write_file')).toBe(true);
  });

  it('dispatcher.execute write_file round-trips via registered executor', async () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, { workspaceRoot });
    const result = await dispatcher.execute({
      id: 'c1',
      name: 'write_file',
      input: { path: 'x.txt', content: 'hi' },
    });
    expect(result).toEqual({ path: 'x.txt', bytes: 2 });
  });

  it('dispatcher.execute read_file returns the content written via write_file', async () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, { workspaceRoot });
    await dispatcher.execute({
      id: 'c1',
      name: 'write_file',
      input: { path: 'x.txt', content: 'hi' },
    });
    const result = await dispatcher.execute({
      id: 'c2',
      name: 'read_file',
      input: { path: 'x.txt' },
    });
    expect(result).toEqual({ path: 'x.txt', content: 'hi', bytes: 2 });
  });
});
