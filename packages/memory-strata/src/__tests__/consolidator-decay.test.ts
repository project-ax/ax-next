// I14 regression: inbox decay audit log.
//
// Proves that decayInbox (called inside runConsolidation):
//   (a) deletes inbox files older than 14 days,
//   (b) emits a `memory_strata_inbox_decayed` log line with the file's id
//       and NO body content.
//
// WHY real round-trips: same rationale as consolidator.test.ts — the
// correctness of the decay path depends on the full read→compare→delete cycle
// going through the real filesystem and the real inbox-store/frontmatter code.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConsolidation, type ConsolidationLogger } from '../consolidator.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { INBOX_DIR } from '../paths.js';
import type { MemoryFrontmatter } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-decay-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
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

/** Build a ConsolidationLogger spy that records all calls. */
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
// I14 regression test
// ---------------------------------------------------------------------------

describe('consolidator — inbox decay (I14)', () => {
  it('decays 15-day-old file, keeps 13-day and 1-day files, emits audit log with id only', async () => {
    const now = new Date('2026-05-10T12:00:00.000Z');
    const ms15d = 15 * 24 * 60 * 60 * 1000;
    const ms13d = 13 * 24 * 60 * 60 * 1000;
    const ms1d  =  1 * 24 * 60 * 60 * 1000;

    const created15d = new Date(now.getTime() - ms15d).toISOString();
    const created13d = new Date(now.getTime() - ms13d).toISOString();
    const created1d  = new Date(now.getTime() - ms1d).toISOString();

    // Unique body strings — used to verify they don't leak into the audit log.
    const body15d = '# Observation\n\nThis is the aged-out body content that must not appear in the log.\n';
    const body13d = '# Observation\n\nThirteen-day observation body.\n';
    const body1d  = '# Observation\n\nOne-day observation body.\n';

    // File that must decay: 15 days old, confidence 0.5 (below promotion threshold).
    const path15d = await writeInboxFixture(
      'aged-15d.md',
      {
        id: 'obs-aged-15d',
        type: 'inbox/observation',
        created: created15d,
        confidence: 0.5,
        pinned: false,
        summary: 'Aged out observation from 15 days ago',
        subject: 'aged-subject',
        factType: 'general',
        event_time: created15d,
        recorded_at: created15d,
      },
      body15d,
    );

    // File that must be kept: 13 days old (inside the 14-day window), low confidence.
    const path13d = await writeInboxFixture(
      'aged-13d.md',
      {
        id: 'obs-aged-13d',
        type: 'inbox/observation',
        created: created13d,
        confidence: 0.5,
        pinned: false,
        summary: 'Thirteen-day observation still within window',
        subject: 'recent-subject-a',
        factType: 'general',
        event_time: created13d,
        recorded_at: created13d,
      },
      body13d,
    );

    // File that must be kept: 1 day old, low confidence.
    const path1d = await writeInboxFixture(
      'aged-1d.md',
      {
        id: 'obs-aged-1d',
        type: 'inbox/observation',
        created: created1d,
        confidence: 0.5,
        pinned: false,
        summary: 'One-day observation clearly within window',
        subject: 'recent-subject-b',
        factType: 'general',
        event_time: created1d,
        recorded_at: created1d,
      },
      body1d,
    );

    const logger = makeLoggerSpy();
    const result = await runConsolidation({ workspaceRoot, now, logger });

    // (a) Result: exactly one file decayed.
    expect(result.decayed).toBe(1);

    // (b) 15-day-old file is gone from disk.
    await expect(stat(join(workspaceRoot, path15d))).rejects.toThrow(/ENOENT/);

    // (c) 13-day-old file is still present.
    await expect(stat(join(workspaceRoot, path13d))).resolves.toBeTruthy();

    // (d) 1-day-old file is still present.
    await expect(stat(join(workspaceRoot, path1d))).resolves.toBeTruthy();

    // (e) Exactly one `memory_strata_inbox_decayed` info entry.
    const decayedCalls = logger.infoCalls.filter(
      (c) => c.event === 'memory_strata_inbox_decayed',
    );
    expect(decayedCalls).toHaveLength(1);

    // (f) The log entry carries the file's id, not the body content.
    const decayedFields = decayedCalls[0]!.fields;
    expect(decayedFields['id']).toBe('obs-aged-15d');

    // (g) Body content must NOT appear in the captured fields (audit log carries
    //     id only — I14 forbids leaking observation content into the audit trail).
    const fieldsStr = JSON.stringify(decayedFields);
    const bodyMarker = 'aged-out body content that must not appear in the log';
    expect(fieldsStr).not.toContain(bodyMarker);
  });
});
