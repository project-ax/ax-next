import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listInbox, deleteInboxFile, writeInboxObservation } from '../inbox-store.js';
import { buildMarkdownFile } from '../frontmatter.js';
import { INBOX_DIR } from '../paths.js';
import type { MemoryFrontmatter, Observation } from '../types.js';

let workspaceRoot: string;
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memstr-inbox-'));
});

/** Write an inbox file the same way the Observer does — via buildMarkdownFile. */
async function writeFixture(name: string, fm: MemoryFrontmatter, body: string): Promise<string> {
  const dir = join(workspaceRoot, INBOX_DIR);
  await mkdir(dir, { recursive: true });
  const abs = join(dir, name);
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
  return `${INBOX_DIR}/${name}`;
}

const BASE_FM: MemoryFrontmatter = {
  id: 'test-uuid-1234',
  type: 'inbox/observation',
  created: '2026-05-10T12:00:00.000Z',
  confidence: 0.8,
  pinned: false,
  summary: 'User prefers React',
  subject: 'react',
  factType: 'preference',
  source_messages: 3,
  event_time: '2026-05-10T12:00:00.000Z',
  recorded_at: '2026-05-10T12:00:00.000Z',
};

describe('inbox-store', () => {
  it('(a) listInbox returns every inbox/*.md parsed into {path, frontmatter, body}', async () => {
    const body = '# Observation\n\nUser prefers React\n';
    await writeFixture('2026-05-10T12-00-00.000Z-00-test1234.md', BASE_FM, body);

    const files = await listInbox(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(`${INBOX_DIR}/2026-05-10T12-00-00.000Z-00-test1234.md`);
    expect(files[0]!.frontmatter.id).toBe('test-uuid-1234');
    expect(files[0]!.frontmatter.type).toBe('inbox/observation');
    expect(files[0]!.frontmatter.confidence).toBe(0.8);
    expect(files[0]!.body).toContain('User prefers React');
  });

  it('(b) round-trip: buildMarkdownFile -> listInbox recovers the same MemoryFrontmatter', async () => {
    const fm: MemoryFrontmatter = {
      ...BASE_FM,
      id: 'round-trip-uuid-abcd',
      summary: 'User dislikes Vue',
      subject: 'vue',
      factType: 'preference',
      confidence: 0.75,
      created: '2026-05-10T14:30:00.000Z',
    };
    const body = '# Observation\n\nUser dislikes Vue\n';
    await writeFixture('2026-05-10T14-30-00.000Z-00-roundtrip.md', fm, body);

    const files = await listInbox(workspaceRoot);
    expect(files).toHaveLength(1);
    const recovered = files[0]!.frontmatter;
    // All key fields the Consolidator needs must survive the round-trip.
    expect(recovered.id).toBe(fm.id);
    expect(recovered.type).toBe(fm.type);
    expect(recovered.created).toBe(fm.created);
    expect(recovered.confidence).toBe(fm.confidence);
    expect(recovered.pinned).toBe(fm.pinned);
    expect(recovered.summary).toBe(fm.summary);
    expect(recovered.subject).toBe(fm.subject);
    expect(recovered.factType).toBe(fm.factType);
    expect(recovered.source_messages).toBe(fm.source_messages);
  });

  it('(c) deleteInboxFile removes a single file', async () => {
    const relPath = await writeFixture(
      '2026-05-10T12-00-00.000Z-00-delete-me.md',
      BASE_FM,
      '# Observation\n\nSome fact\n',
    );

    await deleteInboxFile(workspaceRoot, relPath);

    await expect(
      stat(join(workspaceRoot, relPath)),
    ).rejects.toThrow(/ENOENT/);
  });

  it('(d) listInbox returns [] when inbox/ does not exist (ENOENT)', async () => {
    // workspaceRoot exists but INBOX_DIR has not been created.
    const files = await listInbox(workspaceRoot);
    expect(files).toEqual([]);
  });

  it('skips malformed files (no YAML fence) without crashing the pass', async () => {
    const dir = join(workspaceRoot, INBOX_DIR);
    await mkdir(dir, { recursive: true });
    // Write a .md file with no frontmatter fence at all.
    await writeFile(join(dir, 'bad.md'), 'just some text, no frontmatter', 'utf8');
    // Write a valid file alongside it.
    await writeFixture('2026-05-10T12-00-00.000Z-00-good.md', BASE_FM, '# Observation\n\ngood\n');

    const files = await listInbox(workspaceRoot);
    // Only the valid file is returned; the malformed one is silently skipped.
    expect(files).toHaveLength(1);
    expect(files[0]!.frontmatter.id).toBe(BASE_FM.id);
  });

  it('writeInboxObservation stamps conversation_id when provided (TASK-187)', async () => {
    const obs: Observation = {
      fact: 'User deploys on Fridays',
      subject: 'deploy',
      factType: 'preference',
      confidence: 0.8,
    };
    await writeInboxObservation(
      workspaceRoot,
      obs,
      new Date('2026-06-08T12:00:00.000Z'),
      0,
      3,
      'conv-xyz',
    );
    const files = await listInbox(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]!.frontmatter.conversation_id).toBe('conv-xyz');
  });

  it('writeInboxObservation omits conversation_id entirely when none is provided', async () => {
    const obs: Observation = {
      fact: 'User deploys on Fridays',
      subject: 'deploy',
      factType: 'preference',
      confidence: 0.8,
    };
    // No conversationId arg (e.g. ephemeral/canary context or agent note).
    await writeInboxObservation(
      workspaceRoot,
      obs,
      new Date('2026-06-08T12:00:00.000Z'),
      0,
      0,
    );
    const files = await listInbox(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]!.frontmatter.conversation_id).toBeUndefined();
  });

  it('skips files missing id or created (guards Consolidator decay logic)', async () => {
    const dir = join(workspaceRoot, INBOX_DIR);
    await mkdir(dir, { recursive: true });
    // Valid YAML front-matter, but id and created fields are missing.
    const noIdCreated = [
      '---',
      'type: inbox/observation',
      'confidence: 0.8',
      'pinned: false',
      'summary: missing required fields',
      '---',
      '# Observation\n\nmissing fields\n',
    ].join('\n');
    await writeFile(join(dir, 'missing-fields.md'), noIdCreated, 'utf8');

    const files = await listInbox(workspaceRoot);
    expect(files).toEqual([]);
  });

});
