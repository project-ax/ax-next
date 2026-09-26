import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

/**
 * Line-delimited JSON-RPC reader over a child process's stdout, for tests
 * that speak MCP to a subprocess by hand. (TASK-537)
 *
 * Why this exists instead of a poll loop with a deadline: the crash test in
 * `mcp-server-stub.test.ts` used to wait for its `initialize` reply with a
 * hand-rolled `Date.now() + 5000` deadline. That is the same 5s that TASK-400
 * raised this package's `testTimeout` past, just hidden inside the test body
 * where the config can't reach it. Under CI contention the stub legitimately
 * takes longer than that to boot and answer — on run 36220630082 the
 * neighbouring `echo` test did the identical spawn + handshake and needed
 * **9087ms** (idle: ~90ms). The echo test passed because it had no private
 * deadline; the crash test failed at 5.2s with `timeout waiting for id=1`.
 *
 * So there is deliberately NO timer here. How long a reply may take is the
 * test budget's job (`vitest.config.ts`), and one number is easier to reason
 * about than two. What this reader adds instead is the thing a timeout can't
 * tell you: if the child dies before replying, the wait rejects right away
 * with the exit code and the child's stderr, rather than sitting there until
 * some clock runs out and blaming "timeout".
 */

/** The slice of `ChildProcess` this reader uses — small enough to fake. */
export interface JsonRpcChild extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
}

export interface JsonRpcStdout {
  /** Resolves with the message whose `id` matches, whenever it arrives. */
  waitForId(id: number): Promise<unknown>;
  /** Everything the child has written to stderr so far. */
  stderr(): string;
}

const STDERR_KEEP_CHARS = 4_000;

export function readJsonRpcStdout(child: JsonRpcChild): JsonRpcStdout {
  if (child.stdout == null) throw new Error('child has no stdout pipe');

  // Replies that arrived before anyone asked for them.
  const received = new Map<number, unknown>();
  const waiters = new Map<
    number,
    { resolve: (msg: unknown) => void; reject: (err: Error) => void }
  >();
  let ended: Error | undefined;
  let stderrText = '';
  let buf = '';

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrText = (stderrText + chunk).slice(-STDERR_KEEP_CHARS);
  });

  const deliver = (line: string): void => {
    if (line.trim().length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a JSON-RPC frame; stdout should only carry those
    }
    const id = (msg as { id?: unknown } | null)?.id;
    if (typeof id !== 'number') return; // notification, or no id at all
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      waiter.resolve(msg);
    } else {
      received.set(id, msg);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      deliver(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });

  const fail = (err: Error): void => {
    ended ??= err;
    for (const [id, waiter] of waiters) {
      waiters.delete(id);
      waiter.reject(new Error(`${ended.message} before replying to id=${id}`));
    }
  };

  // 'close', not 'exit': 'exit' can fire while the child's last stdout chunk
  // (the very reply we are waiting for) is still unread, which would turn a
  // clean reply-then-exit into a false "exited before replying". 'close' waits
  // for the stdio streams to finish, so the stderr tail is complete too.
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const tail = stderrText.trim();
    fail(
      new Error(
        `child exited (code=${code}, signal=${signal})` +
          (tail.length > 0 ? ` with stderr: ${tail}` : ' with no stderr'),
      ),
    );
  });
  child.on('error', (err: Error) => {
    fail(new Error(`child process error: ${err.message}`));
  });

  return {
    waitForId(id) {
      if (received.has(id)) {
        const msg = received.get(id);
        received.delete(id);
        return Promise.resolve(msg);
      }
      if (ended) {
        return Promise.reject(new Error(`${ended.message} before replying to id=${id}`));
      }
      if (waiters.has(id)) {
        return Promise.reject(new Error(`already waiting for id=${id}`));
      }
      return new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
      });
    },
    stderr: () => stderrText,
  };
}
