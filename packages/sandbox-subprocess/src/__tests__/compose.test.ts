import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import type { ServiceDescriptorParsed } from '@ax/sandbox-protocol';
import {
  composeProjectName,
  descriptorsToComposeProject,
  tcpHealthPorts,
  composeAvailable,
  composeUp,
  composeDown,
  composeLogs,
  diagnoseComposeFailure,
  waitForTcpPorts,
  LOOPBACK_HOST,
  type ComposeRunner,
  type ComposeRunResult,
} from '../compose.js';

// ---------------------------------------------------------------------------
// Descriptor → docker compose translation + injectable runner (TASK-152).
// All daemon-free: the translation is pure; the runner layer is exercised with
// a fake ComposeRunner that records argv + stdin. No real `docker` is spawned.
// ---------------------------------------------------------------------------

const DIGEST = 'sha256:' + 'a'.repeat(64);

function svc(over: Partial<ServiceDescriptorParsed> = {}): ServiceDescriptorParsed {
  return {
    name: 'db',
    image: `postgres@${DIGEST}`,
    ports: [5432],
    env: {},
    writablePaths: [],
    ...over,
  } as ServiceDescriptorParsed;
}

/** A fake runner that records every invocation and returns a scripted result. */
function fakeRunner(
  result: ComposeRunResult = { code: 0, stdout: '', stderr: '' },
): { run: ComposeRunner; calls: Array<{ args: string[]; stdin?: string }> } {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run: ComposeRunner = async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin });
    return result;
  };
  return { run, calls };
}

describe('composeProjectName', () => {
  it('prefixes ax-svc- and sanitizes to compose charset', () => {
    expect(composeProjectName('Conv_123')).toBe('ax-svc-conv_123');
    expect(composeProjectName('a/b:c d')).toBe('ax-svc-a-b-c-d');
  });
  it('falls back when the sessionId is all symbols', () => {
    expect(composeProjectName('!!!')).toBe('ax-svc-session');
    expect(composeProjectName('')).toBe('ax-svc-session');
  });
  it('strips leading dashes and bounds length', () => {
    expect(composeProjectName('---x')).toBe('ax-svc-x');
    const long = composeProjectName('z'.repeat(200));
    expect(long.length).toBeLessThanOrEqual('ax-svc-'.length + 48);
  });
});

describe('descriptorsToComposeProject — translation', () => {
  it('maps image, env, ports, and exec healthcheck', () => {
    const project = descriptorsToComposeProject([
      svc({
        name: 'cache',
        image: `redis@${DIGEST}`,
        ports: [6379],
        env: { FOO: 'bar', BAZ: 'qux' },
        healthcheck: { kind: 'exec', command: ['redis-cli', 'ping'] },
      }),
    ]);
    const entry = project.services.cache;
    expect(entry.image).toBe(`redis@${DIGEST}`);
    expect(entry.environment).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(entry.ports).toEqual(['127.0.0.1:6379:6379']);
    expect(entry.restart).toBe('no');
    expect(entry.healthcheck?.test).toEqual(['CMD', 'redis-cli', 'ping']);
  });

  it('publishes EVERY port on loopback only (I4)', () => {
    const project = descriptorsToComposeProject([svc({ ports: [5432, 9000, 27017] })]);
    for (const mapping of project.services.db.ports ?? []) {
      expect(mapping.startsWith(`${LOOPBACK_HOST}:`)).toBe(true);
      // host bind is 127.0.0.1 — NOT 0.0.0.0 / a bare port (which binds all ifaces)
      expect(mapping).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
    }
  });

  it('maps writablePaths to tmpfs, NEVER a host bind mount (I10)', () => {
    const project = descriptorsToComposeProject([
      svc({ writablePaths: ['/var/lib/postgresql/data', '/tmp/scratch'] }),
    ]);
    const entry = project.services.db;
    expect(entry.tmpfs).toEqual(['/var/lib/postgresql/data', '/tmp/scratch']);
    // No `volumes` key at all — tmpfs is the only writable surface.
    expect((entry as Record<string, unknown>).volumes).toBeUndefined();
  });

  it('emits NO privileged / host-networking / host-pid-ipc anywhere (I10)', () => {
    const project = descriptorsToComposeProject([
      svc({
        env: { X: '1' },
        ports: [5432],
        writablePaths: ['/data'],
        healthcheck: { kind: 'exec', command: ['true'] },
      }),
    ]);
    const json = JSON.stringify(project);
    expect(json).not.toContain('privileged');
    expect(json).not.toContain('network_mode');
    expect(json).not.toContain('"host"');
    expect(json).not.toContain('pid');
    expect(json).not.toContain('ipc');
    // And no host bind mount syntax anywhere.
    expect(json).not.toContain('volumes');
  });

  it('does NOT emit a compose healthcheck for a tcp descriptor (host-side gated)', () => {
    const project = descriptorsToComposeProject([
      svc({ healthcheck: { kind: 'tcp', port: 5432 } }),
    ]);
    expect(project.services.db.healthcheck).toBeUndefined();
  });

  it('omits empty env / ports / tmpfs cleanly', () => {
    const project = descriptorsToComposeProject([
      svc({ ports: [], env: {}, writablePaths: [] }),
    ]);
    const entry = project.services.db;
    expect(entry.environment).toBeUndefined();
    expect(entry.ports).toBeUndefined();
    expect(entry.tmpfs).toBeUndefined();
  });

  it('returns an empty services map for no descriptors', () => {
    expect(descriptorsToComposeProject([])).toEqual({ services: {} });
  });

  it('rejects a non-digest-pinned image (I8 defense in depth)', () => {
    expect(() => descriptorsToComposeProject([svc({ image: 'postgres:16' })])).toThrow(
      /digest-pinned/,
    );
  });

  it('rejects an invalid service name (defense in depth)', () => {
    expect(() => descriptorsToComposeProject([svc({ name: 'Bad_Name' })])).toThrow(
      /invalid service name/,
    );
  });
});

