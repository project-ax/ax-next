import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJsonlTranscriptSource,
  encodeProjectSlug,
  locateJsonl,
} from '../jsonl-transcript-source.js';

describe('createJsonlTranscriptSource', () => {
  it('reads the jsonl bytes from under an unknown project slug', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const transcriptDir = join(root, 'transcripts');
    const dir = join(transcriptDir, '-some-encoded-slug');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sess-1.jsonl'), '{"type":"user"}\n');

    const source = createJsonlTranscriptSource(transcriptDir, root);
    // The seam hands core BYTES, not a path — core must not learn that this
    // runner's transcript is a file at all.
    const bytes = await source.read('sess-1');
    expect(bytes?.toString('utf8')).toBe('{"type":"user"}\n');
    // The walk that found it is still exported for turn-end-uuid.ts.
    await expect(locateJsonl(transcriptDir, 'sess-1')).resolves.toBe(
      join(dir, 'sess-1.jsonl'),
    );
  });

  it('read returns null when no transcript exists yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const source = createJsonlTranscriptSource(join(root, 'transcripts'), root);
    await expect(source.read('sess-missing')).resolves.toBeNull();
  });

  it('write puts bytes at the SDK slug path and creates the directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const transcriptDir = join(root, 'transcripts');
    const source = createJsonlTranscriptSource(transcriptDir, root);
    const bytes = Buffer.from('u1\na1\na2\n', 'utf8');

    // The SDK jsonl is opaque to this source, so it can never refuse bytes.
    await expect(source.write('sess-resume', bytes)).resolves.toBe('accepted');

    // This is the SDK-private on-disk layout `restoreTranscriptForResume` in
    // @ax/agent-runner-core no longer knows about — it's entirely this
    // source's responsibility now.
    const slug = encodeProjectSlug(await realpath(root));
    const written = await readFile(
      join(transcriptDir, slug, 'sess-resume.jsonl'),
    );
    expect(written.equals(bytes)).toBe(true);

    // The next read() for the same session returns exactly what write() wrote.
    const roundTripped = await source.read('sess-resume');
    expect(roundTripped?.equals(bytes)).toBe(true);
  });

  it('write keys the project dir on the SDK cwd, not on the transcript directory', async () => {
    // The SDK reads `projects/<slug(cwd)>/<sid>.jsonl`, where cwd is the dir it
    // runs in (the agent home, /files), NOT the transcript directory. A restore
    // keyed on any other slug is invisible to it and every resumed turn dies
    // with "No conversation found with session ID". Reproduced against the
    // real SDK 0.2.119.
    const root = await mkdtemp(join(tmpdir(), 'jsonl-src-'));
    const transcriptDir = join(root, 'transcripts');
    const sdkCwd = join(root, 'files');
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(sdkCwd, { recursive: true });
    const source = createJsonlTranscriptSource(transcriptDir, sdkCwd);
    const bytes = Buffer.from('u1\na1\n', 'utf8');

    await expect(source.write('sess-files', bytes)).resolves.toBe('accepted');

    const projects = transcriptDir;
    const sdkSlug = encodeProjectSlug(await realpath(sdkCwd));
    const written = await readFile(join(projects, sdkSlug, 'sess-files.jsonl'));
    expect(written.equals(bytes)).toBe(true);
    // Nothing lands under any other slug: that is where the SDK does
    // NOT look, and a stale copy there could shadow the real one in locateJsonl.
    expect(await readdir(projects)).toEqual([sdkSlug]);
    // The delta-ship reader still finds it (it walks every slug dir).
    expect((await source.read('sess-files'))?.equals(bytes)).toBe(true);
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
