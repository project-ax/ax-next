// TASK-719 -- deleting an agent removes its bare repo and refuses late writes.
//
// `registerWorkspaceGitHooks` subscribes to `agents:deleted`. On it, the
// agent's repo at `<repoRoot>/<workspaceIdForAgent(agentId)>.git` is removed
// and `workspace:deleted { agentId }` is fired so the disk-quota ledger can
// drop its row. Two things make this worth a whole file:
//
//   1. It deletes a directory tree on a user's behalf. It must never delete
//      the wrong one -- a malformed or path-shaped agent id never reaches the
//      filesystem as a path, and another agent's repo is never touched.
//   2. A warm runner outlives its agent by minutes, and every write path calls
//      `ensureRepo`, which CREATES a repo. Without a tombstone a late commit
//      would recreate the repo, `workspace:applied` would re-meter it, and the
//      ledger row the delete just released would come back. A write that was
//      already QUEUED on the agent's mutex when the delete arrived passed its
//      identity check before the tombstone existed, so the check runs again
//      inside the mutex right before the repo is (re)created.
//
// Everything here asserts observable state: the directory on disk, the hooks
// that fired on a real bus, the error a caller gets back.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import type {
  AgentContext,
  Logger,
  Plugin,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceDelta,
  WorkspaceDeletedPayload,
  WorkspaceDiffInput,
  WorkspaceDiffOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
  WorkspaceUsageInput,
  WorkspaceUsageOutput,
  WorkspaceVersion,
} from '@ax/core';
import { registerWorkspaceGitHooks, workspaceIdForAgent } from '../impl.js';

function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-agent-deleted-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-internal',
        'workspace:apply-bundle',
        'workspace:export-baseline-bundle',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
        'workspace:usage',
      ],
      calls: [],
      subscribes: ['agents:deleted'],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot });
    },
  };
}

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

function recordingLogger(lines: LogLine[]): Logger {
  const logger: Logger = {
    debug: (msg, bindings) => lines.push({ level: 'debug', msg, bindings }),
    info: (msg, bindings) => lines.push({ level: 'info', msg, bindings }),
    warn: (msg, bindings) => lines.push({ level: 'warn', msg, bindings }),
    error: (msg, bindings) => lines.push({ level: 'error', msg, bindings }),
    child: () => logger,
  };
  return logger;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const enc = new TextEncoder();

async function setup() {
  // `outer/` holds the repoRoot AND siblings of it, so a path-shaped agent id
  // that escaped `repoRoot` would have something real to destroy.
  const outer = mkdtempSync(join(tmpdir(), 'ax-ws-agent-deleted-'));
  const repoRoot = join(outer, 'root');
  mkdirSync(repoRoot);
  const h: TestHarness = await createTestHarness({ plugins: [makeCorePlugin(repoRoot)] });
  cleanup.push(async () => {
    await h.close();
    await rm(outer, { recursive: true, force: true });
  });

  const logs: LogLine[] = [];
  const logger = recordingLogger(logs);

  const deletedFires: unknown[] = [];
  h.bus.subscribe<WorkspaceDeletedPayload>('workspace:deleted', 'test-recorder', async (_ctx, p) => {
    deletedFires.push(p);
    return undefined;
  });
  const appliedFires: Array<{ agentId: string; delta: WorkspaceDelta }> = [];
  h.bus.subscribe<WorkspaceDelta>('workspace:applied', 'test-recorder', async (ctx, delta) => {
    appliedFires.push({ agentId: ctx.agentId, delta });
    return undefined;
  });
  // A cleanup subscriber registered AFTER the workspace backend. If the
  // backend's subscriber ever returned a rejection, `fire` would stop before
  // reaching this one -- which is exactly how one plugin's failure would strand
  // every later plugin's per-agent rows.
  const laterSubscriberSaw: unknown[] = [];
  h.bus.subscribe<unknown>('agents:deleted', 'test-later-cleanup', async (_ctx, p) => {
    laterSubscriberSaw.push(p);
    return undefined;
  });

  const caller = (agentId: string): AgentContext =>
    h.ctx({ userId: 'user-1', agentId, sessionId: `s-${agentId}`, logger });
  const gitdirOf = (agentId: string) => join(repoRoot, `${workspaceIdForAgent(agentId)}.git`);
  const write = (
    agentId: string,
    path: string,
    content: string,
    parent: WorkspaceVersion | null = null,
  ) =>
    h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', caller(agentId), {
      changes: [{ path, kind: 'put', content: enc.encode(content) }],
      parent,
    });
  const read = (agentId: string, path: string) =>
    h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', caller(agentId), { path });
  const deleteAgent = (payload: unknown) =>
    h.bus.fire('agents:deleted', caller('system-deleter'), payload);

  return {
    outer,
    repoRoot,
    h,
    logs,
    deletedFires,
    appliedFires,
    laterSubscriberSaw,
    caller,
    gitdirOf,
    write,
    read,
    deleteAgent,
  };
}

