import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlTranscriptSource } from '../jsonl-transcript-source.js';

describe('createJsonlTranscriptSource', () => {
  it('finds the jsonl under an unknown project slug', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const dir = join(root, '.claude', 'projects', '-some-encoded-slug');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sess-1.jsonl'), '{"type":"user"}\n');

    const source = createJsonlTranscriptSource(root);
    await expect(source.locate('sess-1')).resolves.toBe(join(dir, 'sess-1.jsonl'));
  });

  it('returns null when no transcript exists yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const source = createJsonlTranscriptSource(root);
    await expect(source.locate('sess-missing')).resolves.toBeNull();
  });
});
