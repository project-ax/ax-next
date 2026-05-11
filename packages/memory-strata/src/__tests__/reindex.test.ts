// Tests for the re-indexer subscriber (Phase 2B, Task 2B.6).
//
// WHY real filesystem: the reindexer's correctness depends on the full
// readDoc round-trip returning canonical frontmatter. Stubbing readDoc
// would test only the wiring, not the I18 guarantee (index reflects disk).
// All tests use mkdtemp workspaces and a fresh HookBus per test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import { writeNewDoc } from '../doc-store.js';
import { registerReindexer } from '../reindex.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-reindex-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** Build an AgentContext wired to the temp workspace. */
function makeCtx(_bus: HookBus) {
  return makeAgentContext({
    sessionId: 'sess-reindex',
    agentId: 'agent-reindex',
    userId: 'user-reindex',
    workspace: { rootPath: workspaceRoot },
  });
}

/** Write a minimal promotable doc to the workspace. */
async function seedDoc(opts: {
  category: 'preference' | 'entity' | 'decision' | 'episode' | 'general';
  slug: string;
  summary: string;
  factType?: string;
  facts?: string[];
}) {
  return writeNewDoc({
    workspaceRoot,
    category: opts.category,
    slug: opts.slug,
    summary: opts.summary,
    subject: opts.slug,
    factType: opts.factType ?? 'preference',
    confidence: 0.85,
    sourceObservationIds: ['obs-1'],
    now: new Date('2026-05-11T00:00:00.000Z'),
    facts: opts.facts ?? [opts.summary],
  });
}

/** Captured upsert call shape (mirrors the memory:index:upsert payload). */
interface UpsertCall {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  factType: string;
  body: string;
  headers: string;
}

/**
 * Register a no-op `memory:index:upsert` service that captures calls.
 * Returns the array of captured calls (mutated in-place as calls arrive).
 */
function registerUpsertCapture(bus: HookBus): UpsertCall[] {
  const calls: UpsertCall[] = [];
  bus.registerService('memory:index:upsert', '@ax/memory-strata-index-stub', async (_ctx, payload) => {
    calls.push(payload as UpsertCall);
    return {};
  });
  return calls;
}

/**
 * Fire a `memory:doc:written` event on the bus and wait for all subscribers
 * to complete.
 */
async function fireDocWritten(
  bus: HookBus,
  ctx: ReturnType<typeof makeAgentContext>,
  payload: {
    docId: string;
    category: string;
    slug: string;
    kind: 'created' | 'updated';
    summary: string;
  },
) {
  await bus.fire('memory:doc:written', ctx, payload);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerReindexer', () => {
  it('happy path created — calls memory:index:upsert with canonical doc content', async () => {
    const bus = new HookBus();
    const ctx = makeCtx(bus);
    const calls = registerUpsertCapture(bus);
    registerReindexer(bus);

    await seedDoc({
      category: 'preference',
      slug: 'react',
      summary: 'User prefers React',
      factType: 'preference',
    });

    await fireDocWritten(bus, ctx, {
      docId: 'preference/react',
      category: 'preference',
      slug: 'react',
      kind: 'created',
      summary: 'User prefers React',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      docId: 'preference/react',
      category: 'preference',
      slug: 'react',
      summary: 'User prefers React',
      factType: 'preference',
    });
    // Body must contain the canonical fact written by writeNewDoc.
    expect(calls[0]!.body).toContain('User prefers React');
  });

  it('happy path updated — same assertions hold for kind:updated', async () => {
    const bus = new HookBus();
    const ctx = makeCtx(bus);
    const calls = registerUpsertCapture(bus);
    registerReindexer(bus);

    await seedDoc({
      category: 'entity',
      slug: 'typescript',
      summary: 'User prefers TypeScript',
      factType: 'preference',
    });

    await fireDocWritten(bus, ctx, {
      docId: 'entity/typescript',
      category: 'entity',
      slug: 'typescript',
      kind: 'updated',
      summary: 'User prefers TypeScript',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      docId: 'entity/typescript',
      category: 'entity',
      slug: 'typescript',
      factType: 'preference',
    });
    expect(calls[0]!.body).toContain('User prefers TypeScript');
  });

  it('doc-missing on disk — skips upsert, no exception thrown', async () => {
    const bus = new HookBus();
    const ctx = makeCtx(bus);
    const calls = registerUpsertCapture(bus);
    registerReindexer(bus);

    // Deliberately do NOT write the doc to disk.
    await expect(
      fireDocWritten(bus, ctx, {
        docId: 'preference/missing',
        category: 'preference',
        slug: 'missing',
        kind: 'created',
        summary: 'Phantom doc',
      }),
    ).resolves.not.toThrow();

    expect(calls).toHaveLength(0);
  });

  it('upsert hook throws (I22) — exception does not propagate to fire() resolver', async () => {
    const bus = new HookBus();
    const ctx = makeCtx(bus);

    // Register an upsert service that always throws.
    bus.registerService('memory:index:upsert', '@ax/memory-strata-index-stub', async () => {
      throw new Error('upsert kaboom');
    });

    registerReindexer(bus);

    await seedDoc({
      category: 'preference',
      slug: 'vue',
      summary: 'User knows Vue',
    });

    // fire() must resolve without throwing even though the upsert threw.
    await expect(
      fireDocWritten(bus, ctx, {
        docId: 'preference/vue',
        category: 'preference',
        slug: 'vue',
        kind: 'created',
        summary: 'User knows Vue',
      }),
    ).resolves.not.toThrow();
  });

  it('headers extraction — headings in doc body appear in upsert headers field', async () => {
    const bus = new HookBus();
    const ctx = makeCtx(bus);
    const calls = registerUpsertCapture(bus);
    registerReindexer(bus);

    // writeNewDoc generates `# Doc\n\n## Facts\n- ...\n`. We verify that
    // the extractor captures both headings.
    await seedDoc({
      category: 'general',
      slug: 'multi-heading',
      summary: 'Doc with multiple headings',
      facts: ['Some fact'],
    });

    await fireDocWritten(bus, ctx, {
      docId: 'general/multi-heading',
      category: 'general',
      slug: 'multi-heading',
      kind: 'created',
      summary: 'Doc with multiple headings',
    });

    expect(calls).toHaveLength(1);
    // The default body from writeNewDoc has `# Doc` and `## Facts`.
    expect(calls[0]!.headers).toBe('Doc\nFacts');
  });

  it('no indexer registered (graceful) — fire() resolves, no crash', async () => {
    const bus = new HookBus();
    const ctx = makeCtx(bus);
    // Intentionally do NOT register memory:index:upsert.
    registerReindexer(bus);

    await seedDoc({
      category: 'decision',
      slug: 'no-indexer',
      summary: 'Decision with no indexer',
    });

    // The reindexer's catch block swallows the HookBus no-service error.
    await expect(
      fireDocWritten(bus, ctx, {
        docId: 'decision/no-indexer',
        category: 'decision',
        slug: 'no-indexer',
        kind: 'created',
        summary: 'Decision with no indexer',
      }),
    ).resolves.not.toThrow();
  });
});
