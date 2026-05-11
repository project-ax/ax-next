// Tests for recent.ts — the `recent.md` regenerator (I13).
//
// I13 invariant: `recent.md` must be regenerable end-to-end from `inbox/` +
// `docs/` state. Deleting the file and re-running with the same `now` must
// produce byte-for-byte identical output.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regenerateRecent } from '../recent.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { inboxFile, INBOX_DIR } from '../paths.js';
import { writeNewDoc } from '../doc-store.js';
import type { MemoryFrontmatter } from '../types.js';

/** Write a single inbox observation file to the workspace. */
async function writeInboxObservation(
  workspaceRoot: string,
  opts: {
    id: string;
    factType: string;
    summary: string;
    timestamp: Date;
    confidence?: number;
  },
): Promise<void> {
  const fm: MemoryFrontmatter = {
    id: opts.id,
    type: 'inbox/observation',
    created: opts.timestamp.toISOString(),
    confidence: opts.confidence ?? 0.9,
    pinned: false,
    summary: opts.summary,
    factType: opts.factType,
    event_time: opts.timestamp.toISOString(),
    recorded_at: opts.timestamp.toISOString(),
  };
  const body = `# Observation\n\n- ${opts.summary}\n`;
  const rel = inboxFile(opts.timestamp, opts.id);
  const abs = join(workspaceRoot, rel);
  await mkdir(join(workspaceRoot, INBOX_DIR), { recursive: true });
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
}

