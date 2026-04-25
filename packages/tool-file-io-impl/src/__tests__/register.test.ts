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

  it('write_file invokes onFileChange with the path + content as bytes (Task 7c)', async () => {
    const observed: Array<unknown> = [];
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, {
      workspaceRoot,
      onFileChange: (change) => observed.push(change),
    });
    await dispatcher.execute({
      id: 'c1',
      name: 'write_file',
      input: { path: 'a.txt', content: 'AAA' },
    });
    await dispatcher.execute({
      id: 'c2',
      name: 'write_file',
      input: { path: 'b.txt', content: 'BBB' },
    });
    expect(observed).toHaveLength(2);
    const first = observed[0] as {
      path: string;
      kind: string;
      content: Uint8Array;
    };
    expect(first.path).toBe('a.txt');
    expect(first.kind).toBe('put');
    expect(Buffer.from(first.content).toString('utf8')).toBe('AAA');
    const second = observed[1] as {
      path: string;
      kind: string;
      content: Uint8Array;
    };
    expect(second.path).toBe('b.txt');
    expect(second.kind).toBe('put');
    expect(Buffer.from(second.content).toString('utf8')).toBe('BBB');
  });

  it('read_file does NOT invoke onFileChange (it does not mutate)', async () => {
    const observed: Array<unknown> = [];
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, {
      workspaceRoot,
      onFileChange: (change) => observed.push(change),
    });
    // Seed a file so read_file has something to return.
    await dispatcher.execute({
      id: 'c0',
      name: 'write_file',
      input: { path: 'x.txt', content: 'x' },
    });
    observed.length = 0; // ignore the seed write
    await dispatcher.execute({
      id: 'c1',
      name: 'read_file',
      input: { path: 'x.txt' },
    });
    expect(observed).toEqual([]);
  });

  it('observer exception does not poison the tool result', async () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, {
      workspaceRoot,
      onFileChange: () => {
        throw new Error('observer blew up');
      },
    });
    const result = await dispatcher.execute({
      id: 'c1',
      name: 'write_file',
      input: { path: 'x.txt', content: 'hello' },
    });
    expect(result).toEqual({ path: 'x.txt', bytes: 5 });
  });
});
