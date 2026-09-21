import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type Logger } from '@ax/core';

import { AGENTS_RESOLVE_HOOK } from '../access.js';
import { createMemoryExporter, MEMORY_EXPORT_FAILED_EVENT } from '../exporter.js';
import { capturingLogger, ALICE, type LoggedEvent } from './harness.js';

const AGENT = 'agent-1';

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
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
  scanCalls: Array<{ after?: string; ownerUserId?: string }>;
  listCalls: Array<{ pathGlob: string; version?: string }>;
  readCalls: Array<{ path: string; version?: string }>;
  applyCalls: Array<{ changes: Array<{ path: string; kind: string }>; parent: unknown }>;
  files: Map<string, Uint8Array>;
  setScan: (fn: (input: { after?: string }) => Promise<unknown>) => void;
  setList: (fn: (input: { version?: string }) => Promise<unknown>) => void;
  setRead: (fn: (input: { path: string; version?: string }) => Promise<unknown>) => void;
  setApply: (fn: (input: { changes: unknown[]; parent: unknown }) => Promise<unknown>) => void;
  failNextApplies: (n: number, err: unknown) => void;
  resolveCalls: number;
  bumpResolveCalls: () => number;
  allowed: Set<string>;
  beforeResolve: (() => Promise<void>) | undefined;
  setBeforeResolve: (fn: (() => Promise<void>) | undefined) => void;
}

