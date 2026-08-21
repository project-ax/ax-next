// TASK-216: an Observation's `subject` is LLM-chosen — the extraction model
// picks it, not the user, not us — and until this fix it was scanned by
// NEITHER sensitive gate (I7 write-time in observer.ts checked only `fact`;
// I11 promote-time in promotion.ts checked only `summary` + `body`). Unlike
// `fact`, `subject` doesn't sit quietly in a doc body waiting for a
// `memory_search` hit: it's written verbatim into the promoted doc's
// frontmatter and rendered RAW into `system/recent.md` AND `system/map.md` —
// two files `inject.ts` splices into the system prompt on EVERY turn, with
// no retrieval gate in between. A credential-shaped subject was therefore a
// standing, ungated exfiltration channel: land it once in `inbox/`, and it
// reappears in the agent's context on every subsequent turn forever.
//
// This file proves reachability end to end against a REAL `runConsolidation`
// and a REAL temp-dir filesystem — no stubs of the gate, cluster, doc-store,
// or recent/map modules. Test A bypasses I7 entirely (a direct inbox write,
// exactly the scenario I11's "defense in depth" comment exists for) and
// proves I11 still stops the subject from reaching `recent.md`/`map.md`.
// Test B is the positive control: an otherwise-identical clean-subject
// observation DOES reach both files, so Test A's absence assertions mean
// something rather than passing vacuously because nothing ever promotes.
// Test C closes the loop from the other end: the real `runObserver` (I7)
// refuses to even write a credential-shaped subject to `inbox/` in the
// first place.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConsolidation, type ConsolidationLogger } from '../consolidator.js';
import { runObserver } from '../observer.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { slugify } from '../slugify.js';
import { INBOX_DIR, MEMORY_ROOT } from '../paths.js';
import type { AgentMessage, LlmCallInput, LlmCallOutput } from '@ax/core';
import type { MemoryFrontmatter } from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers — copied idiom from consolidator.test.ts (module-local
// there, so re-declared here rather than imported).
// ---------------------------------------------------------------------------

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-recent-subject-gate-'));
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

function llmReturning(text: string): (input: LlmCallInput) => Promise<LlmCallOutput> {
  return async () => ({
    text,
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 50 },
  });
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

describe('a sensitive subject cannot reach the always-injected system files (TASK-216)', () => {
  it('Test A: a credential-shaped subject (direct inbox write, bypassing I7) is quarantined by I11 and never reaches recent.md or map.md', async () => {
    const now = new Date('2026-08-20T12:00:00.000Z');

    // A lowercase email — matches sensitive-gate.ts's `email` pattern, and
    // being all-lowercase already, slugify's case-folding can't be blamed
    // for "losing" the credential shape: the slug carries it through intact.
    const CREDENTIAL_SUBJECT = 'alice@example.com';
    const slug = slugify(CREDENTIAL_SUBJECT);
    expect(slug).toBe('alice-example-com');

    const filename = '2026-08-20T12-00-00.000Z-cred-subject.md';
    const inboxPath = await writeInboxFixture(
      filename,
      {
        id: 'obs-cred-subject',
        type: 'inbox/observation',
        created: now.toISOString(),
        // Above CONFIDENCE_THRESHOLD (0.7) — the confidence gate must not be
        // what rejects this; only the subject gate should.
        confidence: 0.9,
        pinned: false,
        // Clean summary/body — the ONLY sensitive content anywhere in this
        // fixture is the subject. If this fixture gets quarantined, it can
        // only be because the subject gate fired.
        summary: 'Kickoff meeting scheduled for next week',
        subject: CREDENTIAL_SUBJECT,
        // entity => docs/entity, the category recent.ts's "Active Projects"
        // section reads from.
        factType: 'entity',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nKickoff meeting scheduled for next week\n',
    );

    const logger = makeLoggerSpy();
    const result = await runConsolidation({ workspaceRoot, now, logger });

    // --- 1. Quarantined, not promoted ---
    expect(result.quarantined).toBe(1);
    expect(result.promoted).toBe(0);

    // --- 2. Inbox file moved to quarantine, gone from its inbox path ---
    const quarantineDest = join(workspaceRoot, `${MEMORY_ROOT}/quarantine/${filename}`);
    await expect(stat(quarantineDest)).resolves.toBeTruthy();
    await expect(stat(join(workspaceRoot, inboxPath))).rejects.toThrow(/ENOENT/);

    // --- 3. No docs/entity/<slug>.md was ever created ---
    const docPath = join(workspaceRoot, `permanent/memory/docs/entity/${slug}.md`);
    await expect(stat(docPath)).rejects.toThrow(/ENOENT/);

    // --- 4. system/recent.md contains NEITHER the raw subject NOR its slug,
    //        in EITHER section that could carry it ---
    const recentPath = join(workspaceRoot, 'permanent/memory/system/recent.md');
    const recentText = await readText(recentPath);
    expect(recentText).not.toContain(CREDENTIAL_SUBJECT);
    expect(recentText).not.toContain(slug);
    // Names what it's protecting: with nothing promoted, both sections that
    // could have carried this subject render their empty placeholder.
    const activeProjectsSection = recentText.split('## Active Projects')[1]?.split('## Recent Changes')[0] ?? '';
    expect(activeProjectsSection).toContain('_None._');
    const recentChangesSection = recentText.split('## Recent Changes')[1] ?? '';
    expect(recentChangesSection).toContain('_None._');

    // --- 5. system/map.md contains NEITHER the raw subject NOR its slug ---
    const mapPath = join(workspaceRoot, 'permanent/memory/system/map.md');
    const mapText = await readText(mapPath);
    expect(mapText).not.toContain(CREDENTIAL_SUBJECT);
    expect(mapText).not.toContain(slug);
  });

  it('Test B (positive control): an otherwise-identical CLEAN subject promotes and DOES reach recent.md and map.md', async () => {
    const now = new Date('2026-08-20T12:00:00.000Z');

    const CLEAN_SUBJECT = 'acme rocket project';
    const slug = slugify(CLEAN_SUBJECT);
    expect(slug).toBe('acme-rocket-project');

    await writeInboxFixture(
      '2026-08-20T12-00-00.000Z-clean-subject.md',
      {
        id: 'obs-clean-subject',
        type: 'inbox/observation',
        created: now.toISOString(),
        confidence: 0.9,
        pinned: false,
        summary: 'Kickoff meeting scheduled for next week',
        subject: CLEAN_SUBJECT,
        factType: 'entity',
        event_time: now.toISOString(),
        recorded_at: now.toISOString(),
      },
      '# Observation\n\nKickoff meeting scheduled for next week\n',
    );

    const result = await runConsolidation({ workspaceRoot, now });

    expect(result.promoted).toBe(1);
    expect(result.quarantined).toBe(0);

    const docId = `entity/${slug}`;

    // recent.md: raw subject in Active Projects, doc id in Recent Changes.
    const recentPath = join(workspaceRoot, 'permanent/memory/system/recent.md');
    const recentText = await readText(recentPath);
    const activeProjectsSection = recentText.split('## Active Projects')[1]?.split('## Recent Changes')[0] ?? '';
    expect(activeProjectsSection).toContain(CLEAN_SUBJECT);
    const recentChangesSection = recentText.split('## Recent Changes')[1] ?? '';
    expect(recentChangesSection).toContain(docId);

    // map.md: category heading + slug both present (no densifier wired, so
    // the map falls back to the doc's raw summary — the doc id itself isn't
    // rendered contiguously, but category + slug together are what identify
    // this doc in the map).
    const mapPath = join(workspaceRoot, 'permanent/memory/system/map.md');
    const mapText = await readText(mapPath);
    expect(mapText).toContain('## entity/');
    expect(mapText).toContain(slug);

    // Confirms this fixture genuinely reaches both always-injected surfaces
    // — proving Test A's absence assertions are meaningful, not vacuous.
  });

  it('Test C: the real runObserver (I7) refuses to write ANY inbox file for a candidate with a clean fact but a credential-shaped subject', async () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Our new hire starts on Monday.' },
      { role: 'assistant', content: 'Got it.' },
    ];

    const CREDENTIAL_SUBJECT = 'bob@example.com';

    const result = await runObserver({
      messages,
      llmCall: llmReturning(
        JSON.stringify([
          {
            fact: 'New hire starts on Monday.',
            subject: CREDENTIAL_SUBJECT,
            factType: 'entity',
            confidence: 0.9,
          },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-08-20T12:00:00.000Z'),
      timeoutMs: 30_000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.written).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.kinds).toContain('email');

    // Nothing was written under inbox/ at all — the dir is absent or empty.
    const inboxDir = join(workspaceRoot, INBOX_DIR);
    const names = await readdir(inboxDir).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    });
    expect(names).toHaveLength(0);
  });
});
