// End-to-end consolidation test.
//
// WHY real round-trips: the consolidator's correctness depends on every
// helper (cluster, dedup, doc-store, inbox-store, promotion, recent)
// behaving correctly as a unit. Stubbing any of them would give us a
// unit test of the orchestrator wiring — not a test that proves the full
// pass produces the right on-disk state. Real filesystem round-trips are
// the only way to exercise the I11/I12/I13 invariants together.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus, makeAgentContext } from '@ax/core';
import { runConsolidation, type ConsolidationLogger } from '../consolidator.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { INBOX_DIR, MEMORY_ROOT } from '../paths.js';
import type { MemoryFrontmatter } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-consolidator-'));
});

/** Write an inbox observation file via buildMarkdownFile — real round-trip, no stubs. */
async function writeInboxFixture(
  filename: string,
  fm: MemoryFrontmatter,
  body: string,
): Promise<string> {
  const dir = join(workspaceRoot, INBOX_DIR);
  await mkdir(dir, { recursive: true });
  const abs = join(dir, filename);
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
  return `${INBOX_DIR}/${filename}`;
}

/** Build a simple logger spy that records all calls. */
function makeLoggerSpy(): ConsolidationLogger & {
  infoCalls: Array<{ event: string; fields: Record<string, unknown> }>;
  warnCalls: Array<{ event: string; fields: Record<string, unknown> }>;
} {
  const infoCalls: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const warnCalls: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return {
    infoCalls,
    warnCalls,
    info(event, fields) { infoCalls.push({ event, fields }); },
    warn(event, fields) { warnCalls.push({ event, fields }); },
  };
}

// ---------------------------------------------------------------------------
// The four-fixture end-to-end test
// ---------------------------------------------------------------------------