const NOW = new Date('2026-05-10T12:00:00Z');

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-recent-'));
});
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('regenerateRecent', () => {
  it('writes recent.md with all 3 sections from a populated workspace', async () => {
    // Inbox: 1 episode (open thread), 2 preferences (not open threads)
    await writeInboxObservation(workspaceRoot, {
      id: 'ep-1',
      factType: 'episode',
      summary: 'Working on login flow refactor',
      timestamp: new Date('2026-05-10T10:00:00Z'),
    });
    await writeInboxObservation(workspaceRoot, {
      id: 'pref-1',
      factType: 'preference',
      summary: 'Prefers TypeScript strict mode',
      timestamp: new Date('2026-05-10T09:00:00Z'),
    });
    await writeInboxObservation(workspaceRoot, {
      id: 'pref-2',
      factType: 'preference',
      summary: 'Prefers pnpm over npm',
      timestamp: new Date('2026-05-10T08:00:00Z'),
    });

    // Docs: 5 docs with varying updated times
    for (let i = 1; i <= 5; i++) {
      await writeNewDoc({
        workspaceRoot,
        category: 'entity',
        slug: `project-${i}`,
        summary: `Project ${i} summary`,
        subject: `project-${i}`,
        factType: 'entity',
        confidence: 0.8,
        sourceObservationIds: ['ep-1'],
        now: new Date(`2026-05-0${i}T12:00:00Z`),
        facts: [`fact about project ${i}`],
      });
    }

    const result = await regenerateRecent({ workspaceRoot, now: NOW });

    expect(result.path).toBe('permanent/memory/system/recent.md');

    const content = await readFile(join(workspaceRoot, result.path), 'utf8');

    // Must have all 3 sections
    expect(content).toContain('## Open Threads');
    expect(content).toContain('## Active Projects');
    expect(content).toContain('## Recent Changes');

    // Open Threads: only the episode, not the preferences
    expect(content).toContain('[ep-1]');
    expect(content).toContain('Working on login flow refactor');
    expect(content).not.toContain('[pref-1]');
    expect(content).not.toContain('[pref-2]');

    // Active Projects: entity docs updated within 7 days of NOW (2026-05-10)
    // project-5 updated 2026-05-05, project-4 updated 2026-05-04 — both within window
    // project-1 updated 2026-05-01 — 9 days ago, outside 7-day window
    const activeProjectsSection = content.slice(
      content.indexOf('## Active Projects'),
      content.indexOf('## Recent Changes'),
    );
    expect(activeProjectsSection).toContain('project-5');
    expect(activeProjectsSection).toContain('project-4');
    expect(activeProjectsSection).not.toContain('project-1');

    // Recent Changes: top 5 most recently updated docs
    expect(content).toContain('entity/project-5');
    expect(content).toContain('entity/project-4');
    expect(content).toContain('entity/project-3');
    expect(content).toContain('entity/project-2');
    expect(content).toContain('entity/project-1');

    // Frontmatter sanity
    expect(content).toContain('type: system/recent');
    expect(content).toContain('pinned: true');
    expect(content).toContain('id: recent');
  });

  it('I13 determinism: delete + re-run with same `now` produces identical output', async () => {
    // Write a modest fixture — enough to exercise all 3 sections
    await writeInboxObservation(workspaceRoot, {
      id: 'ep-42',
      factType: 'episode',
      summary: 'Investigating memory leak in observer',
      timestamp: new Date('2026-05-10T09:00:00Z'),
    });
    await writeNewDoc({
      workspaceRoot,
      category: 'entity',
      slug: 'auth-service',
      summary: 'Auth service entity',
      subject: 'auth-service',
      factType: 'entity',
      confidence: 0.85,
      sourceObservationIds: ['ep-42'],
      now: new Date('2026-05-09T10:00:00Z'),
      facts: ['auth service handles OAuth flow'],
    });

    // First run
    const rel = (await regenerateRecent({ workspaceRoot, now: NOW })).path;
    const firstContent = await readFile(join(workspaceRoot, rel), 'utf8');

    // Delete the file
    await rm(join(workspaceRoot, rel));

    // Second run — same `now`
    await regenerateRecent({ workspaceRoot, now: NOW });
    const secondContent = await readFile(join(workspaceRoot, rel), 'utf8');

    // I13: byte-for-byte identical
    expect(secondContent).toBe(firstContent);
  });

  it('empty workspace: all 3 sections show _None._', async () => {
    const result = await regenerateRecent({ workspaceRoot, now: NOW });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');

    expect(content).toContain('## Open Threads');
    expect(content).toContain('## Active Projects');
    expect(content).toContain('## Recent Changes');

    // All sections must say "_None._" with no real entries
    const openThreadsSection = content.slice(
      content.indexOf('## Open Threads'),
      content.indexOf('## Active Projects'),
    );
    const activeProjectsSection = content.slice(
      content.indexOf('## Active Projects'),
      content.indexOf('## Recent Changes'),
    );
    const recentChangesSection = content.slice(
      content.indexOf('## Recent Changes'),
    );

    expect(openThreadsSection).toContain('_None._');
    expect(activeProjectsSection).toContain('_None._');
    expect(recentChangesSection).toContain('_None._');
  });

  it('decision factType is included in Open Threads (alongside episode)', async () => {
    await writeInboxObservation(workspaceRoot, {
      id: 'dec-1',
      factType: 'decision',
      summary: 'Decided to use vitest over jest',
      timestamp: new Date('2026-05-10T07:00:00Z'),
    });
    await writeInboxObservation(workspaceRoot, {
      id: 'gen-1',
      factType: 'general',
      summary: 'A general observation',
      timestamp: new Date('2026-05-10T07:30:00Z'),
    });

    const result = await regenerateRecent({ workspaceRoot, now: NOW });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');

    // Decision should appear in Open Threads
    expect(content).toContain('[dec-1]');
    expect(content).toContain('Decided to use vitest over jest');

    // General should NOT appear in Open Threads
    expect(content).not.toContain('[gen-1]');
  });

  it('active projects cutoff: docs older than 7 days are excluded', async () => {
    // Updated exactly 7 days before NOW — should be included (>= cutoff)
    await writeNewDoc({
      workspaceRoot,
      category: 'entity',
      slug: 'just-in',
      summary: 'On the boundary',
      subject: 'just-in',
      factType: 'entity',
      confidence: 0.8,
      sourceObservationIds: ['x'],
      now: new Date('2026-05-03T12:00:00Z'), // exactly 7 days before NOW
      facts: ['boundary fact'],
    });
    // Updated 8 days before NOW — should be excluded
    await writeNewDoc({
      workspaceRoot,
      category: 'entity',
      slug: 'too-old',
      summary: 'Beyond window',
      subject: 'too-old',
      factType: 'entity',
      confidence: 0.8,
      sourceObservationIds: ['y'],
      now: new Date('2026-05-02T12:00:00Z'), // 8 days before NOW
      facts: ['old fact'],
    });

    const result = await regenerateRecent({ workspaceRoot, now: NOW });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');

    const activeSection = content.slice(
      content.indexOf('## Active Projects'),
      content.indexOf('## Recent Changes'),
    );
    expect(activeSection).toContain('just-in');
    expect(activeSection).not.toContain('too-old');
  });

  it('recent changes caps at 5 and sorts newest-first', async () => {
    // Write 6 docs
    for (let i = 1; i <= 6; i++) {
      await writeNewDoc({
        workspaceRoot,
        category: 'preference',
        slug: `item-${i}`,
        summary: `item ${i}`,
        subject: `item-${i}`,
        factType: 'preference',
        confidence: 0.8,
        sourceObservationIds: ['x'],
        now: new Date(`2026-05-0${i}T12:00:00Z`),
        facts: [`fact ${i}`],
      });
    }

    const result = await regenerateRecent({ workspaceRoot, now: NOW });
    const content = await readFile(join(workspaceRoot, result.path), 'utf8');

    const recentSection = content.slice(content.indexOf('## Recent Changes'));
    // Should contain items 2-6 (newest), not item 1 (oldest — 6th slot dropped),
    // and must appear in newest-first order (item-6 before item-5 before … item-2).
    const positions = [
      'preference/item-6',
      'preference/item-5',
      'preference/item-4',
      'preference/item-3',
      'preference/item-2',
    ].map((token) => recentSection.indexOf(token));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(recentSection).not.toContain('preference/item-1');
  });
});
