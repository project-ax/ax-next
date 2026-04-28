import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcServerPlugin } from '@ax/ipc-server';
import { createLlmProxyAnthropicFormatPlugin } from '@ax/llm-proxy-anthropic-format';
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

// The contract returns `runnerEndpoint` as a URI. For this provider it is
// always `unix://<absolute-path>`. Tests still want the underlying socket
// path to assert on tempdir mode, file existence, etc.
function endpointToSocketPath(uri: string): string {
  if (!uri.startsWith('unix://')) {
    throw new Error(`expected unix:// scheme, got ${uri}`);
  }
  return uri.slice('unix://'.length);
}

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
      createLlmProxyAnthropicFormatPlugin(),
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
    expect(result.runnerEndpoint).toMatch(/^unix:\/\/.*ax-ipc-/);
    expect(result.runnerEndpoint.endsWith('/ipc.sock')).toBe(true);

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
    const socketDir = path.dirname(endpointToSocketPath(result.runnerEndpoint));
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
    expect(parsed.AX_RUNNER_ENDPOINT).toBe(result.runnerEndpoint);
    expect(parsed.AX_RUNNER_ENDPOINT).toMatch(/^unix:\/\//);
    expect(parsed.AX_SESSION_ID).toBe('env-1');
    expect(parsed.AX_WORKSPACE_ROOT).toBe(ws);
    expect(typeof parsed.AX_AUTH_TOKEN).toBe('string');
    expect((parsed.AX_AUTH_TOKEN ?? '').length).toBeGreaterThan(0);
    expect(parsed.AX_LLM_PROXY_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
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
    const socketPath = endpointToSocketPath(result.runnerEndpoint);
    // Socket file is there before kill.
    await expect(fs.stat(socketPath)).resolves.toBeDefined();

    await result.handle.kill();
    await result.handle.exited;

    // Poll: the close handler calls ipc:stop + rm. Either the whole tempdir
    // is gone or (briefly, while rm is mid-flight) the socket file is gone
    // first. Either way the socket path must stop existing.
    let stillThere = true;
    for (let i = 0; i < 20; i++) {
      try {
        await fs.stat(socketPath);
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
    const socketDir = path.dirname(endpointToSocketPath(result.runnerEndpoint));

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
    const socketDir = path.dirname(endpointToSocketPath(result.runnerEndpoint));
    const stat = await fs.stat(socketDir);
    expect(stat.mode & 0o777).toBe(0o700);
    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('stops the llm-proxy on child close (port is released)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'proxy-stop-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const proxyUrl = parsed.AX_LLM_PROXY_URL ?? '';
    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const proxyPort = Number(new URL(proxyUrl).port);

    await result.handle.kill();
    await result.handle.exited;

    // Poll: re-bind on the port to prove llm-proxy:stop released it.
    let bound = false;
    for (let i = 0; i < 20; i++) {
      const reclaim = (await import('node:http')).createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          reclaim.once('error', reject);
          reclaim.listen(proxyPort, '127.0.0.1', () => resolve());
        });
        bound = true;
        await new Promise<void>((r) => reclaim.close(() => r()));
        break;
      } catch {
        // Port still held — wait and retry.
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(bound).toBe(true);
    await fs.rm(ws, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // Phase 2 — proxyConfig env injection
  //
  // When the orchestrator passes a proxyConfig blob, we write the CA cert
  // PEM to the per-session tempdir and inject HTTPS_PROXY / HTTP_PROXY /
  // NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / AX_PROXY_* / envMap into the
  // child env. CA private keys never enter the sandbox (I1) — the
  // certificate is a public key only.
  // ---------------------------------------------------------------------

  it('writes CA cert + injects HTTPS_PROXY / NODE_EXTRA_CA_CERTS when proxyConfig.endpoint is set', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'proxy-tcp-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        proxyConfig: {
          endpoint: 'http://127.0.0.1:54321',
          caCertPem: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n',
          envMap: { ANTHROPIC_API_KEY: 'ax-cred:0123' },
        },
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    expect(parsed.HTTPS_PROXY).toBe('http://127.0.0.1:54321');
    expect(parsed.HTTP_PROXY).toBe('http://127.0.0.1:54321');
    expect(parsed.AX_PROXY_ENDPOINT).toBe('http://127.0.0.1:54321');
    expect(parsed.AX_PROXY_UNIX_SOCKET).toBeNull();
    expect(parsed.ANTHROPIC_API_KEY).toBe('ax-cred:0123');
    // Phase 2: when proxyConfig is set, the legacy in-sandbox llm-proxy is
    // NOT started — the runner reaches the credential-proxy directly via
    // HTTPS_PROXY. AX_LLM_PROXY_URL must be unset so a future runner that
    // accidentally reads both vars doesn't pick the wrong path.
    expect(parsed.AX_LLM_PROXY_URL).toBeNull();
    // CA file path lands inside the per-session tempdir (same one the IPC
    // socket uses — 0700 mode, host uid only).
    const caPath = parsed.NODE_EXTRA_CA_CERTS;
    expect(caPath).toMatch(/\/ax-ipc-.*\/ax-mitm-ca\.pem$/);
    expect(parsed.SSL_CERT_FILE).toBe(caPath);
    // CA file actually exists on disk and contains the PEM.
    const onDisk = await fs.readFile(caPath as string, 'utf8');
    expect(onDisk).toContain('-----BEGIN CERTIFICATE-----');
    expect(onDisk).toContain('FAKE');

    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    // Tempdir cleanup sweeps the CA file too — no separate handler.
    await expect(fs.stat(caPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('passes through proxyConfig.unixSocketPath as AX_PROXY_UNIX_SOCKET (no HTTPS_PROXY rewrite)', async () => {
    // Subprocess sandbox passes the path through as-is; the runner-side
    // bridge owns the unix-socket → local-TCP-port translation. We verify
    // here that this plugin does NOT pre-set HTTPS_PROXY when only the
    // unix socket is given.
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'proxy-unix-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        proxyConfig: {
          unixSocketPath: '/var/run/ax/proxy.sock',
          caCertPem: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n',
          envMap: {},
        },
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    expect(parsed.AX_PROXY_UNIX_SOCKET).toBe('/var/run/ax/proxy.sock');
    expect(parsed.AX_PROXY_ENDPOINT).toBeNull();
    expect(parsed.HTTPS_PROXY).toBeNull();
    expect(parsed.HTTP_PROXY).toBeNull();
    // CA still lands.
    expect(parsed.NODE_EXTRA_CA_CERTS).toMatch(/ax-mitm-ca\.pem$/);

    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('does not inject any proxy env when proxyConfig is undefined', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'no-proxy', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    expect(parsed.HTTPS_PROXY).toBeNull();
    expect(parsed.HTTP_PROXY).toBeNull();
    expect(parsed.AX_PROXY_ENDPOINT).toBeNull();
    expect(parsed.AX_PROXY_UNIX_SOCKET).toBeNull();
    expect(parsed.NODE_EXTRA_CA_CERTS).toBeNull();
    expect(parsed.SSL_CERT_FILE).toBeNull();
    expect(parsed.ANTHROPIC_API_KEY).toBeNull();
    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rolls back ipc + session + tempdir when CA write fails (proxyConfig path)', async () => {
    // CA write happens AFTER session:create + ipc:start. If it throws, the
    // function used to exit without rollback, leaking a live token + a
    // bound ipc listener. We force fs.writeFile to throw and assert the
    // listener slot is free again (rebinding the same sessionId via
    // ipc:start would throw 'already-running' otherwise — same shape as
    // the llm-proxy:start rollback test below).
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();

    // Spy on fs.promises.writeFile and force the FIRST CA write to throw.
    // We restore right after `bus.call` to avoid affecting the rest of
    // the suite.
    const realWriteFile = fs.writeFile;
    const spy = vi
      .spyOn(fs, 'writeFile')
      .mockImplementationOnce(async (filePath: unknown) => {
        // Only throw for the MITM CA path; let other writes pass through.
        if (typeof filePath === 'string' && filePath.endsWith('ax-mitm-ca.pem')) {
          throw new Error('disk full');
        }
        return realWriteFile.call(fs, filePath as string, '');
      });

    let caught: unknown;
    try {
      await h.bus.call<unknown, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        {
          sessionId: 'ca-rb-1',
          workspaceRoot: ws,
          runnerBinary: ECHO_STUB,
          proxyConfig: {
            endpoint: 'http://127.0.0.1:54321',
            caCertPem: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n',
            envMap: {},
          },
        },
      );
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('ca-write-failed');
    expect((caught as PluginError).message).toContain('failed to write MITM CA cert');

    // Rollback evidence: ipc:start now succeeds again on the same sessionId,
    // which it wouldn't if the prior listener slot were still held.
    const rebindDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ipc-ca-rb-'));
    const rebindSock = path.join(rebindDir, 'ipc.sock');
    await expect(
      h.bus.call('ipc:start', ctx, { socketPath: rebindSock, sessionId: 'ca-rb-1' }),
    ).resolves.toMatchObject({ running: true });
    await h.bus.call('ipc:stop', ctx, { sessionId: 'ca-rb-1' });
    await fs.rm(rebindDir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rejects proxyConfig with both endpoint AND unixSocketPath set', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call(
        'sandbox:open-session',
        ctx,
        {
          sessionId: 'proxy-bad',
          workspaceRoot: ws,
          runnerBinary: ECHO_STUB,
          proxyConfig: {
            endpoint: 'http://127.0.0.1:54321',
            unixSocketPath: '/var/run/ax/proxy.sock',
            caCertPem: 'x',
            envMap: {},
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rolls back ipc + session + tempdir when llm-proxy:start fails', async () => {
    const ws = await mkWorkspace();
    // Build a harness where llm-proxy:start always throws.
    const h = await createTestHarness({
      services: {
        'llm:call': async () => ({
          assistantMessage: { role: 'assistant', content: '' },
          toolCalls: [],
        }),
        'tool:list': async () => ({ tools: [] }),
        'llm-proxy:start': async () => {
          throw new PluginError({
            code: 'bind-failed',
            plugin: 'test-mock',
            hookName: 'llm-proxy:start',
            message: 'boom',
          });
        },
        'llm-proxy:stop': async () => ({}),
      },
      plugins: [
        createSessionInmemoryPlugin(),
        createIpcServerPlugin(),
        createSandboxSubprocessPlugin(),
      ],
    });
    const ctx = h.ctx();

    let caught: unknown;
    try {
      await h.bus.call<unknown, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        { sessionId: 'rb-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).message).toContain('boom');

    // Rollback: ipc-server's `ipc:start` tracks listeners by sessionId with
    // an 'already-running' guard. If rollback didn't call `ipc:stop`, a
    // fresh `ipc:start` on the same sessionId would throw 'already-running'.
    // Verify that the listener slot is free.
    const rebindDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ipc-rb-'));
    const rebindSock = path.join(rebindDir, 'ipc.sock');
    await expect(
      h.bus.call('ipc:start', ctx, { socketPath: rebindSock, sessionId: 'rb-1' }),
    ).resolves.toMatchObject({ running: true });
    await h.bus.call('ipc:stop', ctx, { sessionId: 'rb-1' });
    await fs.rm(rebindDir, { recursive: true, force: true });

    await fs.rm(ws, { recursive: true, force: true });
  });
});
