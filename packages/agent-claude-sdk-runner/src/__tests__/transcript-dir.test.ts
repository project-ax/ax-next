import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { prepareTranscriptDir, sdkTranscriptDir } from '../transcript-dir.js';

// The Anthropic SDK writes its per-session turn transcripts to
// `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sid>.jsonl`, and that path is
// hard-coded (no env override). When the sandbox stamps a transcripts root, the
// runner points `$CLAUDE_CONFIG_DIR/projects` at it with a symlink, so the
// writes land on pod-private disk instead of the tmpfs under /home/runner.
// Without a transcripts root the SDK's own projects dir is used as-is.

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(tmpdir(), 'ax-transcript-dir-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('sdkTranscriptDir', () => {
  it('is the stamped transcripts root when there is one', () => {
    expect(
      sdkTranscriptDir({ claudeConfigDir: '/cfg', transcriptsRoot: '/tmp/transcripts' }),
    ).toBe('/tmp/transcripts');
  });

  it("falls back to the SDK's own $CLAUDE_CONFIG_DIR/projects", () => {
    expect(sdkTranscriptDir({ claudeConfigDir: '/cfg' })).toBe('/cfg/projects');
  });
});

describe('prepareTranscriptDir', () => {
  it('without a transcripts root, the SDK projects dir is a plain directory', async () => {
    const claudeConfigDir = path.join(scratch, 'session');
    await fs.mkdir(claudeConfigDir, { recursive: true });

    await prepareTranscriptDir({ claudeConfigDir });

    const st = await fs.lstat(path.join(claudeConfigDir, 'projects'));
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
  });

  it('with a transcripts root, $CLAUDE_CONFIG_DIR/projects links to it and SDK writes land in the root', async () => {
    const claudeConfigDir = path.join(scratch, 'session');
    const transcriptsRoot = path.join(scratch, 'transcripts');
    await fs.mkdir(claudeConfigDir, { recursive: true });

    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });

    const linkPath = path.join(claudeConfigDir, 'projects');
    expect(await fs.readlink(linkPath)).toBe(transcriptsRoot);
    // The root exists (the SDK's mkdir over the link would hit ENOENT on the
    // chain otherwise) and is private to the runner's user.
    const st = await fs.stat(transcriptsRoot);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);

    // What the SDK actually does: mkdir + append under the link path.
    const sdkPath = path.join(linkPath, '-files', 'abc123.jsonl');
    await fs.mkdir(path.dirname(sdkPath), { recursive: true });
    await fs.writeFile(sdkPath, '{"turn":1}\n');
    expect(
      await fs.readFile(path.join(transcriptsRoot, '-files', 'abc123.jsonl'), 'utf8'),
    ).toBe('{"turn":1}\n');
  });

  it('creates the claudeConfigDir parent if it does not already exist (defensive)', async () => {
    const claudeConfigDir = path.join(scratch, 'home', 'runner', '.ax', 'session');
    const transcriptsRoot = path.join(scratch, 'transcripts');

    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });

    expect(await fs.readlink(path.join(claudeConfigDir, 'projects'))).toBe(transcriptsRoot);
  });

  it('is idempotent: a second call leaves the correct link in place', async () => {
    const claudeConfigDir = path.join(scratch, 'session');
    const transcriptsRoot = path.join(scratch, 'transcripts');
    await fs.mkdir(claudeConfigDir, { recursive: true });

    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });
    const before = await fs.lstat(path.join(claudeConfigDir, 'projects'));
    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });
    const after = await fs.lstat(path.join(claudeConfigDir, 'projects'));

    expect(await fs.readlink(path.join(claudeConfigDir, 'projects'))).toBe(transcriptsRoot);
    // Same inode: it was left untouched, not removed and recreated.
    expect(after.ino).toBe(before.ino);
  });

  it('replaces a stale regular file at the link path', async () => {
    const claudeConfigDir = path.join(scratch, 'session');
    const transcriptsRoot = path.join(scratch, 'transcripts');
    await fs.mkdir(claudeConfigDir, { recursive: true });
    await fs.writeFile(path.join(claudeConfigDir, 'projects'), 'leftover');

    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });

    expect(await fs.readlink(path.join(claudeConfigDir, 'projects'))).toBe(transcriptsRoot);
  });

  it('replaces a stale directory at the link path', async () => {
    const claudeConfigDir = path.join(scratch, 'session');
    const transcriptsRoot = path.join(scratch, 'transcripts');
    await fs.mkdir(path.join(claudeConfigDir, 'projects', 'foo'), { recursive: true });
    await fs.writeFile(path.join(claudeConfigDir, 'projects', 'foo', 'bar.jsonl'), '{}');

    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });

    expect(await fs.readlink(path.join(claudeConfigDir, 'projects'))).toBe(transcriptsRoot);
  });

  it('replaces a dangling link and a link to the wrong place', async () => {
    const claudeConfigDir = path.join(scratch, 'session');
    const transcriptsRoot = path.join(scratch, 'transcripts');
    await fs.mkdir(claudeConfigDir, { recursive: true });
    const linkPath = path.join(claudeConfigDir, 'projects');

    // Dangling: points at something that does not exist.
    await fs.symlink(path.join(scratch, 'gone'), linkPath);
    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });
    expect(await fs.readlink(linkPath)).toBe(transcriptsRoot);

    // Live, but at the wrong directory.
    const elsewhere = path.join(scratch, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.rm(linkPath);
    await fs.symlink(elsewhere, linkPath);
    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });
    expect(await fs.readlink(linkPath)).toBe(transcriptsRoot);
  });

  it('a root equal to $CLAUDE_CONFIG_DIR/projects stays a directory and keeps its contents', async () => {
    const claudeConfigDir = path.join(scratch, 'session');
    const transcriptsRoot = path.join(claudeConfigDir, 'projects');
    await fs.mkdir(path.join(transcriptsRoot, 'slug'), { recursive: true });
    await fs.writeFile(path.join(transcriptsRoot, 'slug', 's.jsonl'), '{}');

    await prepareTranscriptDir({ claudeConfigDir, transcriptsRoot });

    const st = await fs.lstat(transcriptsRoot);
    expect(st.isDirectory()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(transcriptsRoot, 'slug', 's.jsonl'), 'utf8')).toBe('{}');
  });
});
