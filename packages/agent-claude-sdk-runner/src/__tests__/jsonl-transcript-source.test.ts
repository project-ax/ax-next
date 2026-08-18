import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlTranscriptSource, encodeProjectSlug } from '../jsonl-transcript-source.js';

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

  it('write puts bytes at the SDK slug path and creates the directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const source = createJsonlTranscriptSource(root);
    const bytes = Buffer.from('u1\na1\na2\n', 'utf8');

    await source.write('sess-resume', bytes);

    // This is the SDK-private on-disk layout `restoreTranscriptForResume` in
    // @ax/agent-runner-core no longer knows about — it's entirely this
    // source's responsibility now.
    const slug = encodeProjectSlug(await realpath(root));
    const written = await readFile(
      join(root, '.claude', 'projects', slug, 'sess-resume.jsonl'),
    );
    expect(written.equals(bytes)).toBe(true);

    // The next locate() for the same session finds exactly what write() wrote.
    await expect(source.locate('sess-resume')).resolves.toBe(
      join(root, '.claude', 'projects', slug, 'sess-resume.jsonl'),
    );
  });
});

describe('encodeProjectSlug', () => {
  it('mirrors the SDK encoding (realpath cwd → non-alnum to dash)', () => {
    expect(encodeProjectSlug('/agent')).toBe('-agent');
    expect(encodeProjectSlug('/var/lib/ax')).toBe('-var-lib-ax');
  });

  it('truncates + hash-suffixes an over-200-char path (SDK P0 cap)', () => {
    const longPath = '/' + 'a'.repeat(250);
    const slug = encodeProjectSlug(longPath);
    // dashed = '-' + 250 'a' = 251 chars > 200 → truncate to 200 + '-' + hash.
    const dashed = longPath.replace(/[^a-zA-Z0-9]/g, '-');
    // Reproduce the SDK's djb2-style hash to pin the exact suffix.
    let h = 0;
    for (let i = 0; i < longPath.length; i++) {
      h = ((h << 5) - h + longPath.charCodeAt(i)) | 0;
    }
    const expected = `${dashed.slice(0, 200)}-${Math.abs(h).toString(36)}`;
    expect(slug).toBe(expected);
    expect(slug.startsWith(dashed.slice(0, 200))).toBe(true);
  });
});