describe('consolidator', () => {
  it('end-to-end: promotes, quarantines, leaves low-confidence, regenerates recent', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    // --- Fixture 1: React observation #1 (confidence 0.85, different summary)
    const react1Path = await writeInboxFixture(
      '2026-05-10T12-00-00.000Z-react-1.md',
      {
        id: 'obs-react-1',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User prefers React',
        subject: 'react',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser prefers React\n',
    );

    // --- Fixture 2: React observation #2 (confidence 0.85, distinct summary)
    // "User prefers React" vs "User has used React for 5+ years" have enough
    // distinct tokens that Jaccard similarity is well below 0.6 — both promote.
    const react2Path = await writeInboxFixture(
      '2026-05-10T12-00-01.000Z-react-2.md',
      {
        id: 'obs-react-2',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User has used React for 5+ years',
        subject: 'react',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser has used React for 5+ years\n',
    );

    // --- Fixture 3: project-alpha (confidence 0.5 — below 0.7 threshold)
    const alphaPath = await writeInboxFixture(
      '2026-05-10T12-00-02.000Z-alpha.md',
      {
        id: 'obs-alpha',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.5,
        pinned: false,
        summary: 'Working on project-alpha feature',
        subject: 'project-alpha',
        factType: 'general',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nWorking on project-alpha feature\n',
    );

    // --- Fixture 4: fake-credentials (high confidence, but body contains a
    // credential that should trigger I11 quarantine at promotion-time).
    // The fake key must be 21+ chars after `sk-ant-` to match the regex.
    const credPath = await writeInboxFixture(
      '2026-05-10T12-00-03.000Z-creds.md',
      {
        id: 'obs-creds',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.9,
        pinned: false,
        summary: 'Found credentials in config',
        subject: 'fake-credentials',
        factType: 'general',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nThe API key is sk-ant-ABCDEFGHIJKLMNOPQRSTU\n',
    );

    const logger = makeLoggerSpy();
    const result = await runConsolidation({ workspaceRoot, now, logger });

    // --- Assert result counts ---
    // promoted=2 (react1 + react2), dupesMerged=0, quarantined=1 (creds),
    // leftInInbox=1 (alpha), decayed=0 (all files created NOW).
    expect(result).toEqual({
      promoted: 2,
      dupesMerged: 0,
      quarantined: 1,
      leftInInbox: 1,
      decayed: 0,
    });

    // --- Assert docs/preference/react.md exists with both facts merged ---
    const reactDocPath = join(
      workspaceRoot,
      'permanent/memory/docs/preference/react.md',
    );
    const reactDoc = await readFile(reactDocPath, 'utf8');
    // Fixtures carry event_time === now, so promoted facts render dated.
    expect(reactDoc).toContain('- (2026-05-10) User prefers React');
    expect(reactDoc).toContain('- (2026-05-10) User has used React for 5+ years');
    // source_observations must contain both inbox IDs (length 2).
    expect(reactDoc).toContain('obs-react-1');
    expect(reactDoc).toContain('obs-react-2');

    // --- Assert docs/general/project-alpha.md does NOT exist ---
    const alphaDocPath = join(
      workspaceRoot,
      'permanent/memory/docs/general/project-alpha.md',
    );
    await expect(stat(alphaDocPath)).rejects.toThrow(/ENOENT/);

    // --- Assert project-alpha inbox file still exists (left in inbox) ---
    await expect(stat(join(workspaceRoot, alphaPath))).resolves.toBeTruthy();

    // --- Assert credential file was MOVED to quarantine (not deleted) ---
    const credFilename = '2026-05-10T12-00-03.000Z-creds.md';
    const quarantineDest = join(
      workspaceRoot,
      `${MEMORY_ROOT}/quarantine/${credFilename}`,
    );
    // Quarantine destination must exist.
    await expect(stat(quarantineDest)).resolves.toBeTruthy();
    // Original inbox path must be gone.
    await expect(stat(join(workspaceRoot, credPath))).rejects.toThrow(/ENOENT/);

    // --- Assert memory_strata_promotion_quarantined was logged ---
    const quarantinedWarnings = logger.warnCalls.filter(
      (c) => c.event === 'memory_strata_promotion_quarantined',
    );
    expect(quarantinedWarnings).toHaveLength(1);
    expect(quarantinedWarnings[0]!.fields.inboxPath).toBe(credPath);

    // --- Assert both react inbox files were deleted (I12) ---
    await expect(stat(join(workspaceRoot, react1Path))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(workspaceRoot, react2Path))).rejects.toThrow(/ENOENT/);

    // --- Assert system/recent.md was regenerated (I13) ---
    const recentPath = join(workspaceRoot, 'permanent/memory/system/recent.md');
    await expect(stat(recentPath)).resolves.toBeTruthy();

    // --- Assert memory_strata_consolidation_complete was logged ---
    const completeCalls = logger.infoCalls.filter(
      (c) => c.event === 'memory_strata_consolidation_complete',
    );
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]!.fields).toMatchObject({
      promoted: 2,
      dupesMerged: 0,
      quarantined: 1,
      leftInInbox: 1,
      decayed: 0,
    });
  });

  it('returns zeroed counts when inbox is empty', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');
    const result = await runConsolidation({ workspaceRoot, now });
    expect(result).toEqual({
      promoted: 0,
      dupesMerged: 0,
      quarantined: 0,
      leftInInbox: 0,
      decayed: 0,
    });
    // recent.md should still be regenerated even on an empty pass.
    const recentPath = join(workspaceRoot, 'permanent/memory/system/recent.md');
    await expect(stat(recentPath)).resolves.toBeTruthy();
  });

  it('TASK-190: regenerates system/map.md after promotions, densified when a densifier is wired', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    await writeInboxFixture(
      'obs-map-1.md',
      {
        id: 'obs-map-1',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.9,
        pinned: false,
        summary: 'User prefers Tesla over BMW',
        subject: 'cars',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser prefers Tesla over BMW\n',
    );

    // Stub densifier: returns a one-liner that's recognizably the DENSIFIED
    // product (not the raw frontmatter summary), and records which docs it saw.
    const calls: string[] = [];
    const densifyMap = async (input: { docId: string; facts: string[] }) => {
      calls.push(input.docId);
      return `DENSIFIED[${input.facts.length}]: ${input.facts.join('; ')}`;
    };

    const result = await runConsolidation({ workspaceRoot, now, densifyMap });
    expect(result.promoted).toBe(1);

    const mapPath = join(workspaceRoot, 'permanent/memory/system/map.md');
    const map = await readFile(mapPath, 'utf8');
    // The map exists, is grouped by category, and carries the DENSIFIER's
    // output — proving regenerateMap ran the densifier rather than copying the
    // doc's raw frontmatter summary verbatim.
    expect(map).toContain('## preference/');
    // Fixture carries event_time === now, so the doc's fact (fed to the
    // densifier) is dated.
    expect(map).toContain('DENSIFIED[1]: (2026-05-10) User prefers Tesla over BMW');
    expect(calls).toEqual(['preference/cars']);
  });

  it('TASK-190: regenerates a (non-densified) map.md even with no densifier', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');
    const result = await runConsolidation({ workspaceRoot, now });
    expect(result.promoted).toBe(0);
    // map.md is regenerated on an empty pass too (always-injected placeholder).
    const mapPath = join(workspaceRoot, 'permanent/memory/system/map.md');
    const map = await readFile(mapPath, 'utf8');
    expect(map).toContain('# Memory Map');
  });

  it('dedup: second identical-summary observation from same subject merges, not promotes again', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    // Write two observations with virtually identical summaries (high Jaccard).
    for (const id of ['obs-dup-1', 'obs-dup-2']) {
      await writeInboxFixture(
        `${id}.md`,
        {
          id,
          type: 'inbox/observation',
          created: now.toISOString(),
          confidence: 0.85,
          pinned: false,
          summary: 'User prefers TypeScript over JavaScript',
          subject: 'typescript',
          factType: 'preference',
          event_time: now.toISOString(),
          recorded_at: now.toISOString(),
        },
        '# Observation\n\nUser prefers TypeScript over JavaScript\n',
      );
    }

    const result = await runConsolidation({ workspaceRoot, now });
    // First promotes, second deduplicates.
    expect(result.promoted).toBe(1);
    expect(result.dupesMerged).toBe(1);
    expect(result.leftInInbox).toBe(0);

    const docPath = join(workspaceRoot, 'permanent/memory/docs/preference/typescript.md');
    const doc = await readFile(docPath, 'utf8');
    // Only one fact line — the second was a dupe.
    const factLines = doc.split('\n').filter((l) => l.startsWith('- '));
    expect(factLines).toHaveLength(1);
  });

  it('emits memory_strata_consolidator_failed audit event with partial counters when a step throws (C2)', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    // Seed one promotable inbox observation so the consolidator enters the
    // cluster loop and tries to write a doc before hitting the injected failure.
    await writeInboxFixture(
      'obs-fail-test.md',
      {
        id: 'obs-fail-test',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.9,
        pinned: false,
        summary: 'User uses Vim as their editor',
        subject: 'editor',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser uses Vim as their editor\n',
    );

    // Inject failure via an unwritable docs/ directory: pre-create the docs
    // root with mode 0o000 so that mkdir(docs/preference/, {recursive:true})
    // throws EACCES when the consolidator attempts to write the new doc.
    // This approach avoids ESM-incompatible vi.spyOn on node:fs/promises.
    const docsRoot = join(workspaceRoot, 'permanent/memory/docs');
    await mkdir(docsRoot, { recursive: true });
    await chmod(docsRoot, 0o000);

    const logger = makeLoggerSpy();
    let threw = false;
    try {
      await runConsolidation({ workspaceRoot, now, logger });
    } catch {
      threw = true;
    } finally {
      // Restore permissions so afterEach can rm the temp dir.
      await chmod(docsRoot, 0o755);
    }

    expect(threw).toBe(true);

    // The catch block must have emitted memory_strata_consolidator_failed.
    const failedEvents = logger.warnCalls.filter(
      (c) => c.event === 'memory_strata_consolidator_failed',
    );
    expect(failedEvents).toHaveLength(1);
    const fields = failedEvents[0]!.fields;
    expect(fields['err']).toBeInstanceOf(Error);
    // Counters are present in fields (partial audit context).
    expect(fields).toMatchObject({
      promoted: expect.any(Number),
      dupesMerged: expect.any(Number),
      quarantined: expect.any(Number),
      leftInInbox: expect.any(Number),
      decayed: expect.any(Number),
    });
    // The success event must NOT have been emitted.
    expect(logger.infoCalls.some((c) => c.event === 'memory_strata_consolidation_complete')).toBe(false);
  });

  it('emits memory:doc:written events via bus — created for first obs, updated for subsequent', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    // Two observations for the same subject: first creates the doc, second appends.
    await writeInboxFixture(
      '2026-05-10T12-00-00.000Z-ts-1.md',
      {
        id: 'obs-ts-1',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User prefers TypeScript',
        subject: 'typescript',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser prefers TypeScript\n',
    );

    await writeInboxFixture(
      '2026-05-10T12-00-01.000Z-ts-2.md',
      {
        id: 'obs-ts-2',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User has used TypeScript for 3+ years',
        subject: 'typescript',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser has used TypeScript for 3+ years\n',
    );

    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'sess-test',
      agentId: 'agent-test',
      userId: 'user-test',
      workspace: { rootPath: workspaceRoot },
    });

    const receivedEvents: Array<{
      docId: string;
      category: string;
      slug: string;
      kind: string;
      summary: string;
    }> = [];

    bus.subscribe('memory:doc:written', 'test-subscriber', async (_ctx, payload) => {
      receivedEvents.push(
        payload as {
          docId: string;
          category: string;
          slug: string;
          kind: string;
          summary: string;
        },
      );
      return undefined;
    });

    const result = await runConsolidation({ workspaceRoot, now, bus, ctx });

    // Both observations promoted.
    expect(result.promoted).toBe(2);

    // Two events fired.
    expect(receivedEvents).toHaveLength(2);

    // First event: kind:'created' for the new doc.
    expect(receivedEvents[0]).toMatchObject({
      docId: 'preference/typescript',
      category: 'preference',
      slug: 'typescript',
      kind: 'created',
      summary: 'User prefers TypeScript',
    });

    // Second event: kind:'updated' for the appendFact.
    expect(receivedEvents[1]).toMatchObject({
      docId: 'preference/typescript',
      category: 'preference',
      slug: 'typescript',
      kind: 'updated',
      summary: 'User has used TypeScript for 3+ years',
    });
  });

  it('no-bus path: runConsolidation works without bus/ctx — no events, no errors', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    await writeInboxFixture(
      '2026-05-10T12-00-00.000Z-nobus.md',
      {
        id: 'obs-nobus',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User prefers Vim',
        subject: 'editor',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser prefers Vim\n',
    );

    // No bus or ctx provided — should succeed without errors.
    const result = await runConsolidation({ workspaceRoot, now });
    expect(result.promoted).toBe(1);
    expect(result.dupesMerged).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(result.leftInInbox).toBe(0);
    expect(result.decayed).toBe(0);
  });

  it('subscriber failure is non-fatal — consolidation completes successfully', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    await writeInboxFixture(
      '2026-05-10T12-00-00.000Z-subfail.md',
      {
        id: 'obs-subfail',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User uses Neovim',
        subject: 'neovim',
        factType: 'preference',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nUser uses Neovim\n',
    );

    const bus = new HookBus();
    const ctx = makeAgentContext({
      sessionId: 'sess-subfail',
      agentId: 'agent-subfail',
      userId: 'user-subfail',
      workspace: { rootPath: workspaceRoot },
    });

    // Register a subscriber that always throws.
    bus.subscribe('memory:doc:written', 'throwing-subscriber', async () => {
      throw new Error('subscriber kaboom');
    });

    // HookBus itself swallows subscriber errors — consolidation must still complete.
    const result = await runConsolidation({ workspaceRoot, now, bus, ctx });
    expect(result.promoted).toBe(1);
    expect(result.dupesMerged).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(result.leftInInbox).toBe(0);
    expect(result.decayed).toBe(0);

    // Doc should exist on disk.
    const docPath = join(workspaceRoot, 'permanent/memory/docs/preference/neovim.md');
    await expect(stat(docPath)).resolves.toBeTruthy();
  });

  it('promotes facts with a date tag from the observation event_time, and dedups a dated fact against its undated restatement', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    // First observation: has event_time, so the promoted fact line is dated.
    await writeInboxFixture(
      'obs-dated-1.md',
      {
        id: 'obs-dated-1',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User visited The Art Cube',
        subject: 'art-cube',
        factType: 'episode',
        event_time: '2026-02-15T18:30:00.000Z',
      },
      '# Observation\n\nUser visited The Art Cube\n',
    );

    const result1 = await runConsolidation({ workspaceRoot, now });
    expect(result1.promoted).toBe(1);

    const docPath = join(workspaceRoot, 'permanent/memory/docs/episode/art-cube.md');
    const docAfterFirst = await readFile(docPath, 'utf8');
    expect(docAfterFirst).toContain('- (2026-02-15) User visited The Art Cube');

    // Second observation: same summary restated WITHOUT event_time — must
    // dedup against the dated fact already in the doc (date-stripped compare).
    await writeInboxFixture(
      'obs-dated-2.md',
      {
        id: 'obs-dated-2',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.85,
        pinned: false,
        summary: 'User visited The Art Cube',
        subject: 'art-cube',
        factType: 'episode',
      },
      '# Observation\n\nUser visited The Art Cube\n',
    );

    const result2 = await runConsolidation({ workspaceRoot, now });
    expect(result2.dupesMerged).toBe(1);
    expect(result2.promoted).toBe(0);

    const docAfterSecond = await readFile(docPath, 'utf8');
    const factLines = docAfterSecond.split('\n').filter((l) => l.startsWith('- '));
    expect(factLines).toHaveLength(1);
    expect(factLines[0]).toBe('- (2026-02-15) User visited The Art Cube');
  });

  it('warns on invalid created timestamp during decay (C3)', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');

    // Seed an inbox file with a non-date `created` field.
    await writeInboxFixture(
      'obs-bad-date.md',
      {
        id: 'obs-bad-date',
        type: 'inbox/observation',
        created: 'not-a-date',
        confidence: 0.9,
        pinned: false,
        summary: 'Observation with corrupt timestamp',
        subject: 'corrupt',
        factType: 'general',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nObservation with corrupt timestamp\n',
    );

    const logger = makeLoggerSpy();
    // Consolidation must succeed even with a corrupt timestamp.
    await runConsolidation({ workspaceRoot, now, logger });

    // A warn entry must have been emitted for the invalid created field.
    const invalidCreatedWarns = logger.warnCalls.filter(
      (c) => c.event === 'memory_strata_inbox_decay_invalid_created',
    );
    expect(invalidCreatedWarns).toHaveLength(1);
    expect(invalidCreatedWarns[0]!.fields).toMatchObject({
      id: 'obs-bad-date',
      created: 'not-a-date',
      inboxPath: expect.stringContaining('obs-bad-date.md'),
    });
  });
});
