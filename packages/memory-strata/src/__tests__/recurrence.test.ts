// Recurrence gate (TASK-187): skill-crystallization fires only when a procedure
// recurred across ≥2 DISTINCT conversations. These tests pin BOTH the pure
// distinct-conversation arithmetic (recurrence.ts) AND the end-to-end materialization
// through a real consolidation pass (the on-disk `source_conversations` set the
// skill-reflection routine reads). The two load-bearing cases the design's walk
// re-run depends on:
//   - NEGATIVE: a procedure seen within a SINGLE conversation — even when it
//     produced ≥2 inbox observations/messages — must NOT satisfy the gate.
//   - POSITIVE: a procedure seen across ≥2 DISTINCT conversations satisfies it.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConsolidation } from '../consolidator.js';
import { listDocs } from '../doc-store.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { INBOX_DIR } from '../paths.js';
import {
  mergeConversationId,
  recurrenceCount,
  meetsRecurrenceGate,
  distinctConversations,
  RECURRENCE_THRESHOLD,
} from '../recurrence.js';
import type { MemoryFrontmatter } from '../types.js';

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-recurrence-'));
});

async function writeInboxFixture(
  filename: string,
  fm: MemoryFrontmatter,
  body: string,
): Promise<void> {
  const dir = join(workspaceRoot, INBOX_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), buildMarkdownFile(fm, body), 'utf8');
}

function obsFm(over: Partial<MemoryFrontmatter> & { id: string }): MemoryFrontmatter {
  const now = '2026-06-08T12:00:00.000Z';
  return {
    type: 'inbox/observation',
    created: now,
    confidence: 0.85,
    pinned: false,
    summary: 'placeholder',
    subject: 'deploy-procedure',
    factType: 'general',
    source_messages: 1,
    event_time: now,
    recorded_at: now,
    ...over,
  };
}

describe('recurrence helper (pure)', () => {
  it('mergeConversationId dedups and preserves first-seen order; ignores undefined/empty', () => {
    expect(mergeConversationId(undefined, 'c1')).toEqual(['c1']);
    expect(mergeConversationId(['c1'], 'c2')).toEqual(['c1', 'c2']);
    // A repeat from an already-seen conversation does NOT grow the set.
    expect(mergeConversationId(['c1', 'c2'], 'c1')).toEqual(['c1', 'c2']);
    // undefined / empty contribute nothing (can't prove a distinct conversation).
    expect(mergeConversationId(['c1'], undefined)).toEqual(['c1']);
    expect(mergeConversationId(['c1'], '')).toEqual(['c1']);
    // Never mutates the input.
    const input = ['c1'];
    mergeConversationId(input, 'c2');
    expect(input).toEqual(['c1']);
  });

  it('recurrenceCount / meetsRecurrenceGate read source_conversations; missing → 0', () => {
    expect(RECURRENCE_THRESHOLD).toBe(2);
    expect(recurrenceCount({ source_conversations: undefined })).toBe(0);
    expect(recurrenceCount({ source_conversations: ['c1'] })).toBe(1);
    expect(recurrenceCount({ source_conversations: ['c1', 'c2'] })).toBe(2);
    expect(distinctConversations({ source_conversations: undefined })).toEqual([]);

    expect(meetsRecurrenceGate({ source_conversations: undefined })).toBe(false);
    expect(meetsRecurrenceGate({ source_conversations: ['c1'] })).toBe(false);
    expect(meetsRecurrenceGate({ source_conversations: ['c1', 'c2'] })).toBe(true);
    expect(meetsRecurrenceGate({ source_conversations: ['c1', 'c2', 'c3'] })).toBe(true);
  });
});

