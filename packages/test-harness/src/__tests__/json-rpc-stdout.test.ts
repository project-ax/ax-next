import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readJsonRpcStdout, type JsonRpcChild } from './helpers/json-rpc-stdout.js';

// A ChildProcess stand-in: stdout/stderr we can write to, and 'close'/'error'
// we can emit, with no real process involved.
function fakeChild(): JsonRpcChild & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as JsonRpcChild & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

const frame = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

describe('readJsonRpcStdout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps waiting for a slow reply instead of timing out on its own (TASK-537)', async () => {
    // The regression: the crash test's reader gave up after a private 5s,
    // while CI took 9s to answer the same handshake in the neighbouring test.
    // Fake clocks move both Date.now() and timers, so a reader with ANY
    // built-in deadline shorter than a minute fails here.
    vi.useFakeTimers();
    const child = fakeChild();
    const rpc = readJsonRpcStdout(child);

    let settled: 'resolved' | 'rejected' | undefined;
    const reply = rpc.waitForId(1).then(
      (msg) => {
        settled = 'resolved';
        return msg;
      },
      (err: unknown) => {
        settled = 'rejected';
        throw err;
      },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBeUndefined();

    child.stdout.write(frame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    await expect(reply).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('reassembles a reply split across chunks and skips other frames', async () => {
    const child = fakeChild();
    const rpc = readJsonRpcStdout(child);
    const reply = rpc.waitForId(2);

    const wanted = frame({ jsonrpc: '2.0', id: 2, result: 'two' });
    child.stdout.write(frame({ jsonrpc: '2.0', method: 'notifications/message', params: {} }));
    child.stdout.write('\n');
    child.stdout.write(frame({ jsonrpc: '2.0', id: 7, result: 'seven' }));
    child.stdout.write(wanted.slice(0, 10));
    child.stdout.write(wanted.slice(10));

    await expect(reply).resolves.toEqual({ jsonrpc: '2.0', id: 2, result: 'two' });
    // The frame for id=7 was kept, not dropped.
    await expect(rpc.waitForId(7)).resolves.toEqual({ jsonrpc: '2.0', id: 7, result: 'seven' });
  });

  it('returns a reply that arrived before anyone asked for it', async () => {
    const child = fakeChild();
    const rpc = readJsonRpcStdout(child);
    child.stdout.write(frame({ jsonrpc: '2.0', id: 1, result: 'early' }));
    await new Promise((r) => setImmediate(r));

    await expect(rpc.waitForId(1)).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: 'early' });
  });

  it('rejects at once with the exit code and stderr when the child dies first', async () => {
    const child = fakeChild();
    const rpc = readJsonRpcStdout(child);
    const reply = rpc.waitForId(1);

    child.stderr.write('mcp-server-stub fatal: boom\n');
    await new Promise((r) => setImmediate(r));
    child.emit('close', 2, null);

    await expect(reply).rejects.toThrow(
      'child exited (code=2, signal=null) with stderr: mcp-server-stub fatal: boom before replying to id=1',
    );
    // A later wait on a dead child also fails fast rather than hanging.
    await expect(rpc.waitForId(3)).rejects.toThrow(/child exited \(code=2.*before replying to id=3/);
  });

  it('rejects when the child cannot be spawned at all', async () => {
    const child = fakeChild();
    const rpc = readJsonRpcStdout(child);
    const reply = rpc.waitForId(1);

    child.emit('error', new Error('spawn ENOENT'));

    await expect(reply).rejects.toThrow('child process error: spawn ENOENT before replying to id=1');
  });
});