const deletedPayload = (agentId: unknown) => ({ agentId, ownerId: 'user-1', ownerType: 'user' });

describe('agents:deleted removes the agent repo (TASK-719)', () => {
  it('(a) removes the repo, fires workspace:deleted once with exactly { agentId }, and every hook then refuses', async () => {
    const w = await setup();
    await w.write('agent-a', 'notes.md', 'hello');
    expect(existsSync(w.gitdirOf('agent-a'))).toBe(true);

    await w.deleteAgent(deletedPayload('agent-a'));

    expect(existsSync(w.gitdirOf('agent-a'))).toBe(false);
    expect(w.deletedFires).toHaveLength(1);
    // Exactly `{ agentId }` -- no gitdir, no repoRoot, nothing a subscriber
    // could come to depend on that only this backend has (Invariant 1).
    expect(w.deletedFires[0]).toStrictEqual({ agentId: 'agent-a' });

    // workspace:usage for a deleted agent THROWS rather than reporting 0: the
    // tombstone check sits in `agentRepo`, the one entry every hook starts
    // from. (A 0 would let a late measurement upsert a fresh ledger row.)
    await expect(
      w.h.bus.call<WorkspaceUsageInput, WorkspaceUsageOutput>('workspace:usage', w.caller('agent-a'), {}),
    ).rejects.toMatchObject({ code: 'agent-deleted' });
    expect(existsSync(w.gitdirOf('agent-a'))).toBe(false);
  });

  it('(b) a write that arrives AFTER the delete throws agent-deleted, creates nothing, fires no workspace:applied', async () => {
    const w = await setup();
    await w.write('agent-a', 'notes.md', 'hello');
    await w.deleteAgent(deletedPayload('agent-a'));
    const appliedBefore = w.appliedFires.length;

    // Through the public facade (how a runner's commit lands)...
    await expect(w.write('agent-a', 'late.md', 'too late')).rejects.toMatchObject({
      code: 'agent-deleted',
    });
    // ...and straight at the internal hook, which is where ensureRepo lives.
    await expect(
      w.h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply-internal',
        w.caller('agent-a'),
        { changes: [{ path: 'late.md', kind: 'put', content: enc.encode('x') }], parent: null },
      ),
    ).rejects.toMatchObject({ code: 'agent-deleted' });

    expect(existsSync(w.gitdirOf('agent-a'))).toBe(false);
    expect(w.appliedFires.length).toBe(appliedBefore);
  });

  it('(b) every workspace hook refuses a deleted agent and none of them recreates the repo', async () => {
    const w = await setup();
    const { version } = await w.write('agent-a', 'notes.md', 'hello');
    await w.deleteAgent(deletedPayload('agent-a'));
    const me = w.caller('agent-a');
    const oid = version as string;

    const calls: Array<[string, () => Promise<unknown>]> = [
      ['workspace:read', () => w.read('agent-a', 'notes.md')],
      ['workspace:list', () => w.h.bus.call<WorkspaceListInput, WorkspaceListOutput>('workspace:list', me, {})],
      [
        'workspace:diff',
        () =>
          w.h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>('workspace:diff', me, {
            from: null,
            to: version,
          }),
      ],
      ['workspace:usage', () => w.h.bus.call('workspace:usage', me, {})],
      ['workspace:export-baseline-bundle', () => w.h.bus.call('workspace:export-baseline-bundle', me, {})],
      [
        'workspace:apply-bundle',
        () =>
          w.h.bus.call('workspace:apply-bundle', me, {
            bundleBytes: '',
            baselineCommit: oid,
            parent: version,
          }),
      ],
    ];
    for (const [hook, call] of calls) {
      await expect(call(), hook).rejects.toMatchObject({ code: 'agent-deleted' });
      expect(existsSync(w.gitdirOf('agent-a')), `${hook} recreated the repo`).toBe(false);
    }
  });

  describe('(c) a write already queued on the mutex when the delete arrives', () => {
    // Hold agent A's write mutex open: gate the first `fs.promises.readFile`
    // under A's gitdir. The first read inside `mutex.run` is `resolveHead`, so
    // the write holding the gate is INSIDE the mutex and everything else for A
    // queues behind it -- the second write first, then the delete.
    function holdMutexOnFirstRead(gitdir: string) {
      const realReadFile = nodeFs.promises.readFile.bind(nodeFs.promises);
      let entered!: () => void;
      const gateEntered = new Promise<void>((r) => (entered = r));
      let release!: () => void;
      const gateReleased = new Promise<void>((r) => (release = r));
      // If an assertion fails while the gate is shut, open it on cleanup (which
      // runs in reverse, so before the harness closes); otherwise the parked
      // write never settles and the suite hangs instead of failing.
      cleanup.push(async () => release());
      let tripped = false;
      vi.spyOn(nodeFs.promises, 'readFile').mockImplementation((async (
        p: Parameters<typeof realReadFile>[0],
        ...rest: unknown[]
      ) => {
        if (!tripped && typeof p === 'string' && p.startsWith(`${gitdir}/`)) {
          tripped = true;
          entered();
          await gateReleased;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return realReadFile(p, ...(rest as any));
      }) as typeof nodeFs.promises.readFile);
      return { gateEntered, release };
    }

    const tick = () => new Promise((r) => setTimeout(r, 50));

    it('a queued workspace:apply throws agent-deleted; the delete waits for the write holding the mutex; the repo is gone after', async () => {
      const w = await setup();
      const gitdir = w.gitdirOf('agent-a');
      const { version: v1 } = await w.write('agent-a', 'a.md', 'one');
      const appliedBefore = w.appliedFires.length;

      const gate = holdMutexOnFirstRead(gitdir);
      // Write 1 holds the mutex. Its parent is stale (null, head is v1), so it
      // ends in parent-mismatch -- unless the repo vanished under it mid-write,
      // in which case head reads as null and it would RECREATE the repo.
      const first = w.write('agent-a', 'b.md', 'two', null);
      const firstSettled = first.catch((e: unknown) => e);
      await gate.gateEntered;

      // Write 2 has the RIGHT parent: left alone it would commit and fire
      // workspace:applied. It passed its identity check before the delete.
      const second = w.write('agent-a', 'c.md', 'three', v1);
      const secondSettled = second.catch((e: unknown) => e);
      // Let write 2 get through the facade and `agentRepo` and park on the
      // mutex BEFORE the delete exists. Without this wait it reached
      // `agentRepo` after the tombstone and was refused there, so the test
      // passed with the in-mutex re-check deleted (caught by mutation).
      await tick();
      const del = w.deleteAgent(deletedPayload('agent-a'));
      await tick();

      // The delete is waiting its turn on the mutex, not removing the repo out
      // from under the write that holds it.
      expect(existsSync(gitdir)).toBe(true);
      expect(w.deletedFires).toHaveLength(0);

      gate.release();
      const [firstErr, secondErr] = await Promise.all([firstSettled, secondSettled, del]);

      expect(firstErr).toMatchObject({ code: 'parent-mismatch' });
      expect(secondErr).toMatchObject({ code: 'agent-deleted' });
      expect(existsSync(gitdir)).toBe(false);
      expect(w.appliedFires.length).toBe(appliedBefore);
      expect(w.deletedFires).toStrictEqual([{ agentId: 'agent-a' }]);
    });

    it('a queued workspace:export-baseline-bundle throws agent-deleted (it takes the same mutex and would init the repo)', async () => {
      const w = await setup();
      const gitdir = w.gitdirOf('agent-a');
      await w.write('agent-a', 'a.md', 'one');
      const gate = holdMutexOnFirstRead(gitdir);
      const first = w.write('agent-a', 'b.md', 'two', null).catch((e: unknown) => e);
      await gate.gateEntered;

      const queued = w.h.bus
        .call('workspace:export-baseline-bundle', w.caller('agent-a'), {})
        .catch((e: unknown) => e);
      await tick(); // parked on the mutex before the delete exists
      const del = w.deleteAgent(deletedPayload('agent-a'));
      gate.release();
      const [, queuedResult] = await Promise.all([first, queued, del]);

      expect(queuedResult).toMatchObject({ code: 'agent-deleted' });
      expect(existsSync(gitdir)).toBe(false);
    });

    it('a queued workspace:apply-bundle throws agent-deleted (not the parent-mismatch it would reach unchecked)', async () => {
      const w = await setup();
      const gitdir = w.gitdirOf('agent-a');
      const { version: v1 } = await w.write('agent-a', 'a.md', 'one');
      const gate = holdMutexOnFirstRead(gitdir);
      const first = w.write('agent-a', 'b.md', 'two', null).catch((e: unknown) => e);
      await gate.gateEntered;

      const queued = w.h.bus
        .call('workspace:apply-bundle', w.caller('agent-a'), {
          bundleBytes: '',
          baselineCommit: '0'.repeat(40),
          parent: v1,
        })
        .catch((e: unknown) => e);
      await tick(); // parked on the mutex before the delete exists
      const del = w.deleteAgent(deletedPayload('agent-a'));
      gate.release();
      const [, queuedResult] = await Promise.all([first, queued, del]);

      expect(queuedResult).toMatchObject({ code: 'agent-deleted' });
      expect(existsSync(gitdir)).toBe(false);
    });
  });

  it('(d) another agent in the same repoRoot is untouched and still writable', async () => {
    const w = await setup();
    await w.write('agent-a', 'a.md', 'mine');
    const { version: bV1 } = await w.write('agent-b', 'b.md', 'not yours to delete');

    await w.deleteAgent(deletedPayload('agent-a'));

    expect(existsSync(w.gitdirOf('agent-a'))).toBe(false);
    expect(existsSync(w.gitdirOf('agent-b'))).toBe(true);
    expect(await w.read('agent-b', 'b.md')).toMatchObject({
      found: true,
      bytes: enc.encode('not yours to delete'),
      version: bV1,
    });
    const next = await w.write('agent-b', 'b2.md', 'still writing', bV1);
    expect(next.version).not.toBe(bV1);
    expect(w.deletedFires).toStrictEqual([{ agentId: 'agent-a' }]);
  });

  it('(e) if removing the repo fails: logs an error naming the agent, fires nothing, keeps refusing writes, does not break the fan-out', async () => {
    const w = await setup();
    await w.write('agent-a', 'a.md', 'one');
    const gitdir = w.gitdirOf('agent-a');

    const realRm = nodeFs.promises.rm.bind(nodeFs.promises);
    vi.spyOn(nodeFs.promises, 'rm').mockImplementation((async (
      p: Parameters<typeof realRm>[0],
      opts?: Parameters<typeof realRm>[1],
    ) => {
      if (p === gitdir) {
        const e = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException;
        e.code = 'EBUSY';
        throw e;
      }
      return realRm(p, opts);
    }) as typeof nodeFs.promises.rm);

    const payload = deletedPayload('agent-a');
    const result = await w.deleteAgent(payload);

    expect(result.rejected).toBe(false);
    expect(w.laterSubscriberSaw).toHaveLength(1);
    const errors = w.logs.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('workspace_git_delete_for_deleted_agent_failed');
    expect(errors[0]!.bindings).toMatchObject({ agentId: 'agent-a' });
    // The bytes are still on disk, so the ledger row must stay: no notice.
    expect(w.deletedFires).toHaveLength(0);
    expect(existsSync(gitdir)).toBe(true);
    // The tombstone is kept: the agent is gone even if its bytes are not.
    await expect(w.write('agent-a', 'late.md', 'x')).rejects.toMatchObject({ code: 'agent-deleted' });
  });

  it('(f) an agent that never wrote: quiet no-op that still fires workspace:deleted (releases a stray ledger row)', async () => {
    const w = await setup();
    await w.write('agent-b', 'b.md', 'bystander');
    const before = readdirSync(w.repoRoot).sort();

    const result = await w.deleteAgent(deletedPayload('agent-never-wrote'));

    expect(result.rejected).toBe(false);
    expect(w.deletedFires).toStrictEqual([{ agentId: 'agent-never-wrote' }]);
    expect(readdirSync(w.repoRoot).sort()).toEqual(before);
    expect(w.logs.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  describe('(g) a malformed agentId never deletes anything and never throws', () => {
    async function seedBystanders() {
      const w = await setup();
      const { version: bV1 } = await w.write('agent-b', 'b.md', 'bystander');
      // Siblings of repoRoot that a joined-raw-id path would reach.
      for (const name of ['x', 'x.git']) {
        mkdirSync(join(w.outer, name));
        writeFileSync(join(w.outer, name, 'sentinel'), 'do not delete');
      }
      const rootBefore = readdirSync(w.repoRoot).sort();
      const assertIntact = () => {
        expect(existsSync(join(w.outer, 'x', 'sentinel'))).toBe(true);
        expect(existsSync(join(w.outer, 'x.git', 'sentinel'))).toBe(true);
        expect(existsSync(w.repoRoot)).toBe(true);
        expect(readdirSync(w.repoRoot).sort()).toEqual(rootBefore);
        expect(existsSync(w.gitdirOf('agent-b'))).toBe(true);
      };
      return { w, bV1, assertIntact };
    }

    const invalid: ReadonlyArray<[string, unknown]> = [
      ['empty string', deletedPayload('')],
      ['whitespace only', deletedPayload('   ')],
      ['undefined', deletedPayload(undefined)],
      ['a number', deletedPayload(42)],
      ['missing agentId', { ownerId: 'user-1', ownerType: 'user' }],
      ['a null payload', null],
    ];
    for (const [label, payload] of invalid) {
      it(`${label}: logs a warning, deletes nothing, fires nothing, lets the fan-out continue`, async () => {
        const { w, bV1, assertIntact } = await seedBystanders();
        const result = await w.deleteAgent(payload);
        expect(result.rejected).toBe(false);
        expect(w.laterSubscriberSaw).toHaveLength(1);
        assertIntact();
        expect(w.deletedFires).toEqual([]);
        expect(w.logs.some((l) => l.level === 'warn')).toBe(true);
        // A malformed id never became a tombstone for some other agent.
        await expect(w.write('agent-b', 'b2.md', 'fine', bV1)).resolves.toBeDefined();
      });
    }

    for (const agentId of ['../x', '../x.git', '..', '/']) {
      it(`path-shaped id ${JSON.stringify(agentId)} is hashed, never joined: nothing outside its own hashed repo is touched`, async () => {
        const { w, assertIntact } = await seedBystanders();
        const result = await w.deleteAgent(deletedPayload(agentId));
        expect(result.rejected).toBe(false);
        expect(w.laterSubscriberSaw).toHaveLength(1);
        assertIntact();
        // It is a non-empty string, so it is a (never-written) agent like any
        // other: its hashed repo -- which never existed -- is "removed".
        expect(w.deletedFires).toStrictEqual([{ agentId }]);
      });
    }
  });

  it('(h) the subscriber returns undefined: the payload passes through unchanged and later cleanup subscribers still run', async () => {
    const w = await setup();
    await w.write('agent-a', 'a.md', 'one');
    const payload = deletedPayload('agent-a');

    const result = await w.deleteAgent(payload);

    expect(result).toStrictEqual({ rejected: false, payload });
    // Same object, not a transformed copy: a returned value would replace it.
    expect((result as { payload: unknown }).payload).toBe(payload);
    expect(w.laterSubscriberSaw).toEqual([payload]);
    // Anti-vacuity: the backend's subscriber really ran (with no subscriber
    // at all, everything above would hold trivially).
    expect(existsSync(w.gitdirOf('agent-a'))).toBe(false);
    expect(w.deletedFires).toHaveLength(1);
  });
});
