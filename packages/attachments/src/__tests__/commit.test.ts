import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';
// Test-only cross-plugin import (eslint no-restricted-imports is OFF in
// __tests__): we drive the REAL single-replica workspace backend through the
// attachments commit path to prove the parent-mismatch → rebase recovery works
// end-to-end against a real backend, not just a mock that echoes actualParent.
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';
import {
  runAttachmentsMigration,
  type AttachmentsDatabase,
} from '../migrations.js';
import { createAttachmentsStore } from '../store.js';
import { createCommitHandler } from '../handlers.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<AttachmentsDatabase>[] = [];

function makeKysely(): Kysely<AttachmentsDatabase> {
  const k = new Kysely<AttachmentsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

function makeCtx(userId: string) {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId,
  });
}

interface ApplyCall {
  ctx: ReturnType<typeof makeCtx>;
  input: { changes: Array<{ path: string; kind: 'put' | 'delete'; content?: Uint8Array }>; parent: string | null; reason?: string };
}

function makeBusWithApply(
  apply: (input: ApplyCall['input']) => Promise<{ version: string; delta: unknown }>,
): { bus: HookBus; calls: ApplyCall[] } {
  const bus = new HookBus();
  const calls: ApplyCall[] = [];
  bus.registerService<ApplyCall['input'], { version: string; delta: unknown }>(
    'workspace:apply',
    'test-mock',
    async (ctx, input) => {
      calls.push({ ctx, input });
      return apply(input);
    },
  );
  return { bus, calls };
}

