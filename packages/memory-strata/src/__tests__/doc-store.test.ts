import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeNewDoc, appendFact, readDoc, listDocs, mergeConversationIntoDoc,
  formatFactLine, stripFactDate,
} from '../doc-store.js';

// ESM note: `vi.spyOn` cannot intercept named bindings in strict ESM
// (`Cannot redefine property` on module namespace). We use `vi.mock` with
// a factory that passes through every real fs method except the one we want
// to override per-test.  `vi.mock` is hoisted before imports, so the mocked
// module is already in place when `doc-store.ts` binds its `import * as fs`.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, rename: vi.fn(real.rename) };
});

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-doc-'));
});
afterEach(() => vi.restoreAllMocks());

describe('doc-store', () => {
  it('writes a new doc with canonical frontmatter', async () => {
    const result = await writeNewDoc({
      workspaceRoot,
      category: 'preference',
      slug: 'react',
      summary: 'User prefers React over Vue',
      subject: 'react',
      factType: 'preference',
      confidence: 0.85,
      sourceObservationIds: ['obs-1'],
      now: new Date('2026-05-10T12:00:00Z'),
      facts: ['User prefers React over Vue'],
    });
    expect(result.path).toBe('permanent/memory/docs/preference/react.md');
    const text = await readFile(join(workspaceRoot, result.path), 'utf8');
    expect(text).toContain('id: preference/react');
    expect(text).toContain('type: docs/preference');
    expect(text).toContain('confidence: 0.85');
    expect(text).toContain('## Facts');
    expect(text).toContain('- User prefers React over Vue');
  });

  it('appends a fact and bumps `updated` + running-max confidence', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'preference', slug: 'react',
      summary: 'User prefers React', subject: 'react', factType: 'preference',
      confidence: 0.8, sourceObservationIds: ['obs-1'],
      now: new Date('2026-05-10T12:00:00Z'),
      facts: ['User prefers React'],
    });
    await appendFact({
      workspaceRoot, category: 'preference', slug: 'react',
      newFact: 'User has used React for 5+ years',
      observationId: 'obs-2',
      confidence: 0.9,
      now: new Date('2026-05-10T13:00:00Z'),
    });
    const doc = await readDoc({
      workspaceRoot, category: 'preference', slug: 'react',
    });
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.confidence).toBe(0.9);
    expect(doc!.frontmatter.updated).toBe('2026-05-10T13:00:00.000Z');
    expect(doc!.frontmatter.source_observations).toEqual(['obs-1', 'obs-2']);
    expect(doc!.body).toContain('- User has used React for 5+ years');
  });

  it('atomic write: rename failure leaves no partial doc', async () => {
    // Import the mocked fs module so we can override `rename` for this test.
    const fsMod = await import('node:fs/promises');
    await mkdir(join(workspaceRoot, 'permanent/memory/docs/preference'), {
      recursive: true,
    });
    vi.mocked(fsMod.rename).mockRejectedValueOnce(new Error('disk full'));
    await expect(
      writeNewDoc({
        workspaceRoot, category: 'preference', slug: 'react',
        summary: 's', subject: 'react', factType: 'preference',
        confidence: 0.8, sourceObservationIds: ['obs-1'],
        now: new Date('2026-05-10T12:00:00Z'),
        facts: ['f'],
      }),
    ).rejects.toThrow('disk full');
    // The final path must NOT exist — the atomic-write guarantee.
    await expect(
      readFile(join(workspaceRoot, 'permanent/memory/docs/preference/react.md')),
    ).rejects.toThrow(/ENOENT/);
    // The tmp file must be cleaned up — no orphaned cruft in the docs dir.
    const dirContents = await readdir(join(workspaceRoot, 'permanent/memory/docs/preference'));
    const tmpFiles = dirContents.filter((n) => n.includes('.tmp-'));
    expect(tmpFiles).toEqual([]);
  });

  it('listDocs returns every doc under docs/', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'preference', slug: 'react',
      summary: 's', subject: 'react', factType: 'preference',
      confidence: 0.8, sourceObservationIds: ['o'],
      now: new Date('2026-05-10T12:00:00Z'), facts: ['f'],
    });
    await writeNewDoc({
      workspaceRoot, category: 'entity', slug: 'john',
      summary: 's', subject: 'john', factType: 'entity',
      confidence: 0.8, sourceObservationIds: ['o'],
      now: new Date('2026-05-10T12:00:00Z'), facts: ['f'],
    });
    const docs = await listDocs({ workspaceRoot });
    expect(docs.map((d) => d.frontmatter.id).sort())
      .toEqual(['entity/john', 'preference/react']);
  });

  it('parseDoc rejects a doc missing source_observations (covers bug-fix policy)', async () => {
    const dir = join(workspaceRoot, 'permanent/memory/docs/preference');
    await mkdir(dir, { recursive: true });
    // Hand-write a doc with valid YAML but missing source_observations.
    const malformed = [
      '---',
      'id: preference/react',
      'type: docs/preference',
      'created: 2026-05-10T12:00:00.000Z',
      'updated: 2026-05-10T12:00:00.000Z',
      'confidence: 0.8',
      'pinned: false',
      'summary: x',
      'subject: react',
      'factType: preference',
      '---',
      '# Doc',
      '',
    ].join('\n');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'react.md'), malformed, 'utf8');
    await expect(
      readDoc({ workspaceRoot, category: 'preference', slug: 'react' }),
    ).rejects.toThrow(/missing source_observations/);
  });

  it('source_conversations: writeNewDoc seeds it, appendFact dedups distinct conversations (TASK-187)', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'general', slug: 'deploy',
      summary: 's1', subject: 'deploy', factType: 'general',
      confidence: 0.8, sourceObservationIds: ['obs-1'],
      conversationId: 'conv-1',
      now: new Date('2026-06-08T12:00:00Z'), facts: ['f1'],
    });
    // Append from a NEW conversation → distinct set grows.
    await appendFact({
      workspaceRoot, category: 'general', slug: 'deploy',
      newFact: 'f2', observationId: 'obs-2', conversationId: 'conv-2',
      confidence: 0.85, now: new Date('2026-06-08T13:00:00Z'),
    });
    // Append from an ALREADY-SEEN conversation → no growth (dedup).
    await appendFact({
      workspaceRoot, category: 'general', slug: 'deploy',
      newFact: 'f3', observationId: 'obs-3', conversationId: 'conv-1',
      confidence: 0.9, now: new Date('2026-06-08T14:00:00Z'),
    });
    const doc = await readDoc({ workspaceRoot, category: 'general', slug: 'deploy' });
    expect(doc!.frontmatter.source_observations).toEqual(['obs-1', 'obs-2', 'obs-3']);
    expect(doc!.frontmatter.source_conversations).toEqual(['conv-1', 'conv-2']);
  });

  it('writeNewDoc with no conversationId writes an empty source_conversations set', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'general', slug: 'deploy',
      summary: 's', subject: 'deploy', factType: 'general',
      confidence: 0.8, sourceObservationIds: ['obs-1'],
      now: new Date('2026-06-08T12:00:00Z'), facts: ['f'],
    });
    const doc = await readDoc({ workspaceRoot, category: 'general', slug: 'deploy' });
    expect(doc!.frontmatter.source_conversations).toEqual([]);
  });

  it('mergeConversationIntoDoc folds a NEW conversation without appending a fact', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'general', slug: 'deploy',
      summary: 's', subject: 'deploy', factType: 'general',
      confidence: 0.8, sourceObservationIds: ['obs-1'], conversationId: 'conv-1',
      now: new Date('2026-06-08T12:00:00Z'), facts: ['the one fact'],
    });
    const merged = await mergeConversationIntoDoc({
      workspaceRoot, category: 'general', slug: 'deploy',
      conversationId: 'conv-2', now: new Date('2026-06-08T13:00:00Z'),
    });
    // Distinct set grew; the body (facts) is untouched — no new fact appended.
    expect(merged.frontmatter.source_conversations).toEqual(['conv-1', 'conv-2']);
    expect(merged.frontmatter.source_observations).toEqual(['obs-1']);
    expect(merged.body).toContain('the one fact');
    const onDisk = await readDoc({ workspaceRoot, category: 'general', slug: 'deploy' });
    expect(onDisk!.frontmatter.source_conversations).toEqual(['conv-1', 'conv-2']);
  });

  it('mergeConversationIntoDoc is a no-op for an already-seen or undefined conversation', async () => {
    await writeNewDoc({
      workspaceRoot, category: 'general', slug: 'deploy',
      summary: 's', subject: 'deploy', factType: 'general',
      confidence: 0.8, sourceObservationIds: ['obs-1'], conversationId: 'conv-1',
      now: new Date('2026-06-08T12:00:00Z'), facts: ['f'],
    });
    const beforeUpdated = (await readDoc({ workspaceRoot, category: 'general', slug: 'deploy' }))!
      .frontmatter.updated;
    // Already-seen conversation → no change.
    await mergeConversationIntoDoc({
      workspaceRoot, category: 'general', slug: 'deploy',
      conversationId: 'conv-1', now: new Date('2026-06-08T15:00:00Z'),
    });
    // Undefined conversation → no change.
    await mergeConversationIntoDoc({
      workspaceRoot, category: 'general', slug: 'deploy',
      conversationId: undefined, now: new Date('2026-06-08T16:00:00Z'),
    });
    const doc = await readDoc({ workspaceRoot, category: 'general', slug: 'deploy' });
    expect(doc!.frontmatter.source_conversations).toEqual(['conv-1']);
    // No write happened, so `updated` is unchanged (we skip the atomic rewrite).
    expect(doc!.frontmatter.updated).toBe(beforeUpdated);
  });

  it('mergeConversationIntoDoc throws docNotFound when the doc is absent', async () => {
    await expect(
      mergeConversationIntoDoc({
        workspaceRoot, category: 'general', slug: 'missing',
        conversationId: 'conv-1', now: new Date('2026-06-08T12:00:00Z'),
      }),
    ).rejects.toThrow(/docNotFound/);
  });
});

