import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  MEMORY_FACTS_EXPORT_ROOT,
  makeAgentContext,
  PluginError,
  type Logger,
} from '@ax/core';

import { AGENTS_RESOLVE_HOOK } from '../access.js';
import { createMemoryExporter, MEMORY_EXPORT_FAILED_EVENT } from '../exporter.js';
import { volumeAgentKey, type MemoryVolumeConfig } from '../export-volume.js';
import { capturingLogger, ALICE, type LoggedEvent } from './harness.js';

const AGENT = 'agent-1';
const BACKING = { server: 'nfs', exportPath: '/srv/ax' };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeCtx(userId = ALICE, agentId = AGENT, logs: LoggedEvent[] = []) {
  return makeAgentContext({
    sessionId: 's1',
    agentId,
    userId,
    workspace: { rootPath: '/tmp' },
    logger: capturingLogger(logs),
  });
}

interface Stubbed {
  bus: HookBus;
  hostRoot: string;
  volume: MemoryVolumeConfig;
  scanCalls: Array<{ after?: string; ownerUserId?: string }>;
  workspaceCalls: Array<{ hook: string; input: unknown }>;
  setScan: (fn: (input: { after?: string }) => Promise<unknown>) => void;
  allowed: Set<string>;
  beforeResolve: (() => Promise<void>) | undefined;
  setBeforeResolve: (fn: (() => Promise<void>) | undefined) => void;
}

/**
 * The exporter's whole world: the access resolver, the engine's scan, and a
 * real temp directory as the memory volume. The `workspace:*` services are
 * spies, not stores — the export is written only to the volume (TASK-991), so
 * any call to one is recorded by name and fails the pass.
 */
async function stubExportBus(): Promise<Stubbed> {
  const bus = new HookBus();
  const hostRoot = await mkdtemp(join(tmpdir(), 'ax-vol-'));
  dirs.push(hostRoot);
  let scanImpl: (input: { after?: string }) => Promise<unknown> = async () => ({
    statements: [],
  });
  const st: Stubbed = {
    bus,
    hostRoot,
    volume: { hostRoot, backing: BACKING },
    scanCalls: [],
    workspaceCalls: [],
    allowed: new Set<string>([ALICE]),
    beforeResolve: undefined,
    setBeforeResolve: (fn) => {
      st.beforeResolve = fn;
    },
    setScan: (fn) => {
      scanImpl = fn;
    },
  };

  bus.registerService(AGENTS_RESOLVE_HOOK, '@ax/test-agents', async (_ctx, input) => {
    if (st.beforeResolve !== undefined) await st.beforeResolve();
    const { agentId, userId } = input as { agentId: string; userId: string };
    if (!st.allowed.has(userId)) {
      throw new PluginError({ code: 'forbidden', plugin: 'test', message: 'denied' });
    }
    return {
      agent: { id: agentId, ownerId: userId, ownerType: 'user', visibility: 'personal' },
    };
  });
  bus.registerService('memory:facts:scan', 'engine', async (_ctx, input) => {
    st.scanCalls.push(input as { after?: string });
    return scanImpl(input as { after?: string });
  });
  for (const hook of ['workspace:list', 'workspace:read', 'workspace:apply']) {
    bus.registerService(hook, 'ws', async (_ctx, input) => {
      st.workspaceCalls.push({ hook, input });
      throw new PluginError({ code: 'unexpected-call', plugin: 'ws', message: `${hook} called` });
    });
  }
  return st;
}

/** A file in `agentId`'s facts directory on the volume. */
function factsFile(st: Stubbed, file: string, agentId = AGENT): string {
  return join(
    st.hostRoot,
    volumeAgentKey(agentId),
    ...MEMORY_FACTS_EXPORT_ROOT.split('/'),
    ...file.split('/'),
  );
}

const FACT = {
  id: 'r1',
  about: 'user:user-alice',
  relation: 'likes',
  value: 'tea',
  when: '2026-09-01T00:00:00.000Z',
  recordedAt: '2026-09-10T00:00:00.000Z',
  provenance: 'extracted',
};

