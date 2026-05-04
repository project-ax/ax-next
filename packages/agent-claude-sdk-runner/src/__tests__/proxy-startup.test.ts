import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setupProxy } from '../proxy-startup.js';
import type { RunnerEnv } from '../env.js';
import { MissingEnvError } from '../env.js';

// Snapshot a few env vars setupProxy mutates so the test suite stays
// deterministic — tests run sequentially in vitest by default but
// process.env is process-global, so be defensive.
const ENV_KEYS_TO_SAVE = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ANTHROPIC_API_KEY',
  'AX_AUTH_TOKEN',
  'AX_RUNNER_ENDPOINT',
  'AX_SESSION_ID',
] as const;

describe('setupProxy', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS_TO_SAVE) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS_TO_SAVE) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // -------------------------------------------------------------------
  // Direct mode — AX_PROXY_ENDPOINT (subprocess sandbox).
  // -------------------------------------------------------------------

  it('direct mode: forwards process.env.ANTHROPIC_API_KEY (the placeholder); no ANTHROPIC_BASE_URL; no bridge', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    // setupProxy now also stamps HTTPS_PROXY/HTTP_PROXY/NODE_OPTIONS so
    // the SDK subprocess routes its outbound fetch through the bridge
    // (see proxy-bootstrap.cjs). Pin the credential placeholder here;
    // the proxy + bootstrap details are covered by their own assertions.
    expect(out.anthropicEnv.ANTHROPIC_API_KEY).toBe(
      'ax-cred:0123456789abcdef0123456789abcdef',
    );
    expect(out.anthropicEnv.HTTPS_PROXY).toBe('http://127.0.0.1:54321');
    expect(out.anthropicEnv.HTTP_PROXY).toBe('http://127.0.0.1:54321');
    // The bootstrap path is JSON.stringify-quoted so install paths with
    // spaces don't split NODE_OPTIONS at the whitespace boundary.
    expect(out.anthropicEnv.NODE_OPTIONS).toMatch(
      /--require="[^"]*proxy-bootstrap\.cjs"/,
    );
    expect(out.anthropicEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(out.stop).toBeUndefined();
    // Direct mode: sandbox-subprocess set HTTPS_PROXY in the child env at
    // spawn time. setupProxy MUST NOT clobber that. We didn't set it in
    // this test process either, so it stays undefined.
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  });

  it('direct mode: throws if ANTHROPIC_API_KEY placeholder is missing', async () => {
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    await expect(setupProxy(env)).rejects.toBeInstanceOf(MissingEnvError);
  });

  it('direct mode: rejects ANTHROPIC_API_KEY that is not the ax-cred:<32-hex> placeholder', async () => {
    // I1 defense: a regressed wiring that lands a real `sk-ant-...` key (or
    // any non-placeholder string) in the runner's env must fail loud, not
    // forward upstream. The runner enforces the exact format minted by
    // @ax/credential-proxy's registry.
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const realLookingKeys = [
      'sk-ant-real-looking-key',
      'ax-cred:short',
      'ax-cred:0123456789abcdef0123456789abcdeg', // non-hex 'g'
      'ax-cred:0123456789ABCDEF0123456789ABCDEF', // uppercase
      'ax-cred:',
      'AX-CRED:0123456789abcdef0123456789abcdef', // wrong case prefix
    ];
    for (const k of realLookingKeys) {
      process.env.ANTHROPIC_API_KEY = k;
      await expect(setupProxy(env)).rejects.toBeInstanceOf(MissingEnvError);
    }
  });

  // -------------------------------------------------------------------
  // Bridge mode — AX_PROXY_UNIX_SOCKET (k8s sandbox).
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Capability minimization (I5): control-plane env vars must NOT be
  // forwarded into the SDK subprocess. The Bash tool can spawn arbitrary
  // commands the model requests; an `echo $AX_AUTH_TOKEN` would land the
  // bearer in tool output → model context → assistant reply. A regression
  // here is a real exfiltration path.
  // -------------------------------------------------------------------

  it('direct mode: does NOT forward AX_* control-plane env into the SDK subprocess', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123456789abcdef0123456789abcdef';
    process.env.AX_AUTH_TOKEN = 'ipc-bearer-secret';
    process.env.AX_RUNNER_ENDPOINT = 'http://host.internal:9090';
    process.env.AX_SESSION_ID = 'sess-1234';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer-secret',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    expect(out.anthropicEnv.AX_AUTH_TOKEN).toBeUndefined();
    expect(out.anthropicEnv.AX_RUNNER_ENDPOINT).toBeUndefined();
    expect(out.anthropicEnv.AX_SESSION_ID).toBeUndefined();
    // Sanity: PATH (allow-listed) IS forwarded so the Bash tool works.
    expect(out.anthropicEnv.PATH).toBe(process.env.PATH);
  });

  it('throws when both proxyEndpoint and proxyUnixSocket are set (mutually exclusive)', async () => {
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
      proxyUnixSocket: '/var/run/ax/proxy.sock',
    };
    await expect(setupProxy(env)).rejects.toThrow(/mutually exclusive/);
  });

  it('bridge mode: stops the bridge if downstream validation throws', async () => {
    // Regression: setupProxy used to start the bridge, then if the
    // ANTHROPIC_API_KEY check failed, return without calling stop().
    // The TCP listener stayed bound on 127.0.0.1 until the runner exited.
    // We reproduce by NOT setting ANTHROPIC_API_KEY in process.env and
    // verifying the bridge port is released before the rejection settles.
    const sockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-test-bridge-cleanup-'));
    const sockPath = path.join(sockDir, 'proxy.sock');
    const upstream = net.createServer();
    await new Promise<void>((resolve) => upstream.listen(sockPath, resolve));

    try {
      const env: RunnerEnv = {
        runnerEndpoint: 'unix:///tmp/x.sock',
        sessionId: 's',
        authToken: 'ipc-bearer',
        workspaceRoot: '/ws',
        proxyUnixSocket: sockPath,
      };
      // ANTHROPIC_API_KEY intentionally NOT set in process.env (beforeEach
      // already deleted it). setupProxy starts the bridge, then throws on
      // the placeholder check.
      await expect(setupProxy(env)).rejects.toBeInstanceOf(MissingEnvError);

      // The bridge's port should be free now: rebinding it must succeed.
      // We can't read the original port directly (setupProxy threw), so
      // we test the contract via process.env.HTTPS_PROXY which IS set
      // before the throw — the URL holds the bridge port.
      const proxyUrl = process.env.HTTPS_PROXY;
      expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const port = Number(new URL(proxyUrl as string).port);

      // Polling re-bind: vitest may schedule async cleanup with a slight
      // delay even after the rejection settles. Up to ~250ms is plenty.
      let bound = false;
      for (let i = 0; i < 25; i++) {
        const reclaim = (await import('node:http')).createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            reclaim.once('error', reject);
            reclaim.listen(port, '127.0.0.1', () => resolve());
          });
          bound = true;
          await new Promise<void>((r) => reclaim.close(() => r()));
          break;
        } catch {
          // Port still held — retry briefly.
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(
        bound,
        'expected bridge port to be released after setupProxy threw',
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await fs.rm(sockDir, { recursive: true, force: true });
    }
  });

  it('bridge mode: starts the bridge, rewrites process.env.HTTPS_PROXY, returns stop()', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:fedcba9876543210fedcba9876543210';

    // Spin up a no-op Unix socket server so the bridge has something to
    // dial. The bridge doesn't actually open a connection at start — it
    // listens for incoming TCP — but constructing the undici Agent
    // doesn't need the socket to exist either. We make one anyway so the
    // test doesn't depend on undici's tolerance for missing paths.
    const sockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-test-bridge-'));
    const sockPath = path.join(sockDir, 'proxy.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const env: RunnerEnv = {
        runnerEndpoint: 'unix:///tmp/x.sock',
        sessionId: 's',
        authToken: 'ipc-bearer',
        workspaceRoot: '/ws',
        proxyUnixSocket: sockPath,
      };
      const out = await setupProxy(env);
      try {
        expect(out.stop).toBeInstanceOf(Function);
        // process.env.HTTP_PROXY / HTTPS_PROXY now point at a loopback
        // bridge port on 127.0.0.1.
        expect(process.env.HTTP_PROXY).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+$/,
        );
        expect(process.env.HTTPS_PROXY).toBe(process.env.HTTP_PROXY);
        // anthropicEnv carries the placeholder; no ANTHROPIC_BASE_URL.
        // Plus the proxy + NODE_OPTIONS bootstrap so the SDK subprocess
        // routes its outbound fetch through the bridge.
        expect(out.anthropicEnv.ANTHROPIC_API_KEY).toBe(
          'ax-cred:fedcba9876543210fedcba9876543210',
        );
        expect(out.anthropicEnv.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(out.anthropicEnv.HTTP_PROXY).toBe(out.anthropicEnv.HTTPS_PROXY);
        expect(out.anthropicEnv.NODE_OPTIONS).toMatch(
          /--require="[^"]*proxy-bootstrap\.cjs"/,
        );
        expect(out.anthropicEnv.ANTHROPIC_BASE_URL).toBeUndefined();
      } finally {
        out.stop?.();
      }
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      await fs.rm(sockDir, { recursive: true, force: true });
    }
  });
});
