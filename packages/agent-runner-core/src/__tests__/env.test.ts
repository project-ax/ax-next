import { describe, expect, it } from 'vitest';
import { InvalidEnvError, MissingEnvError, readRunnerEnv } from '../env.js';

// A well-formed per-session proxy token (what credential-proxy mints:
// 16 random bytes, lowercase hex).
const TOKEN = '0123456789abcdef0123456789abcdef';

// Canonical Phase 2 direct-mode fixture (AX_PROXY_ENDPOINT only).
const PROXY_TCP = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_PROXY_ENDPOINT: 'http://127.0.0.1:54321',
  AX_PROXY_TOKEN: TOKEN,
};

// Canonical Phase 2 bridge-mode fixture (AX_PROXY_UNIX_SOCKET only).
const PROXY_UNIX = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_PROXY_UNIX_SOCKET: '/var/run/ax/proxy.sock',
  AX_PROXY_TOKEN: TOKEN,
};

describe('readRunnerEnv', () => {
  it('reads proxyEndpoint when only AX_PROXY_ENDPOINT is set', () => {
    expect(readRunnerEnv(PROXY_TCP)).toEqual({
      runnerEndpoint: 'unix:///tmp/ax.sock',
      sessionId: 'sess-1',
      authToken: 'tok-123',
      workspaceRoot: '/tmp/workspace',
      proxyEndpoint: 'http://127.0.0.1:54321',
      proxyToken: TOKEN,
    });
  });

  it('reads ephemeralRoot when AX_EPHEMERAL_ROOT is set, omits it otherwise', () => {
    // Present → carried through verbatim.
    expect(
      readRunnerEnv({ ...PROXY_TCP, AX_EPHEMERAL_ROOT: '/ephemeral' })
        .ephemeralRoot,
    ).toBe('/ephemeral');
    // Absent → the field is omitted entirely (no `/ephemeral` default).
    // A default would be actively harmful in the subprocess sandbox, where
    // the host root is read-only; "absent" cleanly means "no scratch tier".
    expect('ephemeralRoot' in readRunnerEnv(PROXY_TCP)).toBe(false);
    // Empty string is treated as unset (consistent with opt()).
    expect(
      'ephemeralRoot' in readRunnerEnv({ ...PROXY_TCP, AX_EPHEMERAL_ROOT: '' }),
    ).toBe(false);
  });

  it('reads userFilesRoot when AX_USERFILES_ROOT is set, omits it otherwise', () => {
    // Present → carried through verbatim (the durable per-agent user-files mount).
    expect(
      readRunnerEnv({ ...PROXY_TCP, AX_USERFILES_ROOT: '/files' }).userFilesRoot,
    ).toBe('/files');
    // Absent → omitted entirely (no default; "no durable mount wired").
    expect('userFilesRoot' in readRunnerEnv(PROXY_TCP)).toBe(false);
    // Empty string is treated as unset (consistent with opt()).
    expect(
      'userFilesRoot' in readRunnerEnv({ ...PROXY_TCP, AX_USERFILES_ROOT: '' }),
    ).toBe(false);
  });

  it('reads memoryRoot when AX_MEMORY_ROOT is set, omits it otherwise', () => {
    expect(
      readRunnerEnv({ ...PROXY_TCP, AX_MEMORY_ROOT: '/memory' }).memoryRoot,
    ).toBe('/memory');
    expect('memoryRoot' in readRunnerEnv(PROXY_TCP)).toBe(false);
    expect(
      'memoryRoot' in readRunnerEnv({ ...PROXY_TCP, AX_MEMORY_ROOT: '' }),
    ).toBe(false);
  });

  it('reads proxyUnixSocket when only AX_PROXY_UNIX_SOCKET is set', () => {
    expect(readRunnerEnv(PROXY_UNIX)).toEqual({
      runnerEndpoint: 'unix:///tmp/ax.sock',
      sessionId: 'sess-1',
      authToken: 'tok-123',
      workspaceRoot: '/tmp/workspace',
      proxyUnixSocket: '/var/run/ax/proxy.sock',
      proxyToken: TOKEN,
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
      AX_PROXY_TOKEN: TOKEN,
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

  // Phase 3: AX_WORKSPACE_ROOT became optional (defaults to /agent —
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

  it('defaults workspaceRoot to /agent when AX_WORKSPACE_ROOT is unset', () => {
    // Lines up with the sandbox-k8s pod-spec mount. An operator can still
    // override (e.g., for the subprocess sandbox where the workspace lives
    // on the host filesystem), but the default matches the canonical k8s
    // sandbox shape so misconfigured deploys land in a working spot.
    const env = { ...PROXY_TCP };
    delete (env as Record<string, string | undefined>).AX_WORKSPACE_ROOT;
    expect(readRunnerEnv(env).workspaceRoot).toBe('/agent');
  });

  it('defaults workspaceRoot to /agent when AX_WORKSPACE_ROOT is empty string', () => {
    // Empty-string env is semantically the same as missing — see the
    // `opt()` helper in env.ts. Confirms the fallback path covers it.
    const env = { ...PROXY_TCP, AX_WORKSPACE_ROOT: '' };
    expect(readRunnerEnv(env).workspaceRoot).toBe('/agent');
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

// TASK-704: since TASK-158 the proxy refuses (407) every request that does not
// carry this session's token, and a proxy is always configured (see the
// AX_PROXY_ENDPOINT / AX_PROXY_UNIX_SOCKET check above). A runner that boots
// without a usable token can therefore reach nothing, and every failure would
// look like a network outage. readRunnerEnv must refuse to boot instead --
// and must never echo the token (it is a bearer credential) in the error.
describe('readRunnerEnv -- AX_PROXY_TOKEN (TASK-704)', () => {
  for (const [label, base] of [
    ['direct mode (AX_PROXY_ENDPOINT)', PROXY_TCP],
    ['bridge mode (AX_PROXY_UNIX_SOCKET)', PROXY_UNIX],
  ] as const) {
    it(`${label}: carries a well-formed token through`, () => {
      expect(readRunnerEnv(base).proxyToken).toBe(TOKEN);
    });

    it(`${label}: throws MissingEnvError naming AX_PROXY_TOKEN when unset`, () => {
      const env: Record<string, string | undefined> = { ...base };
      delete env.AX_PROXY_TOKEN;
      let caught: unknown;
      try {
        readRunnerEnv(env);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MissingEnvError);
      expect((caught as MissingEnvError).varName).toBe('AX_PROXY_TOKEN');
      expect((caught as Error).message).toContain('AX_PROXY_TOKEN');
    });

    it(`${label}: throws MissingEnvError naming AX_PROXY_TOKEN when empty`, () => {
      let caught: unknown;
      try {
        readRunnerEnv({ ...base, AX_PROXY_TOKEN: '' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MissingEnvError);
      expect((caught as MissingEnvError).varName).toBe('AX_PROXY_TOKEN');
    });

    it(`${label}: rejects a malformed token`, () => {
      expect(() =>
        readRunnerEnv({ ...base, AX_PROXY_TOKEN: TOKEN.toUpperCase() }),
      ).toThrow(InvalidEnvError);
    });
  }

  // Each of these is one plausible way a token gets garbled in transit
  // (truncation, padding, a trailing newline from a secret file, an
  // upper-cased copy, a quoted value, a userinfo string pasted in).
  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    ['31 chars (truncated)', TOKEN.slice(0, 31)],
    ['33 chars (padded)', `${TOKEN}0`],
    ['upper-case hex', TOKEN.toUpperCase()],
    ['non-hex character', `${TOKEN.slice(0, 31)}g`],
    ['trailing newline', `${TOKEN}\n`],
    ['leading space', ` ${TOKEN.slice(1)}`],
    ['quoted', `"${TOKEN.slice(2)}"`],
    ['embedded in userinfo', `ax:${TOKEN}`],
  ];
  for (const [label, bad] of MALFORMED) {
    it(`throws InvalidEnvError for a malformed token (${label}) without echoing it`, () => {
      let caught: unknown;
      try {
        readRunnerEnv({ ...PROXY_TCP, AX_PROXY_TOKEN: bad });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvalidEnvError);
      expect((caught as InvalidEnvError).varName).toBe('AX_PROXY_TOKEN');
      const message = (caught as Error).message;
      expect(message).toContain('AX_PROXY_TOKEN');
      // Never leak the value or a recognizable chunk of it. Every malformed
      // variant above shares the 16-char run TOKEN[2..18] (case aside).
      expect(message).not.toContain(bad.trim());
      expect(message.toLowerCase()).not.toContain(TOKEN.slice(2, 18));
      expect(JSON.stringify(caught).toLowerCase()).not.toContain(TOKEN.slice(2, 18));
    });
  }
});
