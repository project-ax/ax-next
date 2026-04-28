// Tests for `ax-next credentials login anthropic` (Phase 3 Task 12).
//
// We don't talk to Anthropic — fetch is mocked. We DO bind 127.0.0.1:1455
// (the redirect listener), and the test simulates the browser by sending
// an HTTP GET to /callback?code=...&state=... after the listener is up.
// `openBrowserImpl` is stubbed to capture the authorize URL the CLI would
// have opened, then synthesizes the redirect once the URL is captured.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCredentialsCommand } from '../commands/credentials.js';

const TEST_KEY_HEX = '42'.repeat(32);
const REDIRECT_PORT = 1455;

function stdinFromString(s: string): AsyncIterable<Buffer> {
  return (async function* () {
    if (s !== '') yield Buffer.from(s, 'utf8');
  })();
}

/**
 * Send a GET to 127.0.0.1:1455/callback with the given query string. Returns
 * the response body (so the test can assert the user-facing HTML).
 */
async function sendCallback(qs: string): Promise<{ status: number; body: string }> {
  const url = `http://127.0.0.1:${REDIRECT_PORT}/callback?${qs}`;
  // Small retry — the listener might not be up yet on slow CI.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      return { status: res.status, body };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`callback retries exhausted: ${String(lastErr)}`);
}

/**
 * Drop in a fake Anthropic /v1/oauth/token endpoint by patching globalThis.fetch.
 * Restores at the end of the suite.
 */
let savedFetch: typeof globalThis.fetch;

describe('ax-next credentials login anthropic', () => {
  let tmp: string;

  beforeEach(() => {
    process.env.AX_CREDENTIALS_KEY = TEST_KEY_HEX;
    tmp = mkdtempSync(join(tmpdir(), 'ax-cred-login-test-'));
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  // The actual exchange: mocked Anthropic returns access/refresh/expires_in.
  // Localhost calls (the test's own callback simulation) pass through to the
  // real fetch — otherwise we'd swallow our own redirect.
  function stubAnthropicTokenEndpoint(): void {
    const realFetch = savedFetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'tok-A',
            refresh_token: 'r-A',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      // Pass through anything else (the test's own loopback callback).
      return realFetch(input, init);
    }) as unknown as typeof globalThis.fetch;
  }

  it('happy path: opens browser → callback → exchange → credentials:set', async () => {
    stubAnthropicTokenEndpoint();
    const sqlitePath = join(tmp, 'db.sqlite');
    const stdoutLines: string[] = [];
    let capturedUrl = '';

    const openBrowserImpl = (url: string): void => {
      capturedUrl = url;
      const u = new URL(url);
      const state = u.searchParams.get('state')!;
      // Simulate the browser landing on /callback after the user authorizes.
      // Fire-and-forget so the CLI command can keep running.
      void sendCallback(`code=auth-code-xyz&state=${encodeURIComponent(state)}`);
    };

    const code = await runCredentialsCommand({
      argv: ['login', 'anthropic'],
      stdin: stdinFromString(''),
      stdout: (l) => stdoutLines.push(l),
      stderr: () => {},
      sqlitePath,
      openBrowserImpl,
    });

    expect(code).toBe(0);
    expect(capturedUrl).toContain('claude.ai/oauth/authorize');
    expect(capturedUrl).toContain('code_challenge_method=S256');
    expect(stdoutLines.join('\n')).toContain("ref='anthropic-personal'");

    // Verify the credential was actually stored (round-trip via the same
    // sqlite file). Re-bootstrap a small bus and read it back.
    const { HookBus, bootstrap, makeAgentContext } = await import('@ax/core');
    const { createStorageSqlitePlugin } = await import('@ax/storage-sqlite');
    const { createCredentialsStoreDbPlugin } = await import('@ax/credentials-store-db');
    const { createCredentialsPlugin } = await import('@ax/credentials');
    const { createCredentialsAnthropicOauthPlugin } = await import(
      '@ax/credentials-anthropic-oauth'
    );
    const bus = new HookBus();
    const handle = await bootstrap({
      bus,
      plugins: [
        createStorageSqlitePlugin({ databasePath: sqlitePath }),
        createCredentialsStoreDbPlugin(),
        createCredentialsPlugin(),
        createCredentialsAnthropicOauthPlugin(),
      ],
      config: {},
    });
    const value = await bus.call<{ ref: string; userId: string }, string>(
      'credentials:get',
      makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'cli' }),
      { ref: 'anthropic-personal', userId: 'cli' },
    );
    // 5min refresh-buffer hasn't elapsed (just exchanged), so the resolver
    // returns the access token directly without refresh.
    expect(value).toBe('tok-A');
    await handle.shutdown();
  });

  it('rejects with state mismatch error when redirect carries a wrong state (CSRF defense)', async () => {
    stubAnthropicTokenEndpoint();
    const stderrLines: string[] = [];
    const openBrowserImpl = (url: string): void => {
      // Send a wrong state — the CLI should reject before calling exchange.
      void sendCallback(`code=auth-code&state=WRONG-STATE`);
      void url;
    };
    const code = await runCredentialsCommand({
      argv: ['login', 'anthropic'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
      openBrowserImpl,
    });
    expect(code).toBe(1);
    expect(stderrLines.join('\n').toLowerCase()).toContain('state mismatch');
  });

  it('reports an OAuth error when the redirect carries ?error=...', async () => {
    stubAnthropicTokenEndpoint();
    const stderrLines: string[] = [];
    const openBrowserImpl = (): void => {
      void sendCallback('error=access_denied');
    };
    const code = await runCredentialsCommand({
      argv: ['login', 'anthropic'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
      openBrowserImpl,
    });
    expect(code).toBe(1);
    expect(stderrLines.join('\n').toLowerCase()).toContain('access_denied');
  });

  it('exits 2 on `credentials login` without a provider', async () => {
    const stderrLines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['login'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });
    expect(code).toBe(2);
    expect(stderrLines.join('\n')).toContain('login anthropic');
  });

  it('exits 2 on `credentials login unknown-provider`', async () => {
    const stderrLines: string[] = [];
    const code = await runCredentialsCommand({
      argv: ['login', 'github'],
      stdin: stdinFromString(''),
      stdout: () => {},
      stderr: (l) => stderrLines.push(l),
      sqlitePath: join(tmp, 'db.sqlite'),
    });
    expect(code).toBe(2);
    expect(stderrLines.join('\n')).toContain('login anthropic');
  });

  it('exits 1 with EADDRINUSE when port 1455 is already taken', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(1455, '127.0.0.1', r));
    try {
      const stderrLines: string[] = [];
      const code = await runCredentialsCommand({
        argv: ['login', 'anthropic'],
        stdin: stdinFromString(''),
        stdout: () => {},
        stderr: (l) => stderrLines.push(l),
        sqlitePath: join(tmp, 'db.sqlite'),
        openBrowserImpl: () => {},
      });
      expect(code).toBe(1);
      expect(stderrLines.join('\n')).toMatch(/in use|EADDRINUSE/i);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
    void (blocker.address() as AddressInfo);
  });
});