describe('formatFactLine', () => {
  it('prefixes a date-only tag from an ISO timestamp', () => {
    expect(formatFactLine('User visited The Art Cube.', '2026-02-15T18:30:00.000Z')).toBe(
      '(2026-02-15) User visited The Art Cube.',
    );
  });
  it('renders bare when no timestamp', () => {
    expect(formatFactLine('User visited The Art Cube.', undefined)).toBe(
      'User visited The Art Cube.',
    );
  });
  it('renders bare on a malformed timestamp', () => {
    expect(formatFactLine('fact', 'not-a-date')).toBe('fact');
  });
  it('renders bare on a non-string timestamp (never throws)', () => {
    // @ts-expect-error — exercising the runtime guard against loosely-typed YAML
    expect(formatFactLine('fact', new Date('2026-02-15T18:30:00.000Z'))).toBe('fact');
    // @ts-expect-error — exercising the runtime guard against loosely-typed YAML
    expect(formatFactLine('fact', 1234567890123)).toBe('fact');
  });
});

describe('stripFactDate', () => {
  it('strips a leading date tag', () => {
    expect(stripFactDate('(2026-02-15) User visited The Art Cube.')).toBe(
      'User visited The Art Cube.',
    );
  });
  it('leaves undated lines alone', () => {
    expect(stripFactDate('User visited The Art Cube.')).toBe('User visited The Art Cube.');
  });
});
