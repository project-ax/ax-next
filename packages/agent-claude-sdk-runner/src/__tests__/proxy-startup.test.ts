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
const ENV_KEYS_TO_SAVE = ['HTTP_PROXY', 'HTTPS_PROXY', 'ANTHROPIC_API_KEY'] as const;

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
  // Legacy mode — AX_LLM_PROXY_URL only.
  // -------------------------------------------------------------------

  it('legacy mode: returns ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY=authToken; no bridge', async () => {
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      llmProxyUrl: 'http://127.0.0.1:4000',
    };
    const out = await setupProxy(env);
    expect(out.anthropicEnv).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
      ANTHROPIC_API_KEY: 'ipc-bearer',
    });
    expect(out.stop).toBeUndefined();
    // Legacy mode does NOT mutate process.env proxies.
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Direct mode — AX_PROXY_ENDPOINT (subprocess sandbox).
  // -------------------------------------------------------------------

  it('direct mode: forwards process.env.ANTHROPIC_API_KEY (the placeholder); no ANTHROPIC_BASE_URL; no bridge', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:0123';
    const env: RunnerEnv = {
      runnerEndpoint: 'unix:///tmp/x.sock',
      sessionId: 's',
      authToken: 'ipc-bearer',
      workspaceRoot: '/ws',
      proxyEndpoint: 'http://127.0.0.1:54321',
    };
    const out = await setupProxy(env);
    expect(out.anthropicEnv).toEqual({ ANTHROPIC_API_KEY: 'ax-cred:0123' });
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

  // -------------------------------------------------------------------
  // Bridge mode — AX_PROXY_UNIX_SOCKET (k8s sandbox).
  // -------------------------------------------------------------------

  it('bridge mode: starts the bridge, rewrites process.env.HTTPS_PROXY, returns stop()', async () => {
    process.env.ANTHROPIC_API_KEY = 'ax-cred:abcd';

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
        expect(out.anthropicEnv).toEqual({ ANTHROPIC_API_KEY: 'ax-cred:abcd' });
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