async function freshSetup() {
  const db = makeKysely();
  await runAttachmentsMigration(db);
  const store = createAttachmentsStore(db);
  return { store };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('attachments_v1_temps').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('attachments:commit handler', () => {
  it('commits a staged temp to the workspace and returns metadata', async () => {
    const { store } = await freshSetup();
    const { bus, calls } = makeBusWithApply(async () => ({
      version: 'v-after',
      delta: { before: 'v-before', after: 'v-after', changes: [] },
    }));
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-100', userId: 'u-1',
      bytes: Buffer.from('hello world'),
      displayName: 'greeting.txt', mediaType: 'text/plain',
      sizeBytes: 11,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const ctx = makeCtx('u-1');
    const result = await handler(ctx, {
      attachmentId: 'a-100',
      conversationId: 'c-1',
      turnId: 't-1',
    });

    expect(result.path).toMatch(/^\.ax\/uploads\/c-1\/t-1\/[a-f0-9]{8}__greeting\.txt$/);
    // sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    expect(result.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(result.mediaType).toBe('text/plain');
    expect(result.sizeBytes).toBe(11);
    expect(result.displayName).toBe('greeting.txt');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.changes).toHaveLength(1);
    expect(calls[0]!.input.changes[0]!.kind).toBe('put');
    expect(calls[0]!.input.changes[0]!.path).toBe(result.path);
    const content = calls[0]!.input.changes[0]!.content!;
    expect(Buffer.from(content).toString()).toBe('hello world');
    expect(calls[0]!.input.parent).toBeNull();

    const afterRow = await store.getTemp('a-100');
    expect(afterRow).toBeNull();
  });

  it('rejects unknown attachmentId with not-found', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await expect(
      handler(makeCtx('u-1'), {
        attachmentId: 'does-not-exist',
        conversationId: 'c-1',
        turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects expired attachmentId with not-found', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-expired', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: 'x', mediaType: 'text/plain',
      sizeBytes: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      handler(makeCtx('u-1'), {
        attachmentId: 'a-expired', conversationId: 'c-1', turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects cross-user redemption with forbidden and leaves the temp row intact', async () => {
    const { store } = await freshSetup();
    const { bus, calls } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-foreign', userId: 'u-victim',
      bytes: Buffer.from('secret'), displayName: 'secret.txt',
      mediaType: 'text/plain', sizeBytes: 6,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      handler(makeCtx('u-attacker'), {
        attachmentId: 'a-foreign', conversationId: 'c-1', turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The attacker's call never reached workspace:apply.
    expect(calls).toHaveLength(0);

    // Temp row preserved.
    // Note: getTemp's expiry filter requires us to use a direct query OR
    // check via the still-valid expiresAt. The row was inserted with +60s,
    // so getTemp should still return it.
    const stillThere = await store.getTemp('a-foreign');
    expect(stillThere).not.toBeNull();
  });

  it('sanitizes the on-disk filename component but preserves the displayName', async () => {
    const { store } = await freshSetup();
    const { bus, calls } = makeBusWithApply(async () => ({
      version: 'v', delta: { before: null, after: 'v', changes: [] },
    }));
    const handler = createCommitHandler({ store, bus });

    const hostileName = '../../etc/passwd ; rm -rf /.txt';
    await store.insertTemp({
      attachmentId: 'a-weird', userId: 'u-1',
      bytes: Buffer.from('x'),
      displayName: hostileName,
      mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await handler(makeCtx('u-1'), {
      attachmentId: 'a-weird', conversationId: 'c-1', turnId: 't-1',
    });

    expect(result.path).not.toContain('..');
    expect(result.path).not.toContain(' ');
    expect(result.path).not.toContain(';');
    expect(result.path.startsWith('.ax/uploads/c-1/t-1/')).toBe(true);
    expect(result.displayName).toBe(hostileName);

    // The path passed to workspace:apply matches what we returned.
    expect(calls[0]!.input.changes[0]!.path).toBe(result.path);
  });

  it('deletes the temp row after a successful workspace:apply', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-del', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: 'x.txt',
      mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await handler(makeCtx('u-1'), {
      attachmentId: 'a-del', conversationId: 'c-1', turnId: 't-1',
    });

    expect(await store.getTemp('a-del')).toBeNull();
  });

  it('rebases on workspace:apply parent-mismatch and re-applies', async () => {
    const { store } = await freshSetup();
    let attempt = 0;
    const seenParents: Array<string | null> = [];
    const bus = new HookBus();
    bus.registerService<ApplyCall['input'], { version: string; delta: unknown }>(
      'workspace:apply',
      'test-mock',
      async (_ctx, input) => {
        seenParents.push(input.parent);
        if (attempt++ === 0) {
          throw new PluginError({
            code: 'parent-mismatch',
            plugin: 'test-mock',
            message: 'mirror has commits; caller passed parent: null',
            cause: { actualParent: 'v-current' },
          });
        }
        return { version: 'v-after', delta: { before: 'v-current', after: 'v-after', changes: [] } };
      },
    );
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-rebase', userId: 'u-1',
      bytes: Buffer.from('hello'),
      displayName: 'h.txt', mediaType: 'text/plain',
      sizeBytes: 5,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await handler(makeCtx('u-1'), {
      attachmentId: 'a-rebase',
      conversationId: 'c-1',
      turnId: 't-1',
    });

    expect(result.path).toMatch(/h\.txt$/);
    expect(attempt).toBe(2);
    expect(seenParents).toEqual([null, 'v-current']);
  });

  it('bails out after a bounded number of parent-mismatch retries', async () => {
    const { store } = await freshSetup();
    let attempts = 0;
    const bus = new HookBus();
    bus.registerService<ApplyCall['input'], { version: string; delta: unknown }>(
      'workspace:apply',
      'test-mock',
      async () => {
        attempts++;
        // Always echo a NEW parent so the retry guard ("same parent twice")
        // never trips — proves the retry cap fires independently.
        throw new PluginError({
          code: 'parent-mismatch',
          plugin: 'test-mock',
          message: 'churning',
          cause: { actualParent: `v-${attempts}` },
        });
      },
    );
    const handler = createCommitHandler({ store, bus });

    await store.insertTemp({
      attachmentId: 'a-loop', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: 'x.txt', mediaType: 'text/plain',
      sizeBytes: 1, expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      handler(makeCtx('u-1'), {
        attachmentId: 'a-loop', conversationId: 'c-1', turnId: 't-1',
      }),
    ).rejects.toMatchObject({ code: 'parent-mismatch' });
    // 5 bounded attempts.
    expect(attempts).toBe(5);
  });

  it('throws PluginError instances (not plain Errors)', async () => {
    const { store } = await freshSetup();
    const { bus } = makeBusWithApply(async () => ({ version: 'v', delta: {} }));
    const handler = createCommitHandler({ store, bus });
    try {
      await handler(makeCtx('u-1'), {
        attachmentId: 'does-not-exist',
        conversationId: 'c-1',
        turnId: 't-1',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
    }
  });
});

// Test-only Plugin shim for the REAL single-replica backend (modeled on
// packages/workspace-git-core/src/__tests__/contract.test.ts). The manifest's
// `registers` lists the public `workspace:apply` facade + the internal hooks
// registerWorkspaceGitHooks installs.
function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-attachments-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-internal',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot });
    },
  };
}

describe('attachments:commit against the REAL single-replica workspace-git-core backend (F-1 sibling)', () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const repoRoots: string[] = [];

  afterEach(async () => {
    for (const r of repoRoots.splice(0)) {
      await rm(r, { recursive: true, force: true });
    }
  });

  async function makeRealBackendBus(): Promise<HookBus> {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-attach-core-'));
    repoRoots.push(repoRoot);
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [makeCorePlugin(repoRoot)], config: {} });
    return bus;
  }

  it('recovers from parent-mismatch by rebasing on the echoed actualParent and commits the attachment', async () => {
    const { store } = await freshSetup();
    const bus = await makeRealBackendBus();
    const ctx = makeCtx('u-real');

    // Advance the shared mirror OUT OF BAND first (as a prior turn or another
    // attachment would), so the head is non-null. The commit handler starts at
    // parent:null and must rebase onto this head via the backend's echoed
    // actualParent — exactly the production single-replica scenario.
    const seed = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx,
      {
        changes: [{ path: '.ax/seed', kind: 'put', content: enc.encode('prior turn') }],
        parent: null,
      },
    );
    const v1 = seed.version;
    expect(v1).toMatch(/^[0-9a-f]{40}$/);

    await store.insertTemp({
      attachmentId: 'a-real',
      userId: 'u-real',
      bytes: Buffer.from('hello world'),
      displayName: 'greeting.txt',
      mediaType: 'text/plain',
      sizeBytes: 11,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const handler = createCommitHandler({ store, bus });

    // Pre-fix: the real backend throws parent-mismatch with NO cause, so the
    // handler's retry guard (`'actualParent' in err.cause`) is false → it
    // re-throws and this call REJECTS (the production 500). Post-fix: the
    // backend echoes actualParent=v1, the handler rebases and commits at a
    // child of v1.
    const result = await handler(ctx, {
      attachmentId: 'a-real',
      conversationId: 'c-real',
      turnId: 't-1',
    });

    expect(result.path).toMatch(
      /^\.ax\/uploads\/c-real\/t-1\/[a-f0-9]{8}__greeting\.txt$/,
    );

    // The attachment landed in the workspace at the rebased head.
    const readAttachment = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      { path: result.path },
    );
    expect(readAttachment.found).toBe(true);
    if (readAttachment.found) {
      expect(dec.decode(readAttachment.bytes)).toBe('hello world');
    }

    // The out-of-band seed (v1) survived — proving the handler rebased ONTO it
    // rather than clobbering history with a fresh parent:null commit.
    const readSeed = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      { path: '.ax/seed' },
    );
    expect(readSeed.found).toBe(true);

    // The temp row is consumed only on a successful apply.
    expect(await store.getTemp('a-real')).toBeNull();
  });
});
