// End-to-end consolidation test.
//
// WHY real round-trips: the consolidator's correctness depends on every
// helper (cluster, dedup, doc-store, inbox-store, promotion, recent)
// behaving correctly as a unit. Stubbing any of them would give us a
// unit test of the orchestrator wiring — not a test that proves the full
// pass produces the right on-disk state. Real filesystem round-trips are
// the only way to exercise the I11/I12/I13 invariants together.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(reactDoc).toContain('- User prefers React');
    expect(reactDoc).toContain('- User has used React for 5+ years');
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
});