describe('createMemoryExporter', () => {
  it('flush writes the projection to the volume, reports changed, and calls no workspace hook', async () => {
    const st = await stubExportBus();
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const result = await exporter.flush(makeCtx());
    expect(result.changed).toBe(true);
    await expect(readFile(factsFile(st, 'profile.md'), 'utf-8')).resolves.toMatch(/^# Profile\n/);
    await expect(readFile(factsFile(st, 'recent.md'), 'utf-8')).resolves.toMatch(/^# Recent\n/);
    await expect(readFile(factsFile(st, 'user/2026-09.md'), 'utf-8')).resolves.toContain('tea');
    expect(st.workspaceCalls).toEqual([]);
    await exporter.shutdown();
  });

  it('applies nothing and reports unchanged when the projection is already current', async () => {
    const st = await stubExportBus();
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    await exporter.flush(makeCtx());
    const second = await exporter.flush(makeCtx());
    expect(second.changed).toBe(false);
    expect(st.scanCalls).toHaveLength(2);
    await exporter.shutdown();
  });

  it('scans every page until nextAfter is absent', async () => {
    const st = await stubExportBus();
    st.setScan(async ({ after }) => {
      if (after === undefined) {
        return { statements: [FACT], nextAfter: 'r1' };
      }
      return {
        statements: [{ ...FACT, id: 'r2', about: 'assistant', value: 'page two' }],
      };
    });
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    await exporter.flush(makeCtx());
    expect(st.scanCalls.map((c) => c.after)).toEqual([undefined, 'r1']);
    await expect(readFile(factsFile(st, 'assistant/2026-09.md'), 'utf-8')).resolves.toContain(
      'page two',
    );
    await exporter.shutdown();
  });

  it('scopes the scan by owner on a personal agent', async () => {
    const st = await stubExportBus();
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    await exporter.flush(makeCtx());
    expect(st.scanCalls[0]!.ownerUserId).toBe(ALICE);
    await exporter.shutdown();
  });

  it('refuses a repeated cursor and publishes nothing', async () => {
    const st = await stubExportBus();
    st.setScan(async () => ({ statements: [FACT], nextAfter: 'same' }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    expect(await readdir(st.hostRoot)).toEqual([]);
    await exporter.shutdown();
  });

  it.each([
    ['null page', null],
    ['non-array statements', { statements: 'nope' }],
    ['empty-string cursor', { statements: [FACT], nextAfter: '' }],
    ['non-string cursor', { statements: [FACT], nextAfter: 7 }],
  ])('refuses a malformed scan (%s) without a partial export', async (_l, page) => {
    const st = await stubExportBus();
    st.setScan(async () => page);
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    expect(await readdir(st.hostRoot)).toEqual([]);
    await exporter.shutdown();
  });

  it('debounce coalesces schedules into a single pass', async () => {
    const st = await stubExportBus();
    const exporter = createMemoryExporter(st.bus, { debounceMs: 20, volume: st.volume });
    const ctx = makeCtx();
    exporter.schedule(ctx);
    exporter.schedule(ctx);
    exporter.schedule(ctx);
    await vi.waitFor(() => expect(st.scanCalls.length).toBe(1));
    await exporter.shutdown();
  });

  it('a write during an active flush schedules another pass', async () => {
    const st = await stubExportBus();
    let gate: (() => void) | undefined;
    let holdFirst = true;
    st.setScan(
      () =>
        holdFirst
          ? new Promise((resolve) => {
              holdFirst = false;
              gate = () => resolve({ statements: [] });
            })
          : Promise.resolve({ statements: [] }),
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const ctx = makeCtx();
    const firstFlush = exporter.flush(ctx);
    await vi.waitFor(() => expect(st.scanCalls.length).toBe(1));
    exporter.schedule(ctx);
    gate?.();
    await firstFlush;
    await vi.waitFor(() => expect(st.scanCalls.length).toBe(2));
    await exporter.shutdown();
  });

  it('a caller the resolver refuses never publishes', async () => {
    const st = await stubExportBus();
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    await expect(exporter.flush(makeCtx('intruder'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await readdir(st.hostRoot)).toEqual([]);
    await exporter.shutdown();
  });

  it('schedule() never throws, and failures surface as memory_export_failed', async () => {
    const st = await stubExportBus();
    const logs: Array<{ level: string; event: string; bindings: Record<string, unknown> }> = [];
    st.setScan(async () => {
      throw new PluginError({ code: 'unavailable', plugin: 'engine', message: 'down' });
    });
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const ctx = makeAgentContext({
      sessionId: 's1',
      agentId: AGENT,
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
      logger: capturingLogger(logs),
    });
    expect(() => exporter.schedule(ctx)).not.toThrow();
    await exporter.shutdown();
    const failures = logs.filter((l) => l.event === MEMORY_EXPORT_FAILED_EVENT);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.bindings.agentId).toBe(AGENT);
    expect(failures[0]!.bindings).not.toHaveProperty('files');
    expect(JSON.stringify(failures[0]!.bindings)).not.toContain('tea');
  });

  it('rejects a non-finite or negative debounceMs', async () => {
    const st = await stubExportBus();
    for (const debounceMs of [-1, NaN, Infinity]) {
      expect(() => createMemoryExporter(st.bus, { debounceMs, volume: st.volume })).toThrow();
    }
  });

  it('a volume sync failure rejects the flush', async () => {
    const st = await stubExportBus();
    st.setScan(async () => ({ statements: [FACT] }));
    const parent = await mkdtemp(join(tmpdir(), 'ax-vol-'));
    dirs.push(parent);
    const hostRoot = join(parent, 'not-a-dir');
    await writeFile(hostRoot, 'occupied');
    const exporter = createMemoryExporter(st.bus, {
      debounceMs: 1,
      volume: { hostRoot, backing: BACKING },
    });
    await expect(exporter.flush(makeCtx())).rejects.toThrow(/not-a-dir/);
    await exporter.shutdown();
  });

  it('an unauthorized concurrent flush cannot piggyback on an authorized in-flight pass', async () => {
    const st = await stubExportBus();
    let gate: (() => void) | undefined;
    let held = true;
    st.setScan(() =>
      held
        ? new Promise((resolve) => {
            held = false;
            gate = () => resolve({ statements: [FACT] });
          })
        : Promise.resolve({ statements: [FACT] }),
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const good = exporter.flush(makeCtx(ALICE));
    await vi.waitFor(() => expect(st.scanCalls.length).toBe(1));
    await expect(exporter.flush(makeCtx('intruder'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    gate?.();
    await good;
    expect(st.scanCalls.length).toBe(1);
    await exporter.shutdown();
  });

  it('a second flush during a pass waits for the dirty pass instead of dropping it', async () => {
    const st = await stubExportBus();
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const ctx = makeCtx();
    let scans = 0;
    st.setScan(async () => {
      scans += 1;
      // New facts land while the first pass is still scanning.
      if (scans === 1) exporter.schedule(ctx);
      return { statements: [{ ...FACT, value: `v${scans}` }] };
    });
    const result = await exporter.flush(ctx);
    expect(scans).toBe(2);
    expect(result.changed).toBe(true);
    await expect(readFile(factsFile(st, 'user/2026-09.md'), 'utf-8')).resolves.toContain('v2');
    await exporter.shutdown();
  });

  it('a throwing warn logger cannot crash a scheduled pass', async () => {
    const st = await stubExportBus();
    st.setScan(async () => {
      throw new PluginError({ code: 'unavailable', plugin: 'engine', message: 'down' });
    });
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const throwingLogger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {
        throw new Error('logger exploded');
      },
      error: () => {},
      child: () => throwingLogger,
    };
    const ctx = makeAgentContext({
      sessionId: 's1',
      agentId: AGENT,
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
      logger: throwingLogger,
    });
    expect(() => exporter.schedule(ctx)).not.toThrow();
    await exporter.shutdown();
  });

  it('re-resolves access before the volume sync', async () => {
    const st = await stubExportBus();
    let gate: (() => void) | undefined;
    st.setScan(
      () =>
        new Promise((resolve) => {
          gate = () => resolve({ statements: [FACT] });
        }),
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const pending = exporter.flush(makeCtx());
    // The scan runs after the pass's first access check; revoke access while
    // it is in flight, so only a check between the scan and the write can
    // refuse the publish.
    await vi.waitFor(() => expect(st.scanCalls).toHaveLength(1));
    st.allowed.clear();
    gate?.();
    await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readdir(st.hostRoot)).toEqual([]);
    await exporter.shutdown();
  });

  it('a flush released after shutdown started refuses instead of starting work', async () => {
    const st = await stubExportBus();
    let release: (() => void) | undefined;
    let calls = 0;
    st.setBeforeResolve(() => {
      calls += 1;
      return calls === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    });
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const pending = exporter.flush(makeCtx());
    await vi.waitFor(() => expect(calls).toBe(1));
    const down = exporter.shutdown();
    release?.();
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await down;
    expect(st.scanCalls).toHaveLength(0);
  });

  it('shutdown drains queued work, refuses later flush, and late schedule logs a failure', async () => {
    const st = await stubExportBus();
    const logs: LoggedEvent[] = [];
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1, volume: st.volume });
    const ctx = makeCtx(ALICE, AGENT, logs);
    exporter.schedule(ctx);
    await exporter.shutdown();
    expect(st.scanCalls.length).toBeGreaterThan(0);
    await expect(exporter.flush(ctx)).rejects.toMatchObject({ code: 'unavailable' });
    logs.length = 0;
    exporter.schedule(ctx);
    expect(logs.some((l) => l.event === MEMORY_EXPORT_FAILED_EVENT)).toBe(true);
    expect(st.scanCalls.length).toBe(1);
  });
});
