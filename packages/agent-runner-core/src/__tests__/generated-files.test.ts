import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { trackGeneratedFiles, publishedAttachments } from '../generated-files.js';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';

const roots: string[] = [];
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-generated-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe('generated files', () => {
  it('publishes new nested files durably once, leaving existing files and caches alone', async () => {
    const dir = await root();
    const scratch = await root();
    await fs.writeFile(path.join(dir, 'old.txt'), 'old');
    const call = vi.fn(async () => ({ artifactId: 'id', downloadUrl: 'ax://artifact/id' }));
    const callBinaryUpload = vi.fn(async () => ({ sha256: 'a'.repeat(64), size: 5 }));
    const tracker = await trackGeneratedFiles({ root: dir, warn: vi.fn(),
      publish: createArtifactPublishExecutor({ userFilesRoot: dir, ephemeralRoot: scratch, conversationId: 'c1', client: { call, callBinaryUpload } }),
    });
    for (const sub of ['reports', '.config', 'node_modules', 'venv', '__pycache__']) {
      await fs.mkdir(path.join(dir, sub));
      await fs.writeFile(path.join(dir, sub, 'result.txt'), 'hello');
    }
    const blocks = await tracker.collect();
    // The chip names the artifact by id; where it sat in the sandbox stays here.
    expect(blocks).toEqual([{ type: 'attachment', attachmentId: 'id', filename: 'result.txt', mediaType: 'text/plain', sizeBytes: 5 }]);
    expect(callBinaryUpload).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('artifact.publish', expect.objectContaining({ conversationId: 'c1', path: 'reports/result.txt' }));
    expect(await tracker.collect()).toEqual([]);
    // A fresh process (reload/resume) does not reattach the old outputs.
    const resumed = await trackGeneratedFiles({ root: dir, warn: vi.fn(), publish: vi.fn() });
    expect(await resumed.collect()).toEqual([]);
  });

  it('never publishes file or directory symlinks', async () => {
    const dir = await root();
    const outside = await root();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    const publish = vi.fn();
    const tracker = await trackGeneratedFiles({ root: dir, publish, warn: vi.fn() });
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'secret.txt'));
    await fs.symlink(outside, path.join(dir, 'outside'));
    expect(await tracker.collect()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not upload explicitly published files again and reports per-file failures', async () => {
    const dir = await root();
    const publish = vi.fn().mockRejectedValue(new Error('refused'));
    const tracker = await trackGeneratedFiles({ root: dir, publish, warn: vi.fn() });
    await fs.writeFile(path.join(dir, 'explicit.txt'), 'a');
    await fs.writeFile(path.join(dir, 'refused.txt'), 'b');
    expect(await tracker.collect(['explicit.txt'])).toEqual([expect.objectContaining({ type: 'text' })]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('fails closed when the initial baseline is unavailable', async () => {
    const dir = path.join(await root(), 'missing');
    const publish = vi.fn();
    const tracker = await trackGeneratedFiles({ root: dir, publish, warn: vi.fn() });
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'old.txt'), 'old');
    expect(await tracker.collect()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('recognizes only successful publish results, including SDK text blocks', () => {
    expect(publishedAttachments([
      { type: 'tool_use', id: 'p', name: 'mcp__ax-sandbox-tools__artifact_publish', input: {} },
    ], [
      { type: 'tool_result', tool_use_id: 'p', content: [{ type: 'text', text: JSON.stringify(RESULT) }] },
      { type: 'tool_result', tool_use_id: 'unknown', content: JSON.stringify(RESULT) },
      { type: 'tool_result', tool_use_id: 'p', is_error: true, content: JSON.stringify(RESULT) },
    ])).toEqual({ blocks: [CHIP], paths: ['out/a.txt'] });
  });

  it('artifact chips carry the artifactId, not a path', () => {
    const { blocks } = publishedAttachments(
      [{ type: 'tool_use', id: 'p', name: 'artifact_publish', input: {} }],
      [{ type: 'tool_result', tool_use_id: 'p', content: JSON.stringify(RESULT) }],
    );
    expect(blocks).toEqual([CHIP]);
    expect(blocks.every(block => !('path' in block))).toBe(true);
  });

  it('a publish result that cannot name its artifact attaches nothing', () => {
    // The result rides a tool_result, so every field is checked again here.
    for (const bad of [{ ...RESULT, artifactId: '../x' }, { ...RESULT, displayName: '' }, { path: 'out/a.txt' }]) {
      expect(publishedAttachments(
        [{ type: 'tool_use', id: 'p', name: 'artifact_publish', input: {} }],
        [{ type: 'tool_result', tool_use_id: 'p', content: JSON.stringify(bad) }],
      )).toEqual({ blocks: [], paths: [] });
    }
  });

  it('auto-attach skips, by path, a file the model already published', async () => {
    const dir = await root();
    const publish = vi.fn();
    const tracker = await trackGeneratedFiles({ root: dir, publish, warn: vi.fn() });
    await fs.mkdir(path.join(dir, 'out'));
    await fs.writeFile(path.join(dir, 'out', 'a.txt'), 'a');
    const explicit = publishedAttachments(
      [{ type: 'tool_use', id: 'p', name: 'artifact_publish', input: {} }],
      [{ type: 'tool_result', tool_use_id: 'p', content: JSON.stringify(RESULT) }],
    );
    expect(await tracker.collect(explicit.paths)).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a generated file whose publish result cannot be a chip is reported, not attached', async () => {
    const dir = await root();
    const publish = vi.fn(async () => ({ ...RESULT, artifactId: 'not/an/id' }));
    const warn = vi.fn();
    const tracker = await trackGeneratedFiles({ root: dir, publish, warn });
    await fs.writeFile(path.join(dir, 'new.txt'), 'n');
    expect(await tracker.collect()).toEqual([expect.objectContaining({ type: 'text' })]);
    expect(warn).toHaveBeenCalled();
  });
});

/** An `artifact_publish` result as the executor returns it. */
const RESULT = {
  artifactId: '0123456789abcdef',
  downloadUrl: 'ax://artifact/0123456789abcdef',
  path: 'out/a.txt',
  displayName: 'a.txt',
  mediaType: 'text/plain',
  sizeBytes: 1,
  sha256: 'a'.repeat(64),
};
const CHIP = {
  type: 'attachment',
  attachmentId: '0123456789abcdef',
  filename: 'a.txt',
  mediaType: 'text/plain',
  sizeBytes: 1,
};
