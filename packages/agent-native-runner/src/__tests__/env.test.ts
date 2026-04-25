import { describe, expect, it } from 'vitest';
import { MissingEnvError, readRunnerEnv } from '../env.js';

describe('readRunnerEnv', () => {
  it('returns the parsed shape when all four env vars are present', () => {
    const out = readRunnerEnv({
      AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
      AX_SESSION_ID: 'sess-1',
      AX_AUTH_TOKEN: 'tok-123',
      AX_WORKSPACE_ROOT: '/tmp/workspace',
    });
    expect(out).toEqual({
      runnerEndpoint: 'unix:///tmp/ax.sock',
      sessionId: 'sess-1',
      authToken: 'tok-123',
      workspaceRoot: '/tmp/workspace',
    });
  });

  it('throws MissingEnvError naming AX_RUNNER_ENDPOINT when unset', () => {
    const call = (): unknown =>
      readRunnerEnv({
        AX_SESSION_ID: 'sess-1',
        AX_AUTH_TOKEN: 'tok-123',
        AX_WORKSPACE_ROOT: '/tmp/workspace',
      });
    expect(call).toThrow(MissingEnvError);
    try {
      call();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as MissingEnvError).varName).toBe('AX_RUNNER_ENDPOINT');
      expect((err as MissingEnvError).message).toContain('AX_RUNNER_ENDPOINT');
    }
  });

  it('throws MissingEnvError naming AX_SESSION_ID when unset', () => {
    const call = (): unknown =>
      readRunnerEnv({
        AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
        AX_AUTH_TOKEN: 'tok-123',
        AX_WORKSPACE_ROOT: '/tmp/workspace',
      });
    expect(call).toThrow(MissingEnvError);
    try {
      call();
    } catch (err) {
      expect((err as MissingEnvError).varName).toBe('AX_SESSION_ID');
    }
  });

  it('treats an empty-string value as missing', () => {
    const call = (): unknown =>
      readRunnerEnv({
        AX_RUNNER_ENDPOINT: 'unix:///tmp/ax.sock',
        AX_SESSION_ID: 'sess-1',
        AX_AUTH_TOKEN: '',
        AX_WORKSPACE_ROOT: '/tmp/workspace',
      });
    expect(call).toThrow(MissingEnvError);
    try {
      call();
    } catch (err) {
      expect((err as MissingEnvError).varName).toBe('AX_AUTH_TOKEN');
    }
  });
});
