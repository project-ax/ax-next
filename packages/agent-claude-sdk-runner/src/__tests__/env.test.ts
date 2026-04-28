import { describe, expect, it } from 'vitest';
import { MissingEnvError, readRunnerEnv } from '../env.js';

// Canonical legacy-mode fixture (AX_LLM_PROXY_URL set, no AX_PROXY_*).
// Phase 5/6 deletes the legacy path; until then it's the default.
const LEGACY = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_LLM_PROXY_URL: 'http://127.0.0.1:4000',
};

// Canonical Phase 2 direct-mode fixture (AX_PROXY_ENDPOINT, no
// AX_LLM_PROXY_URL).
const PROXY_TCP = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_PROXY_ENDPOINT: 'http://127.0.0.1:54321',
};

// Canonical Phase 2 bridge-mode fixture (AX_PROXY_UNIX_SOCKET, no
// AX_LLM_PROXY_URL).
const PROXY_UNIX = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_PROXY_UNIX_SOCKET: '/var/run/ax/proxy.sock',
};

describe('readRunnerEnv', () => {
  it('returns the parsed shape on the legacy AX_LLM_PROXY_URL path', () => {
    expect(readRunnerEnv(LEGACY)).toEqual({
      runnerEndpoint: 'unix:///tmp/ax.sock',
      sessionId: 'sess-1',
      authToken: 'tok-123',
      workspaceRoot: '/tmp/workspace',
      llmProxyUrl: 'http://127.0.0.1:4000',
    });
  });

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

  it('throws when AX_LLM_PROXY_URL is set together with AX_PROXY_ENDPOINT (legacy XOR new)', () => {
    // The Phase 2 contract is mutually exclusive: sandbox-subprocess sets
    // AX_LLM_PROXY_URL on the legacy path and skips it on the new path.
    // A deploy with BOTH set is ambiguous (setupProxy would silently pick
    // the new path and ignore the legacy URL); fail loud at boot.
    const env = { ...PROXY_TCP, AX_LLM_PROXY_URL: 'http://127.0.0.1:4000' };
    expect(() => readRunnerEnv(env)).toThrow(MissingEnvError);
    try {
      readRunnerEnv(env);
    } catch (err) {
      expect((err as MissingEnvError).message).toContain('mutually exclusive');
    }
  });

  it('throws when AX_LLM_PROXY_URL is set together with AX_PROXY_UNIX_SOCKET (legacy XOR new)', () => {
    const env = { ...PROXY_UNIX, AX_LLM_PROXY_URL: 'http://127.0.0.1:4000' };
    expect(() => readRunnerEnv(env)).toThrow(MissingEnvError);
  });

  for (const name of [
    'AX_RUNNER_ENDPOINT',
    'AX_SESSION_ID',
    'AX_AUTH_TOKEN',
    'AX_WORKSPACE_ROOT',
  ] as const) {
    it(`throws MissingEnvError naming ${name} when unset`, () => {
      const env = { ...LEGACY };
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
      const env = { ...LEGACY, [name]: '' };
      const call = (): unknown => readRunnerEnv(env);
      expect(call).toThrow(MissingEnvError);
      try {
        call();
      } catch (err) {
        expect((err as MissingEnvError).varName).toBe(name);
      }
    });
  }

  it('throws when none of AX_LLM_PROXY_URL / AX_PROXY_ENDPOINT / AX_PROXY_UNIX_SOCKET is set', () => {
    const env = { ...LEGACY };
    delete (env as Record<string, string | undefined>).AX_LLM_PROXY_URL;
    expect(() => readRunnerEnv(env)).toThrow(MissingEnvError);
    try {
      readRunnerEnv(env);
    } catch (err) {
      // The message names all three so a misconfigured runner gets actionable
      // diagnostics rather than guessing which env var to set.
      expect((err as MissingEnvError).message).toContain('AX_LLM_PROXY_URL');
      expect((err as MissingEnvError).message).toContain('AX_PROXY_ENDPOINT');
      expect((err as MissingEnvError).message).toContain('AX_PROXY_UNIX_SOCKET');
    }
  });

  it('treats empty AX_LLM_PROXY_URL as unset for the XOR check', () => {
    // An empty string for the legacy var must not satisfy the XOR; otherwise
    // a deploy that accidentally clears the var (without setting AX_PROXY_*)
    // would silently pass the gate and fail later inside setupProxy().
    const env = { ...LEGACY, AX_LLM_PROXY_URL: '' };
    expect(() => readRunnerEnv(env)).toThrow(MissingEnvError);
  });
});
