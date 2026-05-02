import { describe, expect, it } from 'vitest';
import { MissingEnvError, readRunnerEnv } from '../env.js';

// Canonical Phase 2 direct-mode fixture (AX_PROXY_ENDPOINT only).
const PROXY_TCP = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_PROXY_ENDPOINT: 'http://127.0.0.1:54321',
};

// Canonical Phase 2 bridge-mode fixture (AX_PROXY_UNIX_SOCKET only).
const PROXY_UNIX = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_PROXY_UNIX_SOCKET: '/var/run/ax/proxy.sock',
};

describe('readRunnerEnv', () => {
  it('reads proxyEndpoint when only AX_PROXY_ENDPOINT is set', () => {
    expect(readRunnerEnv(PROXY_TCP)).toEqual({
      runnerEndpoint: 'unix:///tmp/ax.sock',
      sessionId: 'sess-1',
      authToken: 'tok-123',
      workspaceRoot: '/tmp/workspace',
      proxyEndpoint: 'http://127.0.0.1:54321',
    });
  });

  it('reads proxyUnixSocket when only AX_PROXY_UNIX_SOCKET is set', () => {
    expect(readRunnerEnv(PROXY_UNIX)).toEqual({
      runnerEndpoint: 'unix:///tmp/ax.sock',
      sessionId: 'sess-1',
      authToken: 'tok-123',
      workspaceRoot: '/tmp/workspace',
      proxyUnixSocket: '/var/run/ax/proxy.sock',
    });
  });

  it('throws when both AX_PROXY_ENDPOINT and AX_PROXY_UNIX_SOCKET are set (mutually exclusive)', () => {
    // The two transport vars represent different sandbox shapes
    // (subprocess vs. k8s); accepting both would silently route through
    // the bridge in setupProxy() while the operator thought they were
    // on direct mode. Fail loud at boot.
    const env = { ...PROXY_TCP, AX_PROXY_UNIX_SOCKET: '/var/run/ax/proxy.sock' };
    expect(() => readRunnerEnv(env)).toThrow(MissingEnvError);
    try {
      readRunnerEnv(env);
    } catch (err) {
      expect((err as MissingEnvError).message).toContain('mutually exclusive');
    }
  });

  it('readRunnerEnv ignores AX_LLM_PROXY_URL when AX_PROXY_ENDPOINT is set', () => {
    // Operators may have stale shell exports; the legacy var is not rejected,
    // just unread. The runner uses AX_PROXY_ENDPOINT.
    const env = readRunnerEnv({
      AX_RUNNER_ENDPOINT: 'unix:///tmp/sock',
      AX_AUTH_TOKEN: 't',
      AX_SESSION_ID: 's',
      AX_WORKSPACE_ROOT: '/tmp/ws',
      AX_PROXY_ENDPOINT: 'http://127.0.0.1:8443',
      AX_LLM_PROXY_URL: 'http://legacy.local',
    });
    expect((env as Record<string, unknown>).llmProxyUrl).toBeUndefined();
    expect(env.proxyEndpoint).toBe('http://127.0.0.1:8443');
  });

  it('readRunnerEnv rejects when neither AX_PROXY_ENDPOINT nor AX_PROXY_UNIX_SOCKET is set', () => {
    // AX_LLM_PROXY_URL set alone is no longer enough.
    const env = {
      AX_RUNNER_ENDPOINT: 'unix:///tmp/sock',
      AX_AUTH_TOKEN: 't',
      AX_SESSION_ID: 's',
      AX_WORKSPACE_ROOT: '/tmp/ws',
      AX_LLM_PROXY_URL: 'http://legacy.local',
    };
    expect(() => readRunnerEnv(env)).toThrow(MissingEnvError);
  });

  // Phase 3: AX_WORKSPACE_ROOT became optional (defaults to /permanent —
  // the sandbox's canonical mount). The other three remain required.
  for (const name of [
    'AX_RUNNER_ENDPOINT',
    'AX_SESSION_ID',
    'AX_AUTH_TOKEN',
  ] as const) {
    it(`throws MissingEnvError naming ${name} when unset`, () => {
      const env = { ...PROXY_TCP };
      delete (env as Record<string, string | undefined>)[name];
      const call = (): unknown => readRunnerEnv(env);
      expect(call).toThrow(MissingEnvError);
      try {
        call();
      } catch (err) {
        expect(err).toBeInstanceOf(MissingEnvError);
        expect((err as MissingEnvError).varName).toBe(name);
        expect((err as MissingEnvError).message).toContain(name);
      }
    });

    it(`throws MissingEnvError naming ${name} when empty string`, () => {
      const env = { ...PROXY_TCP, [name]: '' };
      const call = (): unknown => readRunnerEnv(env);
      expect(call).toThrow(MissingEnvError);
      try {
        call();
      } catch (err) {
        expect((err as MissingEnvError).varName).toBe(name);
      }
    });
  }

  it('defaults workspaceRoot to /permanent when AX_WORKSPACE_ROOT is unset', () => {
    // Lines up with the sandbox-k8s pod-spec mount. An operator can still
    // override (e.g., for the subprocess sandbox where the workspace lives
    // on the host filesystem), but the default matches the canonical k8s
    // sandbox shape so misconfigured deploys land in a working spot.
    const env = { ...PROXY_TCP };
    delete (env as Record<string, string | undefined>).AX_WORKSPACE_ROOT;
    expect(readRunnerEnv(env).workspaceRoot).toBe('/permanent');
  });

  it('defaults workspaceRoot to /permanent when AX_WORKSPACE_ROOT is empty string', () => {
    // Empty-string env is semantically the same as missing — see the
    // `opt()` helper in env.ts. Confirms the fallback path covers it.
    const env = { ...PROXY_TCP, AX_WORKSPACE_ROOT: '' };
    expect(readRunnerEnv(env).workspaceRoot).toBe('/permanent');
  });

  it('still honors AX_WORKSPACE_ROOT when explicitly set', () => {
    expect(
      readRunnerEnv({ ...PROXY_TCP, AX_WORKSPACE_ROOT: '/tmp/custom-ws' })
        .workspaceRoot,
    ).toBe('/tmp/custom-ws');
  });

  it('throws when neither AX_PROXY_ENDPOINT nor AX_PROXY_UNIX_SOCKET is set', () => {
    const env = { ...PROXY_TCP };
    delete (env as Record<string, string | undefined>).AX_PROXY_ENDPOINT;
    expect(() => readRunnerEnv(env)).toThrow(MissingEnvError);
    try {
      readRunnerEnv(env);
    } catch (err) {
      // The message names both transport vars so a misconfigured runner
      // gets actionable diagnostics rather than guessing which to set.
      expect((err as MissingEnvError).message).toContain('AX_PROXY_ENDPOINT');
      expect((err as MissingEnvError).message).toContain('AX_PROXY_UNIX_SOCKET');
    }
  });
});
