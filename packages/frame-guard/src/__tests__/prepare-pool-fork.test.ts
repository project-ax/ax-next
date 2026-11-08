import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHtmlPreparer, type HtmlPreparer } from '../index.js';

// The pool's handling of the events a child process has that a real one makes only when the machine is wrong: 'error' (it could
// not be made, or told to end, or sent to), and a message that cannot be delivered. The tests of the pool (prepare-pool.test.ts)
// use real processes; here `fork` is a stand-in that is told what to do, so that those branches run.

interface Fake extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  channel: { unref: () => void };
  unref: () => void;
  kill: (signal?: string) => boolean;
  send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
}

const made: Fake[] = [];
/** What the next fake worker does when it is made: by default it says it is ready with the right limit and answers nothing. */
let behave: (child: Fake) => void = () => undefined;

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => {
    const child = new EventEmitter() as Fake;
    child.pid = 4_000_000 + made.length;
    child.exitCode = null;
    child.signalCode = null;
    child.channel = { unref: () => undefined };
    child.unref = () => undefined;
    child.kill = () => {
      child.signalCode = 'SIGKILL';
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    };
    child.send = () => true;
    made.push(child);
    behave(child);
    return child;
  }),
}));

const open: HtmlPreparer[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
  made.length = 0;
  behave = () => undefined;
});

function pool(options: Parameters<typeof createHtmlPreparer>[0] = {}): { p: HtmlPreparer; seen: Array<Error & { code?: string }> } {
  const seen: Array<Error & { code?: string }> = [];
  const p = createHtmlPreparer({ onFault: (fault) => void seen.push(fault as Error & { code?: string }), now: () => 0, ...options });
  open.push(p);
  return { p, seen };
}

const ready = (child: Fake): void => void queueMicrotask(() => child.emit('message', { ready: true, heapLimitMb: 384 + 48 }));

describe("a child process's 'error' event", () => {
  it('before it said it was ready is a worker that could not be made: failed, and it counts, five in a row and pages are turned away', async () => {
    behave = (child) => queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })));
    const { p, seen } = pool();
    for (let i = 0; i < 5; i++) expect(await p.prepare('x')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(await p.prepare('x')).toEqual({ ok: false, reason: 'busy' });
    expect(seen.map((e) => e.code)).toEqual(Array(5).fill('worker_spawn_failed'));
    expect(made).toHaveLength(5);
  });

  it('after it said it was ready, with a page in hand, is a worker that failed, and does not count: any number of them turn nobody away', async () => {
    behave = (child) => {
      ready(child);
      child.send = () => {
        queueMicrotask(() => child.emit('error', new Error('could not be killed or sent to')));
        return true;
      };
    };
    const { p, seen } = pool();
    for (let i = 0; i < 8; i++) expect(await p.prepare('x')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(seen).toHaveLength(8);
    expect(made).toHaveLength(8); // a new worker for each: none was turned away
  });
});

describe('a page that cannot be sent to a worker that said it was ready', () => {
  it('is answered as failed (it was not delivered), is told to onFault as a send that failed, and does not count', async () => {
    behave = (child) => {
      ready(child);
      child.send = (_message, callback) => {
        queueMicrotask(() => callback?.(new Error('channel closed')));
        return false;
      };
    };
    const { p, seen } = pool();
    for (let i = 0; i < 8; i++) expect(await p.prepare('x')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(seen.map((e) => e.code)).toEqual(Array(8).fill('worker_send_failed'));
    expect(made).toHaveLength(8);
  });

  it('is answered as failed too when sending throws', async () => {
    behave = (child) => {
      ready(child);
      child.send = () => {
        throw new Error('channel closed');
      };
    };
    const { p, seen } = pool();
    for (let i = 0; i < 6; i++) expect(await p.prepare('x')).toEqual({ ok: false, reason: 'worker_failed' });
    expect(seen.map((e) => e.code)).toEqual(Array(6).fill('worker_send_failed'));
  });
});