describe('tcpHealthPorts', () => {
  it('collects only tcp-healthcheck ports', () => {
    expect(
      tcpHealthPorts([
        svc({ name: 'a', healthcheck: { kind: 'tcp', port: 5432 } }),
        svc({ name: 'b', healthcheck: { kind: 'exec', command: ['true'] } }),
        svc({ name: 'c' }),
      ]),
    ).toEqual([5432]);
  });
});

describe('composeAvailable', () => {
  it('true on exit 0', async () => {
    const { run, calls } = fakeRunner({ code: 0, stdout: 'Docker Compose v2', stderr: '' });
    expect(await composeAvailable(run)).toBe(true);
    expect(calls[0].args).toEqual(['compose', 'version']);
  });
  it('false on non-zero exit', async () => {
    const { run } = fakeRunner({ code: 1, stdout: '', stderr: 'not found' });
    expect(await composeAvailable(run)).toBe(false);
  });
  it('false on spawn error (never throws)', async () => {
    const run: ComposeRunner = async () => {
      throw new Error('ENOENT docker');
    };
    expect(await composeAvailable(run)).toBe(false);
  });
});

describe('composeUp', () => {
  it('runs `up -d --wait` with the compose JSON on stdin', async () => {
    const { run, calls } = fakeRunner();
    await composeUp(run, { projectName: 'ax-svc-x', composeJson: '{"services":{}}' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'compose',
      '-p',
      'ax-svc-x',
      '-f',
      '-',
      'up',
      '-d',
      '--wait',
    ]);
    expect(calls[0].stdin).toBe('{"services":{}}');
  });
  it('throws with stderr on non-zero exit', async () => {
    const { run } = fakeRunner({ code: 1, stdout: '', stderr: 'image pull denied' });
    await expect(
      composeUp(run, { projectName: 'ax-svc-x', composeJson: '{}' }),
    ).rejects.toThrow(/image pull denied/);
  });
});

