import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { openSessionImpl } from '../open-session.js';
import type { ComposeRunner, ComposeRunResult } from '../compose.js';

// ---------------------------------------------------------------------------
// TASK-152 — `services` bring-up / teardown / fail-loud, all driven through an
// INJECTABLE ComposeRunner so NO real Docker daemon is required. We call
// openSessionImpl(ctx, raw, bus, fakeRunner) directly (the plugin registration
// uses the real runner; the 4th param is the test seam).
//
// The harness provides STUB session/ipc services (instead of session-inmemory)
// so we can assert exactly which lifecycle hooks fire — in particular that the
// fail-loud path NEVER mints a session.
// ---------------------------------------------------------------------------

const EXIT_STUB = fileURLToPath(new URL('./fixtures/exit-stub.mjs', import.meta.url));
const ECHO_STUB = fileURLToPath(new URL('./fixtures/echo-stub.mjs', import.meta.url));

const DIGEST = 'sha256:' + 'b'.repeat(64);

async function mkWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ax-ws-'));
}

interface Spies {
  sessionCreate: ReturnType<typeof vi.fn>;
  sessionTerminate: ReturnType<typeof vi.fn>;
  ipcStart: ReturnType<typeof vi.fn>;
  ipcStop: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<{
  harness: Awaited<ReturnType<typeof createTestHarness>>;
  spies: Spies;
}> {
  const sessionCreate = vi.fn(async (_ctx: unknown, input: { sessionId: string }) => ({
    sessionId: input.sessionId,
    token: 'tok-' + input.sessionId,
  }));
  const sessionTerminate = vi.fn(async () => ({}));
  const ipcStart = vi.fn(async () => ({ running: true }));
  const ipcStop = vi.fn(async () => ({}));
  const harness = await createTestHarness({
    services: {
      'session:create': sessionCreate as never,
      'session:terminate': sessionTerminate as never,
      'ipc:start': ipcStart as never,
      'ipc:stop': ipcStop as never,
    },
    plugins: [],
  });
  return { harness, spies: { sessionCreate, sessionTerminate, ipcStart, ipcStop } };
}

/** The compose verb in an argv (`version` is at index 1; `up`/`down` follow the
 *  `-p <proj> -f -` flags, so scan for the known verb rather than a fixed index). */
function composeVerb(args: string[]): string | undefined {
  return args.find(
    (a) => a === 'version' || a === 'up' || a === 'down' || a === 'logs',
  );
}

/** A fake runner that records invocations and returns scripted results keyed by
 *  the compose subcommand (version / up / down). */
function fakeRunner(opts?: {
  available?: boolean;
  upResult?: ComposeRunResult;
  /** TASK-160 — scripted `docker compose logs` output for the diagnosis path. */
  logsResult?: ComposeRunResult;
}): { run: ComposeRunner; calls: Array<{ args: string[]; stdin?: string }> } {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const run: ComposeRunner = async (args, runOpts) => {
    calls.push({ args, stdin: runOpts?.stdin });
    const verb = composeVerb(args);
    if (verb === 'version') {
      return { code: opts?.available === false ? 1 : 0, stdout: '', stderr: '' };
    }
    if (verb === 'up') {
      return opts?.upResult ?? { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'logs') {
      return opts?.logsResult ?? { code: 0, stdout: '', stderr: '' };
    }
    // down (or anything else)
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function pgService(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'db',
    image: `postgres@${DIGEST}`,
    // No tcp healthcheck by default → no host-side port wait (keeps the test
    // daemon-free; the bring-up "wait" is purely compose `--wait`, which our
    // fake runner reports as exit 0).
    ports: [5432],
    env: { POSTGRES_PASSWORD: 'x' },
    writablePaths: ['/var/lib/postgresql/data'],
    ...over,
  };
}

describe('sandbox:open-session — services bring-up (TASK-152)', () => {
  it('fail-loud: services requested + Docker unavailable → PluginError, session NOT minted', async () => {
    const ws = await mkWorkspace();
    const { harness, spies } = await makeHarness();
    const ctx = harness.ctx();
    const { run, calls } = fakeRunner({ available: false });

    await expect(
      openSessionImpl(
        ctx,
        { sessionId: 'svc-fail-1', workspaceRoot: ws, runnerBinary: EXIT_STUB, services: [pgService()] },
        harness.bus,
        run,
      ),
    ).rejects.toThrow(PluginError);

    // Only the availability probe ran — no up, no down.
    expect(calls.map((c) => c.args[1])).toEqual(['version']);
    // The session was NEVER minted and no listener was started — the gate bails
    // BEFORE session:create / ipc:start / fs.mkdtemp, so nothing is half-open
    // and there's no per-session tempdir to leak (those all happen after).
    expect(spies.sessionCreate).not.toHaveBeenCalled();
    expect(spies.ipcStart).not.toHaveBeenCalled();

    await harness.close();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('fail-loud carries the services-unavailable code', async () => {
    const ws = await mkWorkspace();
    const { harness } = await makeHarness();
    const ctx = harness.ctx();
    const { run } = fakeRunner({ available: false });
    const err = await openSessionImpl(
      ctx,
      { sessionId: 'svc-fail-2', workspaceRoot: ws, runnerBinary: EXIT_STUB, services: [pgService()] },
      harness.bus,
      run,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('services-unavailable');
    await harness.close();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('brings services up (`up -d --wait`) with the compose JSON on stdin, then tears down on close', async () => {
    const ws = await mkWorkspace();
    const { harness } = await makeHarness();
    const ctx = harness.ctx();
    const { run, calls } = fakeRunner();

    const result = await openSessionImpl(
      ctx,
      { sessionId: 'svc-up-1', workspaceRoot: ws, runnerBinary: ECHO_STUB, services: [pgService()] },
      harness.bus,
      run,
    );

    // version + up happened during open.
    const subsAfterOpen = calls.map((c) => composeVerb(c.args));
    expect(subsAfterOpen).toContain('version');
    expect(subsAfterOpen).toContain('up');
    const upCall = calls.find((c) => composeVerb(c.args) === 'up');
    expect(upCall?.args).toEqual(['compose', '-p', 'ax-svc-svc-up-1', '-f', '-', 'up', '-d', '--wait']);
    // The compose JSON rode on stdin and published the port on loopback only.
    expect(upCall?.stdin).toContain('127.0.0.1:5432:5432');
    expect(upCall?.stdin).toContain('tmpfs');
    expect(upCall?.stdin).not.toContain('privileged');

    // Kill the runner → the close handler tears the compose project down.
    await result.handle.kill();
    await result.handle.exited;
    // Give the async 'close' cleanup a beat to run composeDown.
    await vi.waitFor(() => {
      expect(calls.some((c) => composeVerb(c.args) === 'down')).toBe(true);
    });
    const downCall = calls.find((c) => composeVerb(c.args) === 'down');
    expect(downCall?.args).toEqual(['compose', '-p', 'ax-svc-svc-up-1', '-f', '-', 'down', '-v']);

    await harness.close();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('back-compat: no services → the compose runner is NEVER invoked', async () => {
    const ws = await mkWorkspace();
    const { harness } = await makeHarness();
    const ctx = harness.ctx();
    const { run, calls } = fakeRunner();

    const result = await openSessionImpl(
      ctx,
      { sessionId: 'svc-none-1', workspaceRoot: ws, runnerBinary: ECHO_STUB },
      harness.bus,
      run,
    );
    expect(calls).toHaveLength(0);

    await result.handle.kill();
    await result.handle.exited;
    await new Promise((r) => setTimeout(r, 50));
    // Still zero docker calls after teardown (no project to down).
    expect(calls).toHaveLength(0);

    await harness.close();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('bring-up failure tears the project down, unwinds the session, and throws services-up-failed', async () => {
    const ws = await mkWorkspace();
    const { harness, spies } = await makeHarness();
    const ctx = harness.ctx();
    const { run, calls } = fakeRunner({ upResult: { code: 1, stdout: '', stderr: 'pull denied' } });

    const err = await openSessionImpl(
      ctx,
      { sessionId: 'svc-up-fail-1', workspaceRoot: ws, runnerBinary: ECHO_STUB, services: [pgService()] },
      harness.bus,
      run,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('services-up-failed');
    // We tried to up, then issued a down to clean up the partial project.
    expect(calls.some((c) => composeVerb(c.args) === 'up')).toBe(true);
    expect(calls.some((c) => composeVerb(c.args) === 'down')).toBe(true);
    // The session we minted before bring-up was terminated on unwind.
    expect(spies.sessionTerminate).toHaveBeenCalled();
    expect(spies.ipcStop).toHaveBeenCalled();

    await harness.close();
    await fs.rm(ws, { recursive: true, force: true });
  });

  // TASK-160 — a bring-up failure caused by a missing writablePath self-diagnoses:
  // the thrown PluginError carries a neutral `diagnosis` naming the service + path.
  it('enriches the services-up-failed error with the offending service + path (EROFS)', async () => {
    const ws = await mkWorkspace();
    const { harness, spies } = await makeHarness();
    const ctx = harness.ctx();
    const { run, calls } = fakeRunner({
      upResult: { code: 1, stdout: '', stderr: 'service "db" failed to start' },
      logsResult: {
        code: 0,
        stdout:
          'db  | initdb: error: could not create directory "/var/lib/postgresql/data": Read-only file system',
        stderr: '',
      },
    });

    const err = await openSessionImpl(
      ctx,
      { sessionId: 'svc-erofs-1', workspaceRoot: ws, runnerBinary: ECHO_STUB, services: [pgService()] },
      harness.bus,
      run,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('services-up-failed');
    expect((err as PluginError).diagnosis).toEqual({
      service: 'db',
      path: '/var/lib/postgresql/data',
      reason: 'read-only filesystem',
    });
    // It captured logs BEFORE tearing the project down.
    const logsIdx = calls.findIndex((c) => composeVerb(c.args) === 'logs');
    const downIdx = calls.findIndex((c) => composeVerb(c.args) === 'down');
    expect(logsIdx).toBeGreaterThanOrEqual(0);
    expect(downIdx).toBeGreaterThan(logsIdx);
    // Unwind still happened.
    expect(spies.sessionTerminate).toHaveBeenCalled();

    await harness.close();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it('leaves the error generic (no diagnosis) when the failure is unparseable', async () => {
    const ws = await mkWorkspace();
    const { harness } = await makeHarness();
    const ctx = harness.ctx();
    const { run } = fakeRunner({
      upResult: { code: 1, stdout: '', stderr: 'pull access denied' },
      logsResult: { code: 0, stdout: 'db  | exiting with code 1', stderr: '' },
    });

    const err = await openSessionImpl(
      ctx,
      { sessionId: 'svc-generic-1', workspaceRoot: ws, runnerBinary: ECHO_STUB, services: [pgService()] },
      harness.bus,
      run,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('services-up-failed');
    expect((err as PluginError).diagnosis).toBeUndefined();

    await harness.close();
    await fs.rm(ws, { recursive: true, force: true });
  });
});
