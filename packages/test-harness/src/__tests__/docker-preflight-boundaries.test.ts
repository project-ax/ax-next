import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), exists: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
vi.mock('node:fs', () => ({ existsSync: mocks.exists }));

interface ProbeOptions {
  signal: AbortSignal;
  killSignal: string;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

beforeEach(() => {
  vi.resetModules();
  mocks.exists.mockReset().mockReturnValue(false);
  mocks.exec.mockReset().mockImplementation(async (_file: string, args: string[]) => ({
    stdout: args.includes('version') ? '26.1.0' : '0 0',
  }));
  vi.stubEnv('DOCKER_HOST', 'unix:///test/docker.sock');
  vi.stubEnv('DOCKER_CONTEXT', 'different-daemon');
  vi.stubEnv('DOCKER_TLS', undefined);
  vi.stubEnv('DOCKER_TLS_VERIFY', undefined);
  vi.stubEnv('DOCKER_CERT_PATH', undefined);
  vi.stubEnv('AX_TESTCONTAINERS_STRICT_ENDPOINT', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('explicit Docker endpoint contract', () => {
  it('pins both probes to DOCKER_HOST instead of a conflicting CLI context', async () => {
    const { startTestContainer } = await import('../docker-preflight.js');
    const result = {};
    const start = vi.fn(async () => {
      expect(process.env.AX_TESTCONTAINERS_STRICT_ENDPOINT).toBe('true');
      return result;
    });
    await expect(startTestContainer({ start })).resolves.toBe(result);
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    for (const [command, args, options] of mocks.exec.mock.calls as [string, string[], ProbeOptions][]) {
      expect(command).toBe('docker');
      expect(args[0]).toBe('--host=unix:///test/docker.sock');
      expect(options.env.DOCKER_HOST).toBe('unix:///test/docker.sock');
      expect(options.env.DOCKER_CONTEXT).toBeUndefined();
      expect(options.env.DOCKER_TLS).toBeUndefined();
      expect(options.env.DOCKER_TLS_VERIFY).toBeUndefined();
    }
    expect(process.env.DOCKER_CONTEXT).toBe('different-daemon');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('passes the same verified TCP TLS settings used by Testcontainers', async () => {
    vi.stubEnv('DOCKER_HOST', 'tcp://docker.example:2376');
    vi.stubEnv('DOCKER_TLS_VERIFY', '1');
    vi.stubEnv('DOCKER_CERT_PATH', process.cwd());
    const { preflightDocker } = await import('../docker-preflight.js');
    await preflightDocker();
    for (const [, args, options] of mocks.exec.mock.calls as [string, string[], ProbeOptions][]) {
      expect(args[0]).toBe('--host=tcp://docker.example:2376');
      expect(options.env.DOCKER_TLS_VERIFY).toBe('1');
      expect(options.env.DOCKER_CERT_PATH).toBe(process.cwd());
      expect(options.env.DOCKER_CONTEXT).toBeUndefined();
    }
  });

  it('rejects per-home override files without probing or reading their contents', async () => {
    mocks.exists.mockReturnValue(true);
    const { startTestContainer } = await import('../docker-preflight.js');
    const start = vi.fn(async () => ({}));
    await expect(startTestContainer({ start })).rejects.toThrow(/Docker test configuration:.*testcontainers.properties/);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['missing host', 'DOCKER_HOST', undefined],
    ['blank host', 'DOCKER_HOST', ' '],
    ['implicit port', 'DOCKER_HOST', 'tcp://docker.example'],
    ['URI credentials', 'DOCKER_HOST', 'tcp://user:password@docker.example:2376'],
    ['encoded socket', 'DOCKER_HOST', 'unix:///test/docker%20socket'],
    ['unsupported transport', 'DOCKER_HOST', 'ssh://docker.example'],
    ['CLI-only TLS', 'DOCKER_TLS', '1'],
    ['ambiguous TLS flag', 'DOCKER_TLS_VERIFY', '0'],
  ] as const)('rejects %s as configuration, not daemon failure', async (_name, key, value) => {
    vi.stubEnv(key, value);
    const { startTestContainer } = await import('../docker-preflight.js');
    const start = vi.fn(async () => ({}));
    await expect(startTestContainer({ start })).rejects.toThrow(/^Docker test configuration:/);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([undefined, 'relative/certificates'])('rejects missing or relative verified-TLS paths (%s)', async (certPath) => {
    vi.stubEnv('DOCKER_HOST', 'tcp://docker.example:2376');
    vi.stubEnv('DOCKER_TLS_VERIFY', '1');
    vi.stubEnv('DOCKER_CERT_PATH', certPath);
    const { preflightDocker } = await import('../docker-preflight.js');
    await expect(preflightDocker()).rejects.toThrow(/Docker test configuration:.*absolute DOCKER_CERT_PATH/);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('rejects TLS flags on a local socket rather than using inconsistent transport semantics', async () => {
    vi.stubEnv('DOCKER_TLS_VERIFY', '1');
    vi.stubEnv('DOCKER_CERT_PATH', process.cwd());
    const { preflightDocker } = await import('../docker-preflight.js');
    await expect(preflightDocker()).rejects.toThrow(/Docker test configuration:.*tcp DOCKER_HOST/);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('does not allow configuration to change after a checked start', async () => {
    const { startTestContainer } = await import('../docker-preflight.js');
    await startTestContainer({ start: async () => ({}) });
    mocks.exec.mockClear();
    vi.stubEnv('DOCKER_HOST', 'unix:///other/docker.sock');
    const start = vi.fn(async () => ({}));
    await expect(startTestContainer({ start })).rejects.toThrow(/configuration changed after a checked start/);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects a configuration change during an in-flight preflight', async () => {
    mocks.exec.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes('info')) vi.stubEnv('DOCKER_HOST', 'unix:///other/docker.sock');
      return { stdout: args.includes('version') ? '26.1.0' : '0 0' };
    });
    const { startTestContainer } = await import('../docker-preflight.js');
    const start = vi.fn(async () => ({}));
    await expect(startTestContainer({ start })).rejects.toThrow(/configuration changed during the preflight/);
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects implicit TLS on port 2376', async () => {
    vi.stubEnv('DOCKER_HOST', 'tcp://docker.example:2376');
    const { startTestContainer } = await import('../docker-preflight.js');
    const start = vi.fn(async () => ({}));
    await expect(startTestContainer({ start })).rejects.toThrow(/port 2376 requires DOCKER_TLS_VERIFY=1/);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects certificate settings without verified TLS before the SDK can read them', async () => {
    vi.stubEnv('DOCKER_HOST', 'tcp://docker.example:2375');
    vi.stubEnv('DOCKER_CERT_PATH', process.cwd());
    const { startTestContainer } = await import('../docker-preflight.js');
    const start = vi.fn(async () => ({}));
    await expect(startTestContainer({ start })).rejects.toThrow(/DOCKER_CERT_PATH requires DOCKER_TLS_VERIFY=1/);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe('probe resource boundaries', () => {
  it('uses one deadline across delayed version and info responses', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mocks.exec.mockImplementation((_file: string, args: string[], options: ProbeOptions) => new Promise((resolve, reject) => {
      signals.push(options.signal);
      const timer = setTimeout(() => resolve({ stdout: args.includes('version') ? '26.1.0' : '0 0' }), 600);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted fixture'));
      }, { once: true });
    }));
    const { startTestContainer } = await import('../docker-preflight.js');
    const start = vi.fn(async () => ({}));
    const outcome = startTestContainer({ start }, { timeoutMs: 1000 }).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1200);
    expect(String(await outcome)).toMatch(/Docker daemon.*within 1000 ms/);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('sets forced child termination and per-stream output caps on both commands', async () => {
    const { preflightDocker } = await import('../docker-preflight.js');
    await preflightDocker();
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    for (const [, , options] of mocks.exec.mock.calls as [string, string[], ProbeOptions][]) {
      expect(options.killSignal).toBe('SIGKILL');
      expect(options.maxBuffer).toBe(8192);
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('returns only authored diagnostics, not attached command data or causes', async () => {
    const original = Object.assign(new Error('PRIVATE_DIAGNOSTIC'), { stdout: 'PRIVATE_DIAGNOSTIC', stderr: 'PRIVATE_DIAGNOSTIC' });
    mocks.exec.mockRejectedValue(original);
    const { preflightDocker } = await import('../docker-preflight.js');
    const error = await preflightDocker().then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
    expect(String(error)).not.toContain('PRIVATE_DIAGNOSTIC');
  });
});