describe('composeDown', () => {
  it('runs `down -v` with the compose JSON on stdin', async () => {
    const { run, calls } = fakeRunner();
    await composeDown(run, { projectName: 'ax-svc-x', composeJson: '{"services":{}}' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['compose', '-p', 'ax-svc-x', '-f', '-', 'down', '-v']);
    expect(calls[0].stdin).toBe('{"services":{}}');
  });
});

describe('waitForTcpPorts', () => {
  it('no-ops for an empty port list', async () => {
    await expect(waitForTcpPorts([])).resolves.toBeUndefined();
  });

  it('resolves once a real loopback port is open', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    try {
      await expect(
        waitForTcpPorts([addr.port], { deadlineMs: 2_000, intervalMs: 25 }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('throws past the deadline when a port never opens', async () => {
    // Pick a port nothing is listening on. Short deadline keeps the test fast.
    await expect(
      waitForTcpPorts([1], { deadlineMs: 300, intervalMs: 50 }),
    ).rejects.toThrow(/not ready/);
  });
});

// A fake runner that routes by the compose verb in the argv (the verb sits
// after `-p <proj> -f -`). Lets a test script `up` vs `logs` separately.
function verbRoutingRunner(
  byVerb: Record<string, ComposeRunResult>,
): { run: ComposeRunner; calls: Array<{ args: string[]; stdin?: string }> } {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run: ComposeRunner = async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin });
    const verb = args.find((a) => ['up', 'down', 'logs', 'version'].includes(a)) ?? '';
    return byVerb[verb] ?? { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('composeLogs (TASK-160)', () => {
  it('fetches a bounded --no-color --tail log on stdin and returns stdout', async () => {
    const { run, calls } = verbRoutingRunner({
      logs: { code: 0, stdout: 'kafka  | crashed', stderr: '' },
    });
    const out = await composeLogs(run, { projectName: 'ax-svc-x', composeJson: '{}' });
    expect(out).toBe('kafka  | crashed');
    expect(calls[0].args).toEqual([
      'compose', '-p', 'ax-svc-x', '-f', '-', 'logs', '--no-color', '--tail', '20',
    ]);
    expect(calls[0].stdin).toBe('{}');
  });

  it('returns empty string (never throws) when the runner errors', async () => {
    const run: ComposeRunner = async () => {
      throw new Error('docker daemon gone');
    };
    await expect(
      composeLogs(run, { projectName: 'p', composeJson: '{}' }),
    ).resolves.toBe('');
  });
});

describe('diagnoseComposeFailure (TASK-160)', () => {
  it('names the service + offending path from the compose-logs tail (EROFS)', async () => {
    const { run } = verbRoutingRunner({
      logs: {
        code: 0,
        stdout:
          'postgres  | initdb: error: could not create directory "/var/lib/postgresql/data": Read-only file system',
        stderr: '',
      },
    });
    const diagnosis = await diagnoseComposeFailure(run, {
      projectName: 'ax-svc-x',
      composeJson: '{}',
      services: [svc({ name: 'postgres', ports: [5432] })],
      upError: new Error('docker compose up failed (exit 1): service exited'),
    });
    expect(diagnosis).toEqual({
      service: 'postgres',
      path: '/var/lib/postgresql/data',
      reason: 'read-only filesystem',
    });
  });

  it('falls back to scanning the up-error message when logs are empty', async () => {
    const { run } = verbRoutingRunner({
      logs: { code: 0, stdout: '', stderr: '' },
    });
    const diagnosis = await diagnoseComposeFailure(run, {
      projectName: 'ax-svc-x',
      composeJson: '{}',
      services: [svc({ name: 'mongo' })],
      upError: new Error(
        'docker compose up failed (exit 1): chown /data/db: permission denied',
      ),
    });
    expect(diagnosis).toEqual({
      service: 'mongo',
      path: '/data/db',
      reason: 'permission denied',
    });
  });

  it('returns undefined for a generic failure with no recognizable shape', async () => {
    const { run } = verbRoutingRunner({
      logs: { code: 0, stdout: 'mongo  | shutting down with code 14', stderr: '' },
    });
    const diagnosis = await diagnoseComposeFailure(run, {
      projectName: 'ax-svc-x',
      composeJson: '{}',
      services: [svc({ name: 'mongo' })],
      upError: new Error('docker compose up failed (exit 1)'),
    });
    expect(diagnosis).toBeUndefined();
  });

  it('returns undefined when no services were declared', async () => {
    const { run, calls } = verbRoutingRunner({});
    const diagnosis = await diagnoseComposeFailure(run, {
      projectName: 'ax-svc-x',
      composeJson: '{}',
      services: [],
      upError: new Error('boom'),
    });
    expect(diagnosis).toBeUndefined();
    // No docker call — nothing to diagnose.
    expect(calls).toHaveLength(0);
  });

  it('attributes to the first declared service when the log line names none', async () => {
    const { run } = verbRoutingRunner({
      logs: {
        code: 0,
        stdout: 'mkdir /opt/data: Read-only file system',
        stderr: '',
      },
    });
    const diagnosis = await diagnoseComposeFailure(run, {
      projectName: 'ax-svc-x',
      composeJson: '{}',
      services: [svc({ name: 'kafka' }), svc({ name: 'zookeeper' })],
      upError: new Error('up failed'),
    });
    expect(diagnosis).toEqual({
      service: 'kafka',
      path: '/opt/data',
      reason: 'read-only filesystem',
    });
  });
});
