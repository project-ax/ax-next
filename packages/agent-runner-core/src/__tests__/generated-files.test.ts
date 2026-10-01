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
    await fs.writeFile(path.join(dir, 'old.txt'), 'old');
    const call = vi.fn(async () => ({ artifactId: 'id', downloadUrl: 'ax://artifact/id' }));
    const callBinaryUpload = vi.fn(async () => ({ sha256: 'a'.repeat(64), size: 5 }));
    const tracker = await trackGeneratedFiles({ root: dir, warn: vi.fn(),
      publish: createArtifactPublishExecutor({ userFilesRoot: dir, conversationId: 'c1', client: { call, callBinaryUpload } }),
    });
    for (const sub of ['reports', '.config', 'node_modules', 'venv', '__pycache__']) {
      await fs.mkdir(path.join(dir, sub));
      await fs.writeFile(path.join(dir, sub, 'result.txt'), 'hello');
    }
    const blocks = await tracker.collect();
    expect(blocks).toEqual([{ type: 'attachment', path: 'reports/result.txt', displayName: 'result.txt', mediaType: 'text/plain', sizeBytes: 5 }]);
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
    const file = { path: 'a.txt', displayName: 'a.txt', mediaType: 'text/plain', sizeBytes: 0 };
    expect(publishedAttachments([
      { type: 'tool_use', id: 'p', name: 'mcp__ax-sandbox-tools__artifact_publish', input: {} },
    ], [
      { type: 'tool_result', tool_use_id: 'p', content: [{ type: 'text', text: JSON.stringify(file) }] },
      { type: 'tool_result', tool_use_id: 'unknown', content: JSON.stringify(file) },
      { type: 'tool_result', tool_use_id: 'p', is_error: true, content: JSON.stringify(file) },
    ])).toEqual([{ type: 'attachment', ...file }]);
  });
});