function stubWorkspace(): Stubbed {
  const bus = new HookBus();
  const st = {
    bus,
    scanCalls: [] as Stubbed['scanCalls'],
    listCalls: [] as Stubbed['listCalls'],
    readCalls: [] as Stubbed['readCalls'],
    applyCalls: [] as Stubbed['applyCalls'],
    files: new Map<string, Uint8Array>(),
    resolveCalls: 0,
    bumpResolveCalls: () => ++st.resolveCalls,
    allowed: new Set<string>([ALICE]),
    beforeResolve: undefined,
    setBeforeResolve: (fn) => {
      st.beforeResolve = fn;
    },
    setScan: (fn) => {
      scanImpl = fn;
    },
    setList: (fn) => {
      listImpl = fn;
    },
    setRead: (fn) => {
      readImpl = fn;
    },
    setApply: (fn) => {
      applyImpl = fn;
    },
    failNextApplies: (n, err) => {
      applyFailures = n;
      applyError = err;
    },
  };
  let scanImpl: (input: { after?: string }) => Promise<unknown> = async () => ({
    statements: [],
  });
  let listImpl: (input: { version?: string }) => Promise<unknown> = async () => ({
    paths: [...st.files.keys()],
    version: 'v1',
  });
  let readImpl: (input: { path: string; version?: string }) => Promise<unknown> = async ({ path }) => {
    const bytes = st.files.get(path);
    return bytes === undefined ? { found: false } : { found: true, bytes, version: 'v1' };
  };
  let applyImpl: (input: { changes: unknown[]; parent: unknown }) => Promise<unknown> = async ({
    changes,
  }) => {
    for (const change of changes as Array<{ path: string; kind: string; content?: Uint8Array }>) {
      if (change.kind === 'put') {
        st.files.set(change.path, change.content!);
      } else {
        st.files.delete(change.path);
      }
    }
    return { delta: { before: 'v1', after: 'v2', changes: [] }, version: 'v2' };
  };
  let applyFailures = 0;
  let applyError: unknown = null;

  bus.registerService(AGENTS_RESOLVE_HOOK, '@ax/test-agents', async (_ctx, input) => {
    st.resolveCalls += 1;
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
  bus.registerService('workspace:list', 'ws', async (_ctx, input) => {
    const req = input as { pathGlob: string; version?: string };
    st.listCalls.push(req);
    return listImpl(req);
  });
  bus.registerService('workspace:read', 'ws', async (_ctx, input) => {
    const req = input as { path: string; version?: string };
    st.readCalls.push(req);
    return readImpl(req);
  });
  bus.registerService('workspace:apply', 'ws', async (_ctx, input) => {
    const req = input as Stubbed['applyCalls'][number];
    st.applyCalls.push({ changes: req.changes, parent: req.parent });
    if (applyFailures > 0) {
      applyFailures -= 1;
      throw applyError;
    }
    return applyImpl(req);
  });
  return st;
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
  it('flush publishes the desired files through workspace:apply', async () => {
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    const result = await exporter.flush(makeCtx());
    expect(result.changed).toBe(true);
    expect(st.applyCalls).toHaveLength(1);
    const paths = st.applyCalls[0]!.changes.map((c) => c.path);
    expect(paths).toContain('permanent/memory/facts/profile.md');
    expect(paths).toContain('permanent/memory/facts/recent.md');
    expect(paths).toContain('permanent/memory/facts/user/2026-09.md');
    await exporter.shutdown();
  });

  it('applies nothing and reports unchanged when the projection is already current', async () => {
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await exporter.flush(makeCtx());
    st.applyCalls.length = 0;
    const second = await exporter.flush(makeCtx());
    expect(second.changed).toBe(false);
    expect(st.applyCalls).toHaveLength(0);
    await exporter.shutdown();
  });

  it('scans every page until nextAfter is absent', async () => {
    const st = stubWorkspace();
    st.setScan(async ({ after }) => {
      if (after === undefined) {
        return { statements: [FACT], nextAfter: 'r1' };
      }
      return {
        statements: [{ ...FACT, id: 'r2', about: 'assistant', value: 'page two' }],
      };
    });
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await exporter.flush(makeCtx());
    expect(st.scanCalls.map((c) => c.after)).toEqual([undefined, 'r1']);
    const paths = st.applyCalls[0]!.changes.map((c) => c.path);
    expect(paths).toContain('permanent/memory/facts/assistant/2026-09.md');
    await exporter.shutdown();
  });

  it('scopes the scan by owner on a personal agent', async () => {
    const st = stubWorkspace();
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await exporter.flush(makeCtx());
    expect(st.scanCalls[0]!.ownerUserId).toBe(ALICE);
    await exporter.shutdown();
  });

  it('refuses a repeated cursor and publishes nothing', async () => {
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT], nextAfter: 'same' }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    expect(st.applyCalls).toHaveLength(0);
    await exporter.shutdown();
  });

  it.each([
    ['null page', null],
    ['non-array statements', { statements: 'nope' }],
    ['empty-string cursor', { statements: [FACT], nextAfter: '' }],
    ['non-string cursor', { statements: [FACT], nextAfter: 7 }],
  ])('refuses a malformed scan (%s) without a partial export', async (_l, page) => {
    const st = stubWorkspace();
    st.setScan(async () => page);
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    expect(st.applyCalls).toHaveLength(0);
    await exporter.shutdown();
  });

  it('retries a parent-mismatch with a fresh scan and baseline, then succeeds', async () => {
    const st = stubWorkspace();
    let scans = 0;
    st.setScan(async () => {
      scans += 1;
      return { statements: [{ ...FACT, value: `v${scans}` }] };
    });
    st.failNextApplies(
      1,
      new PluginError({ code: 'parent-mismatch', plugin: 'ws', message: 'stale' }),
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    const result = await exporter.flush(makeCtx());
    expect(result.changed).toBe(true);
    expect(scans).toBe(2);
    expect(st.applyCalls).toHaveLength(2);
    const written = st.files.get('permanent/memory/facts/user/2026-09.md');
    expect(Buffer.from(written!).toString('utf-8')).toContain('v2');
    await exporter.shutdown();
  });

  it('a non-parent-mismatch apply failure is not retried and stores nothing', async () => {
    const st = stubWorkspace();
    let scans = 0;
    st.setScan(async () => {
      scans += 1;
      return { statements: [FACT] };
    });
    st.failNextApplies(
      10,
      new PluginError({ code: 'unavailable', plugin: 'ws', message: 'down' }),
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({ code: 'unavailable' });
    expect(scans).toBe(1);
    expect(st.files.size).toBe(0);
    await exporter.shutdown();
  });

  it('debounce coalesces schedules into a single pass', async () => {
    const st = stubWorkspace();
    const exporter = createMemoryExporter(st.bus, { debounceMs: 20 });
    const ctx = makeCtx();
    exporter.schedule(ctx);
    exporter.schedule(ctx);
    exporter.schedule(ctx);
    await vi.waitFor(() => expect(st.scanCalls.length).toBe(1));
    await exporter.shutdown();
  });

  it('a write during an active flush schedules another pass', async () => {
    const st = stubWorkspace();
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
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
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
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx('intruder'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(st.applyCalls).toHaveLength(0);
    await exporter.shutdown();
  });

  it('schedule() never throws, and failures surface as memory_export_failed', async () => {
    const st = stubWorkspace();
    const logs: Array<{ level: string; event: string; bindings: Record<string, unknown> }> = [];
    st.setScan(async () => {
      throw new PluginError({ code: 'unavailable', plugin: 'engine', message: 'down' });
    });
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
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
    expect(JSON.stringify(failures[0]!.bindings)).not.toContain('tea');
  });

  it('rejects a non-finite or negative debounceMs', () => {
    const st = stubWorkspace();
    for (const debounceMs of [-1, NaN, Infinity]) {
      expect(() => createMemoryExporter(st.bus, { debounceMs })).toThrow();
    }
  });

  it('a parent-mismatch retry uses the reported actualParent as the next parent', async () => {
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT] }));
    st.failNextApplies(
      1,
      new PluginError({
        code: 'parent-mismatch',
        plugin: 'ws',
        message: 'stale',
        cause: { actualParent: 'v9' },
      }),
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    const result = await exporter.flush(makeCtx());
    expect(result.changed).toBe(true);
    expect(st.applyCalls).toHaveLength(2);
    expect(st.applyCalls[1]!.parent).toBe('v9');
    expect(st.listCalls.filter((c) => c.version === 'v9').length).toBeGreaterThan(0);
    await exporter.shutdown();
  });

  it('a first read that exposes a newer version re-lists at that version before collecting files', async () => {
    const st = stubWorkspace();
    const PROFILE = 'permanent/memory/facts/profile.md';
    const STALE = 'permanent/memory/facts/user/2020-01.md';
    st.files.set(PROFILE, Buffer.from('# old profile\n'));
    st.files.set(STALE, Buffer.from('# old journal\n'));
    st.setScan(async () => ({ statements: [FACT] }));
    st.setList(async ({ version }) =>
      version === 'v2'
        ? { paths: [PROFILE, STALE], version: 'v2' }
        : { paths: [PROFILE], version: 'v1' },
    );
    st.setRead(async ({ path }) => ({
      found: true,
      bytes: st.files.get(path)!,
      version: 'v2',
    }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await exporter.flush(makeCtx());
    const apply = st.applyCalls[0]!;
    expect(apply.parent).toBe('v2');
    expect(apply.changes).toContainEqual({ path: STALE, kind: 'delete' });
    expect(st.files.has(STALE)).toBe(false);
    expect(st.readCalls[0]!.version).toBeUndefined();
    expect(st.readCalls.slice(1).every((c) => c.version === 'v2')).toBe(true);
    await exporter.shutdown();
  });

  it.each([
    ['read bytes not a Uint8Array', { found: true, bytes: 'nope', version: 'v1' }],
    ['read found without a version', { found: true, bytes: new Uint8Array() }],
    ['read found with an empty version', { found: true, bytes: new Uint8Array(), version: '' }],
  ])('refuses a malformed workspace read (%s)', async (_l, reply) => {
    const st = stubWorkspace();
    st.files.set('permanent/memory/facts/profile.md', Buffer.from('# old\n'));
    st.setScan(async () => ({ statements: [FACT] }));
    st.setRead(async () => reply);
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    await exporter.shutdown();
  });

  it.each([
    ['null', null],
    ['missing version', { delta: {} }],
    ['empty version', { version: '' }],
  ])('refuses a malformed workspace apply reply (%s)', async (_l, reply) => {
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT] }));
    st.setApply(async () => reply);
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    await exporter.shutdown();
  });

  it('a volume sync failure rejects the flush even after the workspace commit lands', async () => {
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT] }));
    const hostRoot = join(await mkdtemp(join(tmpdir(), 'ax-vol-')), 'not-a-dir');
    dirs.push(hostRoot);
    await writeFile(hostRoot, 'occupied');
    const exporter = createMemoryExporter(st.bus, {
      debounceMs: 1,
      volume: { hostRoot, backing: { server: 'nfs', exportPath: '/srv/ax' } },
    });
    await expect(exporter.flush(makeCtx())).rejects.toThrow();
    expect(st.files.get('permanent/memory/facts/profile.md')).toBeDefined();
    await exporter.shutdown();
  });

  it('an unauthorized concurrent flush cannot piggyback on an authorized in-flight pass', async () => {
    const st = stubWorkspace();
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
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
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
    const st = stubWorkspace();
    let scans = 0;
    st.setScan(async () => {
      scans += 1;
      return { statements: [{ ...FACT, value: `v${scans}` }] };
    });
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    const ctx = makeCtx();
    let scheduled = false;
    st.setApply(async ({ changes }) => {
      for (const change of changes as Array<{ path: string; kind: string; content?: Uint8Array }>) {
        if (change.kind === 'put') st.files.set(change.path, change.content!);
        else st.files.delete(change.path);
      }
      if (!scheduled) {
        scheduled = true;
        exporter.schedule(ctx);
      }
      return { version: 'v2' };
    });
    const result = await exporter.flush(ctx);
    expect(scans).toBe(2);
    expect(result.changed).toBe(true);
    await exporter.shutdown();
  });

  it('a throwing warn logger cannot crash a scheduled pass', async () => {
    const st = stubWorkspace();
    st.setScan(async () => {
      throw new PluginError({ code: 'unavailable', plugin: 'engine', message: 'down' });
    });
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
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

  it('refuses when a pinned read reports a different version than requested', async () => {
    const st = stubWorkspace();
    const P1 = 'permanent/memory/facts/profile.md';
    const P2 = 'permanent/memory/facts/recent.md';
    st.files.set(P1, Buffer.from('# a\n'));
    st.files.set(P2, Buffer.from('# b\n'));
    st.setScan(async () => ({ statements: [FACT] }));
    st.setRead(async ({ path, version }) => ({
      found: true,
      bytes: st.files.get(path)!,
      version: version === 'v1' && path === P2 ? 'v9' : 'v1',
    }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    expect(st.applyCalls).toHaveLength(0);
    await exporter.shutdown();
  });

  it('fails closed when a pinned-listed file is missing on read', async () => {
    const st = stubWorkspace();
    const P1 = 'permanent/memory/facts/profile.md';
    const GHOST = 'permanent/memory/facts/user/2020-01.md';
    st.files.set(P1, Buffer.from('# a\n'));
    st.setScan(async () => ({ statements: [FACT] }));
    st.setList(async ({ version }) =>
      version === 'v1' ? { paths: [P1, GHOST], version: 'v1' } : { paths: [P1], version: 'v1' },
    );
    st.setRead(async ({ path }) =>
      path === GHOST
        ? { found: false }
        : { found: true, bytes: st.files.get(path)!, version: 'v1' },
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await expect(exporter.flush(makeCtx())).rejects.toMatchObject({
      code: 'invalid-return',
    });
    expect(st.applyCalls).toHaveLength(0);
    await exporter.shutdown();
  });

  it('a stale null actualParent is replaced by the version the baseline actually read', async () => {
    const st = stubWorkspace();
    st.files.set('permanent/memory/facts/profile.md', Buffer.from('# old\n'));
    st.setScan(async () => ({ statements: [FACT] }));
    st.failNextApplies(
      1,
      new PluginError({
        code: 'parent-mismatch',
        plugin: 'ws',
        message: 'stale',
        cause: { actualParent: null },
      }),
    );
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    await exporter.flush(makeCtx());
    expect(st.applyCalls).toHaveLength(2);
    expect(st.applyCalls[1]!.parent).toBe('v1');
    await exporter.shutdown();
  });

  it('re-resolves access before the volume sync even when nothing changed', async () => {
    const st = stubWorkspace();
    st.setScan(async () => ({ statements: [FACT] }));
    const hostRoot = await mkdtemp(join(tmpdir(), 'ax-vol-'));
    dirs.push(hostRoot);
    const exporter = createMemoryExporter(st.bus, {
      debounceMs: 1,
      volume: { hostRoot, backing: { server: 'nfs', exportPath: '/srv/ax' } },
    });
    await exporter.flush(makeCtx());
    const { readdir, rm } = await import('node:fs/promises');
    await rm(hostRoot, { recursive: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(hostRoot);

    let gate: (() => void) | undefined;
    let held = true;
    st.setRead(({ path }) =>
      held
        ? new Promise((resolve) => {
            held = false;
            gate = () =>
              resolve({ found: true, bytes: st.files.get(path)!, version: 'v2' });
          })
        : Promise.resolve({ found: true, bytes: st.files.get(path)!, version: 'v2' }),
    );
    st.setList(async () => ({
      paths: [...st.files.keys()],
      version: 'v2',
    }));
    const pending = exporter.flush(makeCtx());
    await vi.waitFor(() => expect(st.readCalls.length).toBe(1));
    st.allowed.clear();
    gate?.();
    await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readdir(hostRoot)).toHaveLength(0);
    await exporter.shutdown();
  });

  it('a flush released after shutdown started refuses instead of starting work', async () => {
    const st = stubWorkspace();
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
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
    const pending = exporter.flush(makeCtx());
    await vi.waitFor(() => expect(calls).toBe(1));
    const down = exporter.shutdown();
    release?.();
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await down;
    expect(st.scanCalls).toHaveLength(0);
  });

  it('shutdown drains queued work, refuses later flush, and late schedule logs a failure', async () => {
    const st = stubWorkspace();
    const logs: LoggedEvent[] = [];
    st.setScan(async () => ({ statements: [FACT] }));
    const exporter = createMemoryExporter(st.bus, { debounceMs: 1 });
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
