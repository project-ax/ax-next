import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createSandboxSubprocessPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';

// ---------------------------------------------------------------------------
// sandbox:open-session tests
//
// These exercise real subprocess spawns (the stub runner under fixtures/).
// The test harness bootstraps session-inmemory + ipc-server + sandbox-subprocess
// together so the dep graph is real. We stub `llm:call` and `tool:list`
// because ipc-server declares them in its `calls` manifest — but we never
// actually drive them through IPC in these tests; the runner stub just sits
// idle until killed.
//
// Env-injection test reads the stub's stdout directly via the (testing-only)
// `handle.child` field on the returned handle. Alternative would be to have
// the stub write to `${AX_WORKSPACE_ROOT}/env.json`; stdout is simpler and
// keeps the workspaceRoot clean for other tests running in parallel.
// ---------------------------------------------------------------------------

const ECHO_STUB = fileURLToPath(new URL('./fixtures/echo-stub.mjs', import.meta.url));
const EXIT_STUB = fileURLToPath(new URL('./fixtures/exit-stub.mjs', import.meta.url));

async function mkWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
  return dir;
}

async function makeHarness() {
  return createTestHarness({
    services: {
      // Satisfy ipc-server's verifyCalls — these are never driven by these tests.
      'llm:call': async () => ({
        assistantMessage: { role: 'assistant', content: '' },
        toolCalls: [],
      }),
      'tool:list': async () => ({ tools: [] }),
    },
    plugins: [
      createSessionInmemoryPlugin(),
      createIpcServerPlugin(),
      createSandboxSubprocessPlugin(),
    ],
  });
}

function readFirstStdoutLine(result: OpenSessionResult): Promise<string> {
  const stdout = result.handle.child?.stdout;
  if (stdout === undefined) {
    throw new Error('test harness expected handle.child.stdout');
  }
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stdout.off('data', onData);
        stdout.off('error', onErr);
        resolve(buf.slice(0, nl));
      }
    };
    const onErr = (err: Error): void => reject(err);
    stdout.on('data', onData);
    stdout.on('error', onErr);
  });
}

describe('sandbox:open-session', () => {
  it('happy path: spawns runner, returns handle; kill() reaps with SIGTERM; cleans up socket dir', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'happy-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    expect(result.socketPath).toMatch(/ax-ipc-/);
    expect(result.socketPath.endsWith('/ipc.sock')).toBe(true);

    // exited unresolved after 100ms — child is holding itself open.
    const race = await Promise.race([
      result.handle.exited.then(() => 'exited'),
      new Promise<string>((r) => setTimeout(() => r('pending'), 100)),
    ]);
    expect(race).toBe('pending');

    // Kill, then confirm the signal.
    await result.handle.kill();
    const final = await result.handle.exited;
    // SIGTERM should have been enough — 5s SIGKILL escalator unused.
    expect(final.signal).toBe('SIGTERM');

    // Allow the async 'close' cleanup handler to run.
    await new Promise((r) => setTimeout(r, 50));

    // Socket dir was removed.
    const socketDir = path.dirname(result.socketPath);
    await expect(fs.stat(socketDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(ws, { recursive: true, force: true });
  });

  it('injects AX_* env into the child (I9: token is the one minted by session:create)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'env-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    expect(parsed.AX_IPC_SOCKET).toBe(result.socketPath);
    expect(parsed.AX_SESSION_ID).toBe('env-1');
    expect(parsed.AX_WORKSPACE_ROOT).toBe(ws);
    expect(typeof parsed.AX_AUTH_TOKEN).toBe('string');
    expect((parsed.AX_AUTH_TOKEN ?? '').length).toBeGreaterThan(0);
    // The token must NOT be echoed in the returned surface.
    expect(JSON.stringify(result)).not.toContain(parsed.AX_AUTH_TOKEN);

    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('does NOT leak non-allowlist parent env (FOO stays undefined in child)', async () => {
    const ws = await mkWorkspace();
    const prior = process.env.FOO;
    process.env.FOO = 'should-not-reach-child';
    try {
      const h = await makeHarness();
      const ctx = h.ctx();
      const result = await h.bus.call<unknown, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        { sessionId: 'env-2', workspaceRoot: ws, runnerBinary: ECHO_STUB },
      );
      const line = await readFirstStdoutLine(result);
      const parsed = JSON.parse(line) as Record<string, string | null>;
      // FOO is NOT in the allowlist; it must be null in the child.
      expect(parsed.FOO).toBeNull();
      await result.handle.kill();
      await result.handle.exited;
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      if (prior === undefined) delete process.env.FOO;
      else process.env.FOO = prior;
    }
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rejects a relative runnerBinary with PluginError(invalid-payload)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call(
        'sandbox:open-session',
        ctx,
        { sessionId: 'rel', workspaceRoot: ws, runnerBinary: './relative.mjs' },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rejects a missing runner binary with a clean PluginError (no host crash)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call(
        'sandbox:open-session',
        ctx,
        {
          sessionId: 'missing',
          workspaceRoot: ws,
          runnerBinary: '/var/empty/does/not/exist-ax.mjs',
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    expect((caught as PluginError).message).toMatch(/not found or not readable/);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('kill() after the child has already exited is a no-op', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'exit-fast', workspaceRoot: ws, runnerBinary: EXIT_STUB },
    );
    // Wait for the natural exit.
    const final = await result.handle.exited;
    expect(final.code).toBe(0);
    expect(final.signal).toBeNull();
    // kill() must not throw even though the child is gone.
    await expect(result.handle.kill()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('terminates the session on child close (token stops resolving)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'term-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const envDump = JSON.parse(line) as { AX_AUTH_TOKEN: string };
    const token = envDump.AX_AUTH_TOKEN;
    // Before close, resolve-token returns the session.
    const before = await h.bus.call('session:resolve-token', ctx, { token });
    expect(before).toMatchObject({ sessionId: 'term-1' });

    await result.handle.kill();
    await result.handle.exited;

    // Post-close, poll briefly: the close handler runs on microtasks +
    // bus.call awaits. Give it a couple of ticks to propagate.
    let after: unknown = before;
    for (let i = 0; i < 20; i++) {
      after = await h.bus.call('session:resolve-token', ctx, { token });
      if (after === null) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(after).toBeNull();

    await fs.rm(ws, { recursive: true, force: true });
  });

  it('stops the IPC listener on child close (socket file goes away)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'stop-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    // Socket file is there before kill.
    await expect(fs.stat(result.socketPath)).resolves.toBeDefined();

    await result.handle.kill();
    await result.handle.exited;

    // Poll: the close handler calls ipc:stop + rm. Either the whole tempdir
    // is gone or (briefly, while rm is mid-flight) the socket file is gone
    // first. Either way the socket path must stop existing.
    let stillThere = true;
    for (let i = 0; i < 20; i++) {
      try {
        await fs.stat(result.socketPath);
        stillThere = true;
      } catch {
        stillThere = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(stillThere).toBe(false);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('removes the socket tempdir on child close (ENOENT)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'cleanup-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const socketDir = path.dirname(result.socketPath);

    await result.handle.kill();
    await result.handle.exited;

    let exists = true;
    for (let i = 0; i < 20; i++) {
      try {
        await fs.stat(socketDir);
        exists = true;
      } catch {
        exists = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(exists).toBe(false);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('socket tempdir is mode 0700 (I10)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'i10', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const socketDir = path.dirname(result.socketPath);
    const stat = await fs.stat(socketDir);
    expect(stat.mode & 0o777).toBe(0o700);
    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(ws, { recursive: true, force: true });
  });
});