describe('recurrence gate — end-to-end through a real consolidation pass', () => {
  it('NEGATIVE: a one-off in a SINGLE conversation (even with ≥2 observations) does NOT meet the gate', async () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    // Two DISTINCT-summary observations, same conversation — the per-message
    // observer fires twice in one conversation. Distinct enough to both promote
    // (so the doc holds 2 facts / 2 source_observations) but they share ONE
    // conversation, so the distinct-conversation count must stay 1.
    await writeInboxFixture(
      '2026-06-08T12-00-00.000Z-00-a.md',
      obsFm({ id: 'obs-a', summary: 'Run the migration before deploying', conversation_id: 'conv-1' }),
      '# Observation\n\nRun the migration before deploying\n',
    );
    await writeInboxFixture(
      '2026-06-08T12-00-01.000Z-00-b.md',
      obsFm({ id: 'obs-b', summary: 'Smoke-test staging then promote to prod', conversation_id: 'conv-1' }),
      '# Observation\n\nSmoke-test staging then promote to prod\n',
    );

    await runConsolidation({ workspaceRoot, now });

    const docs = await listDocs({ workspaceRoot });
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    // Both observations merged (2 source observations) ...
    expect(doc.frontmatter.source_observations).toEqual(['obs-a', 'obs-b']);
    // ... but only ONE distinct conversation → gate NOT met. This is the
    // crux: a naive `source_observations.length >= 2` gate would wrongly fire.
    expect(distinctConversations(doc.frontmatter)).toEqual(['conv-1']);
    expect(recurrenceCount(doc.frontmatter)).toBe(1);
    expect(meetsRecurrenceGate(doc.frontmatter)).toBe(false);
  });

  it('NEGATIVE: a near-duplicate restatement WITHIN the same conversation does NOT inflate recurrence', async () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    // Same fact, restated in the same conversation → second is a dedup hit.
    await writeInboxFixture(
      '2026-06-08T12-00-00.000Z-00-a.md',
      obsFm({ id: 'obs-a', summary: 'Always run the migration before deploying', conversation_id: 'conv-1' }),
      '# Observation\n\nAlways run the migration before deploying\n',
    );
    await writeInboxFixture(
      '2026-06-08T12-00-01.000Z-00-b.md',
      obsFm({ id: 'obs-b', summary: 'Always run the migration before deploying', conversation_id: 'conv-1' }),
      '# Observation\n\nAlways run the migration before deploying\n',
    );

    const result = await runConsolidation({ workspaceRoot, now });
    expect(result.dupesMerged).toBe(1);

    const docs = await listDocs({ workspaceRoot });
    expect(docs).toHaveLength(1);
    // The dedup path folded the conversation id, but it was already present →
    // still ONE distinct conversation → gate NOT met.
    expect(recurrenceCount(docs[0]!.frontmatter)).toBe(1);
    expect(meetsRecurrenceGate(docs[0]!.frontmatter)).toBe(false);
  });

  it('POSITIVE: a procedure seen across 2 DISTINCT conversations MEETS the gate', async () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    await writeInboxFixture(
      '2026-06-08T12-00-00.000Z-00-a.md',
      obsFm({ id: 'obs-a', summary: 'Run the migration before deploying', conversation_id: 'conv-1' }),
      '# Observation\n\nRun the migration before deploying\n',
    );
    await writeInboxFixture(
      '2026-06-08T12-00-01.000Z-00-b.md',
      obsFm({ id: 'obs-b', summary: 'Smoke-test staging then promote to prod', conversation_id: 'conv-2' }),
      '# Observation\n\nSmoke-test staging then promote to prod\n',
    );

    await runConsolidation({ workspaceRoot, now });

    const docs = await listDocs({ workspaceRoot });
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(distinctConversations(doc.frontmatter)).toEqual(['conv-1', 'conv-2']);
    expect(recurrenceCount(doc.frontmatter)).toBe(2);
    expect(meetsRecurrenceGate(doc.frontmatter)).toBe(true);
  });

  it('POSITIVE (dedup path): a near-duplicate restatement in a NEW conversation pushes recurrence to ≥2', async () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    // The SAME procedure stated in two distinct conversations as near-identical
    // summaries — the second is a Jaccard dedup hit, so it's NOT appended as a
    // fact. Without TASK-187's dedup-path conversation merge, conv-2 would be
    // dropped and recurrence would stall at 1. It must reach 2.
    await writeInboxFixture(
      '2026-06-08T12-00-00.000Z-00-a.md',
      obsFm({ id: 'obs-a', summary: 'Always run the migration before deploying', conversation_id: 'conv-1' }),
      '# Observation\n\nAlways run the migration before deploying\n',
    );
    await writeInboxFixture(
      '2026-06-08T12-00-01.000Z-00-b.md',
      obsFm({ id: 'obs-b', summary: 'Always run the migration before deploying', conversation_id: 'conv-2' }),
      '# Observation\n\nAlways run the migration before deploying\n',
    );

    const result = await runConsolidation({ workspaceRoot, now });
    expect(result.dupesMerged).toBe(1);

    const docs = await listDocs({ workspaceRoot });
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    // Only one fact (the dupe wasn't appended) ...
    expect(doc.frontmatter.source_observations).toEqual(['obs-a']);
    // ... but TWO distinct conversations folded in → gate MET.
    expect(distinctConversations(doc.frontmatter)).toEqual(['conv-1', 'conv-2']);
    expect(meetsRecurrenceGate(doc.frontmatter)).toBe(true);
  });

  it('back-compat: observations with NO conversation_id leave source_conversations empty', async () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    // Pre-TASK-187 inbox files / ephemeral contexts carry no conversation_id.
    await writeInboxFixture(
      '2026-06-08T12-00-00.000Z-00-a.md',
      obsFm({ id: 'obs-a', summary: 'Run the migration before deploying' }),
      '# Observation\n\nRun the migration before deploying\n',
    );
    await writeInboxFixture(
      '2026-06-08T12-00-01.000Z-00-b.md',
      obsFm({ id: 'obs-b', summary: 'Smoke-test staging then promote to prod' }),
      '# Observation\n\nSmoke-test staging then promote to prod\n',
    );

    await runConsolidation({ workspaceRoot, now });

    const docs = await listDocs({ workspaceRoot });
    expect(docs).toHaveLength(1);
    // No conversation ids → empty distinct set → gate never met from unkeyed obs.
    expect(distinctConversations(docs[0]!.frontmatter)).toEqual([]);
    expect(meetsRecurrenceGate(docs[0]!.frontmatter)).toBe(false);
  });

  it('a NEW distinct conversation appended across passes grows recurrence to ≥2', async () => {
    // Pass 1: conv-1 promotes a doc.
    await writeInboxFixture(
      '2026-06-08T12-00-00.000Z-00-a.md',
      obsFm({ id: 'obs-a', summary: 'Run the migration before deploying', conversation_id: 'conv-1' }),
      '# Observation\n\nRun the migration before deploying\n',
    );
    await runConsolidation({ workspaceRoot, now: new Date('2026-06-08T12:00:00.000Z') });
    let docs = await listDocs({ workspaceRoot });
    expect(meetsRecurrenceGate(docs[0]!.frontmatter)).toBe(false);

    // Pass 2 (a later day, same workspace): conv-2 appends a distinct fact.
    await writeInboxFixture(
      '2026-06-09T12-00-00.000Z-00-c.md',
      obsFm({
        id: 'obs-c',
        created: '2026-06-09T12:00:00.000Z',
        event_time: '2026-06-09T12:00:00.000Z',
        recorded_at: '2026-06-09T12:00:00.000Z',
        summary: 'Smoke-test staging then promote to prod',
        conversation_id: 'conv-2',
      }),
      '# Observation\n\nSmoke-test staging then promote to prod\n',
    );
    await runConsolidation({ workspaceRoot, now: new Date('2026-06-09T12:00:00.000Z') });
    docs = await listDocs({ workspaceRoot });
    expect(distinctConversations(docs[0]!.frontmatter)).toEqual(['conv-1', 'conv-2']);
    expect(meetsRecurrenceGate(docs[0]!.frontmatter)).toBe(true);
  });
});
