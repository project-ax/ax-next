import { describe, expect, it } from 'vitest';
import { MissingEnvError, readRunnerEnv } from '../env.js';

// Canonical "all five vars present" fixture — tests that need one var
// missing spread this and then delete/override the target var.
const COMPLETE = {
  AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
  AX_SESSION_ID: 'sess-1',
  AX_AUTH_TOKEN: 'tok-123',
  AX_WORKSPACE_ROOT: '/tmp/workspace',
  AX_LLM_PROXY_URL: 'http://127.0.0.1:4000',
};

describe('readRunnerEnv', () => {
  it('returns the parsed shape when all five env vars are present', () => {
    const out = readRunnerEnv(COMPLETE);
    expect(out).toEqual({
      runnerEndpoint: 'unix:///tmp/ax.sock',
      sessionId: 'sess-1',
      authToken: 'tok-123',
      workspaceRoot: '/tmp/workspace',
      llmProxyUrl: 'http://127.0.0.1:4000',
    });
  });

  for (const name of [
    'AX_RUNNER_ENDPOINT',
    'AX_SESSION_ID',
    'AX_AUTH_TOKEN',
    'AX_WORKSPACE_ROOT',
    'AX_LLM_PROXY_URL',
  ] as const) {
    it(`throws MissingEnvError naming ${name} when unset`, () => {
      const env = { ...COMPLETE };
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
      const env = { ...COMPLETE, [name]: '' };
      const call = (): unknown => readRunnerEnv(env);
      expect(call).toThrow(MissingEnvError);
      try {
        call();
      } catch (err) {
        expect((err as MissingEnvError).varName).toBe(name);
      }
    });
  }
});
