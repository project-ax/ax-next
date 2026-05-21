import { describe, it, expect, vi } from 'vitest';
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
      createSandboxSubprocessPlugin(),
    ],
  });
}

// Poll until `target` no longer exists on disk (the async 'close' cleanup
// handler has rmdir'd it). CI machines under load can take >50ms to drain
// the 'close' event, so a fixed sleep here is flaky — wait on the actual
// condition instead. The caller still asserts ENOENT after; this just
// gives that assertion enough headroom to be deterministic.
async function waitForRemoval(target: string, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const stillThere = await fs.stat(target).then(
      () => true,
      () => false,
    );
    if (!stillThere) return;
    await new Promise((r) => setTimeout(r, 25));
  }
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

    // Socket dir is removed by the async 'close' cleanup handler. Poll
    // until it's gone (or timeout) so this isn't flaky under CI load.
    const socketDir = path.dirname(endpointToSocketPath(result.runnerEndpoint));
    await waitForRemoval(socketDir);
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
    // The token must NOT be echoed in the returned surface.
    expect(JSON.stringify(result)).not.toContain(parsed.AX_AUTH_TOKEN);

    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('stamps git author/committer identity + paranoid config on the child env (parity with k8s)', async () => {
    // Mirrors `sandbox-k8s/pod-spec.ts`'s gitParanoidEnv block. Without this,
    // the runner's turn-end git commit falls through to whatever's sitting
    // in the host operator's ~/.gitconfig, the bundle reaches commit-notify
    // with the wrong author, and the host's verifyBundleAuthor rejects it
    // with `expected ax-runner <ax-runner@example.com>` — bricking every
    // subprocess chat.
    //
    // HOME deliberately diverges between providers (subprocess uses the
    // per-session tempdir; k8s pins /home/runner) — only the GIT_* vars
    // need byte-for-byte parity.
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'git-env-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    expect(parsed.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(parsed.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(parsed.GIT_TERMINAL_PROMPT).toBe('0');
    expect(parsed.GIT_AUTHOR_NAME).toBe('ax-runner');
    expect(parsed.GIT_AUTHOR_EMAIL).toBe('ax-runner@example.com');
    expect(parsed.GIT_COMMITTER_NAME).toBe('ax-runner');
    expect(parsed.GIT_COMMITTER_EMAIL).toBe('ax-runner@example.com');
    expect(parsed.GIT_CONFIG_COUNT).toBe('1');
    expect(parsed.GIT_CONFIG_KEY_0).toBe('safe.directory');
    expect(parsed.GIT_CONFIG_VALUE_0).toBe('*');

    await result.handle.kill();
    await result.handle.exited;
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

  // ---------------------------------------------------------------------
  // proxyConfig env injection
  //
  // When the orchestrator passes a proxyConfig blob, we write the CA cert
  // PEM to the per-session tempdir and inject HTTPS_PROXY / HTTP_PROXY /
  // NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / AX_PROXY_* / envMap into the
  // child env. CA private keys never enter the sandbox (I1) — the
  // certificate is a public key only.
  //
  // When proxyConfig is undefined, no proxy env is injected and the
  // runner fails at boot (no AX_PROXY_*). That's the intended Phase 5
  // behavior; presets that want a working runner load
  // @ax/credential-proxy and the orchestrator threads proxyConfig through.
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
    // Tempdir cleanup sweeps the CA file too — no separate handler.
    // Poll for the removal so CI load doesn't flake the assertion.
    await waitForRemoval(caPath as string);
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

  it('proxyConfig.envMap wins over a same-named allowlisted parent env (defense-in-depth)', async () => {
    // Today the allowlist (PATH/HOME/LANG/LC_ALL/TZ/NODE_OPTIONS) doesn't
    // overlap with the proxy keys envMap carries (ANTHROPIC_API_KEY,
    // HTTPS_PROXY, etc.). But if a future expansion ever did — e.g. an
    // operator adds ANTHROPIC_API_KEY to the allowlist — the session-
    // scoped placeholder MUST still win. A parent ANTHROPIC_API_KEY
    // leaking into the sandbox would re-introduce a real credential into
    // a process that's only supposed to see ax-cred:<hex> placeholders
    // (I1).
    //
    // We simulate the overlap by aiming envMap at HOME — already in the
    // allowlist — and proving the child sees the envMap value, not the
    // parent's. The spread order is the only thing under test.
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const priorHome = process.env.HOME;
    process.env.HOME = '/parent/home/should/lose';
    try {
      const result = await h.bus.call<unknown, OpenSessionResult>(
        'sandbox:open-session',
        ctx,
        {
          sessionId: 'envmap-precedence-1',
          workspaceRoot: ws,
          runnerBinary: ECHO_STUB,
          proxyConfig: {
            endpoint: 'http://127.0.0.1:54321',
            caCertPem: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n',
            envMap: { HOME: '/session/home/wins' },
          },
        },
      );
      const line = await readFirstStdoutLine(result);
      const parsed = JSON.parse(line) as Record<string, string | null>;
      expect(parsed.HOME).toBe('/session/home/wins');
      await result.handle.kill();
      await result.handle.exited;
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rolls back ipc + session + tempdir when CA write fails (proxyConfig path)', async () => {
    // CA write happens AFTER session:create + ipc:start. If it throws, the
    // function used to exit without rollback, leaking a live token + a
    // bound ipc listener. We force fs.writeFile to throw and assert the
    // listener slot is free again (rebinding the same sessionId via
    // ipc:start would throw 'already-running' otherwise).
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

  it('owner.conversationId round-trips through session:create → session:get-config', async () => {
    // Bug 1 regression net: prior to this fix, OpenSessionInputSchema
    // stripped `owner.conversationId` (it wasn't declared on the Zod
    // schema) so session:create wrote the v2 row with conversation_id =
    // NULL even when the orchestrator had set ctx.conversationId. The
    // runner's bind-skip branch then fired and resume-on-second-turn
    // never landed — surfaced as runner-owned-sessions-k8s-gap.test.ts:
    // 137. The k8s sibling carries the same fix; both must update in
    // the same PR (no half-wired sandbox windows).
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'sub-conv',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        owner: {
          userId: 'u-1',
          agentId: 'agt-1',
          agentConfig: {
            systemPrompt: 'be helpful',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
          conversationId: 'conv-77',
        },
      },
    );

    const cfg = await h.bus.call<unknown, { conversationId: string | null }>(
      'session:get-config',
      h.ctx({ sessionId: 'sub-conv' }),
      {},
    );
    expect(cfg.conversationId).toBe('conv-77');

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // I-P0-3 / I-P0-4: per-session HOME + CLAUDE_CONFIG_DIR + workspace
  // skills symlink.
  //
  // The Claude Agent SDK's skill discovery walks two paths:
  //   - `'project'` source → `<cwd>/.claude/skills/`
  //   - `'user'` source    → `$CLAUDE_CONFIG_DIR/skills/` (fallback: `$HOME/.claude/skills/`)
  //
  // The sandbox MUST point both at host-controlled directories so the
  // developer's personal `~/.claude/skills/` never leaks into the
  // sandbox, and so the agent can't drop arbitrary content into
  // `.claude/skills/` (that surface is owned by the host validator).
  // ---------------------------------------------------------------------

  it('allocates a per-session HOME and sets CLAUDE_CONFIG_DIR under it (I-P0-3)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'p0-home', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;

    // HOME is set, lives under the per-session socket tempdir (so cleanup
    // piggybacks), and is NOT the host's HOME.
    expect(typeof parsed.HOME).toBe('string');
    expect(parsed.HOME).not.toBe(process.env.HOME ?? null);
    expect(parsed.HOME).toMatch(/\/ax-ipc-.*\/home$/);

    // CLAUDE_CONFIG_DIR points at $HOME/.ax/session.
    expect(parsed.CLAUDE_CONFIG_DIR).toBe(
      path.join(parsed.HOME as string, '.ax', 'session'),
    );

    // The installed-skills dir exists on disk before the runner spawned —
    // by the time stdout has been echoed, mkdir has long since resolved,
    // so we can stat it now.
    const installedSkills = path.join(parsed.CLAUDE_CONFIG_DIR as string, 'skills');
    const st = await fs.stat(installedSkills);
    expect(st.isDirectory()).toBe(true);

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('cleans up the per-session HOME on child close (piggybacks on socketDir rm)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'p0-home-cleanup', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const homeDir = parsed.HOME as string;
    // Sanity: exists before close.
    await expect(fs.stat(homeDir)).resolves.toBeDefined();

    await result.handle.kill();
    await result.handle.exited;

    await waitForRemoval(homeDir);
    await expect(fs.stat(homeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('leaves <workspace> empty before the runner spawns (I-P0-4)', async () => {
    // Regression guard for PR #99's k8s fix mirrored on the subprocess side:
    // open-session used to scaffold `<workspace>/.claude/skills →
    // ../.ax/skills` before spawning the runner. The runner's own
    // `materializeWorkspace` then `git clone`s into `<workspace>`, which
    // refuses ANY non-empty target — chat sat on "Starting sandbox…" forever.
    // The scaffold moved to the runner main
    // (`scaffoldWorkspaceSkillSurface` in @ax/agent-claude-sdk-runner's
    // git-workspace.ts), which runs after `materializeWorkspace`. Open-
    // session must leave `<workspace>` untouched so the clone has a clean
    // target.
    //
    // Asserting on `fs.readdir` (not a specific path list) is the right
    // shape: any top-level write — `.claude`, `.ax`, a stray dotfile,
    // a new feature that thinks it can pre-populate the workspace — would
    // collide with `git clone`. A narrow `fs.stat('.claude')` check would
    // pass while the regression still bricked chat. This test stubs out
    // the runner (echo-stub doesn't materialize), so we observe the
    // pre-spawn state directly.
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'p0-no-prescaffold', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );

    await expect(fs.readdir(ws)).resolves.toEqual([]);

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('omits conversationId when owner has no conversationId (back-compat with non-orchestrator callers)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'sub-noconv',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        owner: {
          userId: 'u-1',
          agentId: 'agt-1',
          agentConfig: {
            systemPrompt: 'be helpful',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
        },
      },
    );

    const cfg = await h.bus.call<unknown, { conversationId: string | null }>(
      'session:get-config',
      h.ctx({ sessionId: 'sub-noconv' }),
      {},
    );
    expect(cfg.conversationId).toBeNull();

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // I-P1-3: installed-skills materialization (Phase 1).
  //
  // The sandbox writes each skill's SKILL.md to
  // $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md (mode 0444) then chmods
  // the parent dir to 0555 so the runner's tool calls can't extend or
  // overwrite. Phase 0 left the dir empty + 0755; Phase 1 fills + locks
  // atomically inside the existing sandbox-prep try block.
  // ---------------------------------------------------------------------

  it('writes each skill SKILL.md and chmods parent dir to 0555 (I-P1-3)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'skills-write-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          { id: 'github', skillMd: '---\nname: github\ndescription: x\n---\nBody' },
        ],
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const ccd = parsed.CLAUDE_CONFIG_DIR as string;

    const skillMdPath = path.join(ccd, 'skills', 'github', 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');
    expect(content).toBe('---\nname: github\ndescription: x\n---\nBody');

    const skillsDirStat = await fs.stat(path.join(ccd, 'skills'));
    expect(skillsDirStat.mode & 0o777).toBe(0o555);

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('skills dir stays 0755 when installedSkills is absent (Phase 0 default)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      { sessionId: 'skills-absent-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const ccd = parsed.CLAUDE_CONFIG_DIR as string;

    const skillsDirStat = await fs.stat(path.join(ccd, 'skills'));
    expect(skillsDirStat.mode & 0o777).toBe(0o755);

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('skills dir stays 0755 when installedSkills is empty (Phase 0 default)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'skills-empty-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [],
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const ccd = parsed.CLAUDE_CONFIG_DIR as string;

    const skillsDirStat = await fs.stat(path.join(ccd, 'skills'));
    expect(skillsDirStat.mode & 0o777).toBe(0o755);

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('overwrites an existing SKILL.md when the session reopens with different content', async () => {
    const ws = await mkWorkspace();
    // First session
    const h1 = await makeHarness();
    const ctx1 = h1.ctx();
    const r1 = await h1.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx1,
      {
        sessionId: 'skills-overwrite-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [{ id: 'github', skillMd: 'version-A' }],
      },
    );
    const line1 = await readFirstStdoutLine(r1);
    const env1 = JSON.parse(line1) as Record<string, string | null>;
    const ccd1 = env1.CLAUDE_CONFIG_DIR as string;
    const content1 = await fs.readFile(path.join(ccd1, 'skills', 'github', 'SKILL.md'), 'utf-8');
    expect(content1).toBe('version-A');

    await r1.handle.kill();
    await r1.handle.exited;

    // Second session on same workspace with different content
    const h2 = await makeHarness();
    const ctx2 = h2.ctx();
    const r2 = await h2.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx2,
      {
        sessionId: 'skills-overwrite-2',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [{ id: 'github', skillMd: 'version-B' }],
      },
    );
    const line2 = await readFirstStdoutLine(r2);
    const env2 = JSON.parse(line2) as Record<string, string | null>;
    const ccd2 = env2.CLAUDE_CONFIG_DIR as string;
    // ccd2 lives in the second session's own per-session socketDir — independent from ccd1.
    const content2 = await fs.readFile(path.join(ccd2, 'skills', 'github', 'SKILL.md'), 'utf-8');
    expect(content2).toBe('version-B');

    await r2.handle.kill();
    await r2.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rejects an invalid skill id (e.g. ../escape) with PluginError(invalid-payload)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call(
        'sandbox:open-session',
        ctx,
        {
          sessionId: 'skills-bad-id',
          workspaceRoot: ws,
          runnerBinary: ECHO_STUB,
          installedSkills: [{ id: '../escape', skillMd: 'x' }],
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    await fs.rm(ws, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // Phase B (capabilities.mcpServers) — per-skill `.mcp.json` materialization.
  //
  // The subprocess sandbox writes `.mcp.json` alongside `SKILL.md` when a
  // skill declares mcpServers. The runner-side has a structural twin in
  // @ax/agent-claude-sdk-runner/installed-skills.ts — but the subprocess
  // path is its own code branch (writes happen pre-spawn inside the host
  // process, not inside the runner) and needs its own regression net so
  // a runner-only fix can't silently fix-by-coincidence here.
  // ---------------------------------------------------------------------

  it('writes .mcp.json next to SKILL.md when a skill declares stdio mcpServers (Phase B)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'mcp-stdio-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'github',
            skillMd: '---\nname: github\n---\nbody',
            mcpServers: [
              {
                name: 'github',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', 'pkg'],
                env: { TOKEN: 'x' },
                allowedHosts: [],
                credentials: [],
              },
            ],
          },
        ],
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const ccd = parsed.CLAUDE_CONFIG_DIR as string;
    const mcpJsonPath = path.join(ccd, 'skills', 'github', '.mcp.json');

    const mcpJson = JSON.parse(await fs.readFile(mcpJsonPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcpJson.mcpServers.github).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'x' },
    });

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('does NOT write .mcp.json when the skill has empty mcpServers (Phase B)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'mcp-empty-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'github',
            skillMd: '---\nname: github\n---\nbody',
            mcpServers: [],
          },
        ],
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const ccd = parsed.CLAUDE_CONFIG_DIR as string;
    // SKILL.md is written, .mcp.json is not.
    await expect(
      fs.stat(path.join(ccd, 'skills', 'github', 'SKILL.md')),
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(ccd, 'skills', 'github', '.mcp.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('writes .mcp.json read-only (mode 0444) (Phase B)', async () => {
    // Same defense as SKILL.md: the runner's tool calls (bash/edit) must
    // not be able to rewrite `.mcp.json` mid-session. Parent dir chmod
    // 0555 covers create/delete; per-file 0444 covers overwrite-in-place.
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'mcp-mode-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'github',
            skillMd: '---\nname: github\n---\nbody',
            mcpServers: [
              {
                name: 'github',
                transport: 'stdio',
                command: 'npx',
                args: [],
                env: {},
                allowedHosts: [],
                credentials: [],
              },
            ],
          },
        ],
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const ccd = parsed.CLAUDE_CONFIG_DIR as string;
    const mcpJsonStat = await fs.stat(
      path.join(ccd, 'skills', 'github', '.mcp.json'),
    );
    expect(mcpJsonStat.mode & 0o777).toBe(0o444);

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // Transport-specific invariants on the wire schema (Phase B follow-up).
  //
  // McpServerSchema's .refine() pins:
  //   stdio → command required (non-empty), url forbidden
  //   http  → url required, command/args/env forbidden
  // These tests go through bus.call so the PluginError(invalid-payload)
  // code path is also exercised end-to-end at the sandbox boundary.
  // ---------------------------------------------------------------------

  it('rejects a stdio mcpServers entry that is missing command (Phase B)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call('sandbox:open-session', ctx, {
        sessionId: 'mcp-stdio-no-cmd',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'github',
            skillMd: '---\nname: github\n---\nbody',
            mcpServers: [
              {
                name: 'github',
                transport: 'stdio',
                // command omitted
                allowedHosts: [],
                credentials: [],
              },
            ],
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rejects an http mcpServers entry that is missing url (Phase B)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call('sandbox:open-session', ctx, {
        sessionId: 'mcp-http-no-url',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'remote',
            skillMd: '---\nname: remote\n---\nbody',
            mcpServers: [
              {
                name: 'remote',
                transport: 'http',
                // url omitted
                allowedHosts: [],
                credentials: [],
              },
            ],
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rejects a stdio mcpServers entry that also sets url (Phase B, cross-contamination)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call('sandbox:open-session', ctx, {
        sessionId: 'mcp-stdio-with-url',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'github',
            skillMd: '---\nname: github\n---\nbody',
            mcpServers: [
              {
                name: 'github',
                transport: 'stdio',
                command: 'npx',
                url: 'https://evil.example.com',
                allowedHosts: [],
                credentials: [],
              },
            ],
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('rejects an http mcpServers entry that also sets command (Phase B, cross-contamination)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    let caught: unknown;
    try {
      await h.bus.call('sandbox:open-session', ctx, {
        sessionId: 'mcp-http-with-cmd',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'remote',
            skillMd: '---\nname: remote\n---\nbody',
            mcpServers: [
              {
                name: 'remote',
                transport: 'http',
                url: 'https://mcp.example.com',
                command: 'npx',
                allowedHosts: [],
                credentials: [],
              },
            ],
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('invalid-payload');
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('writes .mcp.json with http transport shape (Phase B)', async () => {
    const ws = await mkWorkspace();
    const h = await makeHarness();
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'mcp-http-1',
        workspaceRoot: ws,
        runnerBinary: ECHO_STUB,
        installedSkills: [
          {
            id: 'remote',
            skillMd: '---\nname: remote\n---\nbody',
            mcpServers: [
              {
                name: 'remote',
                transport: 'http',
                url: 'https://mcp.example.com',
                allowedHosts: [],
                credentials: [],
              },
            ],
          },
        ],
      },
    );
    const line = await readFirstStdoutLine(result);
    const parsed = JSON.parse(line) as Record<string, string | null>;
    const ccd = parsed.CLAUDE_CONFIG_DIR as string;
    const mcpJson = JSON.parse(
      await fs.readFile(
        path.join(ccd, 'skills', 'remote', '.mcp.json'),
        'utf8',
      ),
    ) as { mcpServers: Record<string, unknown> };
    expect(mcpJson.mcpServers.remote).toEqual({
      url: 'https://mcp.example.com',
      type: 'http',
    });

    await result.handle.kill();
    await result.handle.exited;
    await fs.rm(ws, { recursive: true, force: true });
  });

});
