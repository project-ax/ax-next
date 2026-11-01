import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolCall } from '@ax/ipc-protocol';
import { MAX_ARTIFACT_BYTES } from '@ax/tool-artifact-publish';
import { agentFileReference, trackGeneratedFiles, publishedAttachments } from '../generated-files.js';

const roots: string[] = [];
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-generated-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

/** A tracker over `dir`, with spies on the gate, the post-call report and the warning. */
async function track(dir: string, gate: (call: ToolCall) => Promise<void> = async () => {}) {
  const admit = vi.fn(gate);
  const attached = vi.fn(async (_call: ToolCall, _chip: unknown) => {});
  const warn = vi.fn();
  const tracker = await trackGeneratedFiles({ root: dir, admit, attached, warn });
  return { tracker, admit, attached, warn };
}

const NOT_ATTACHED = {
  type: 'text',
  text: 'Some new files could not be attached. Ask the agent to attach them again.',
};

describe('generated files', () => {
  it('attaches new nested files by their key', async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, 'old.txt'), 'old');
    const { tracker, admit, attached } = await track(dir);
    const notes = '# notes\nmore\n';
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'new.md'), notes);
    for (const sub of ['.config', 'node_modules', 'venv', '__pycache__']) {
      await fs.mkdir(path.join(dir, sub));
      await fs.writeFile(path.join(dir, sub, 'result.txt'), 'hello');
    }
    await fs.writeFile(path.join(dir, 'docs', 'module.pyc'), 'bytecode');
    // The chip names the file by its key in the agent's files: no id, no copy,
    // and no sandbox path.
    const chip = { type: 'agent_file', path: 'docs/new.md', mediaType: 'text/markdown', sizeBytes: Buffer.byteLength(notes) };
    expect(await tracker.collect()).toEqual([chip]);
    // The gate saw the call that is then reported with the chip as its outcome.
    expect(admit).toHaveBeenCalledOnce();
    const call = admit.mock.calls[0]![0];
    expect(call).toMatchObject({ name: 'artifact_publish', input: { path: path.join(dir, 'docs', 'new.md') } });
    expect(attached).toHaveBeenCalledOnce();
    expect(attached).toHaveBeenCalledWith(call, chip);
    expect(await tracker.collect()).toEqual([]);
    // A fresh process (reload/resume) does not reattach the old outputs.
    const resumed = await track(dir);
    expect(await resumed.tracker.collect()).toEqual([]);
    expect(resumed.admit).not.toHaveBeenCalled();
  });

  it('attaches a file over the old publish cap without reading its bytes', async () => {
    // A reference copies nothing, so the 100 MiB copy cap does not apply. The
    // file is sparse and, for a non-root runner, unreadable: only its metadata
    // is looked at. The download route answers for size.
    const dir = await root();
    const { tracker } = await track(dir);
    const big = path.join(dir, 'video.mp4');
    await fs.writeFile(big, '');
    await fs.truncate(big, MAX_ARTIFACT_BYTES + 1);
    await fs.chmod(big, 0o000);
    expect(await tracker.collect()).toEqual([
      { type: 'agent_file', path: 'video.mp4', mediaType: 'video/mp4', sizeBytes: MAX_ARTIFACT_BYTES + 1 },
    ]);
  });

  it('never attaches file or directory symlinks', async () => {
    const dir = await root();
    const outside = await root();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    const { tracker, admit, attached } = await track(dir);
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'secret.txt'));
    await fs.symlink(outside, path.join(dir, 'outside'));
    expect(await tracker.collect()).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
    expect(attached).not.toHaveBeenCalled();
  });

  it('skips a file the model already published', async () => {
    const dir = await root();
    const { tracker, admit } = await track(dir);
    await fs.mkdir(path.join(dir, 'out'));
    await fs.writeFile(path.join(dir, 'out', 'a.txt'), 'a');
    const explicit = publishedAttachments(
      [{ type: 'tool_use', id: 'p', name: 'artifact_publish', input: {} }],
      [{ type: 'tool_result', tool_use_id: 'p', content: JSON.stringify(RESULT) }],
    );
    expect(await tracker.collect(explicit.paths)).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it('a gate refusal attaches nothing and says so', async () => {
    const dir = await root();
    const { tracker, attached, warn } = await track(dir, async () => { throw new Error('publication not allowed'); });
    await fs.writeFile(path.join(dir, 'refused.txt'), 'b');
    expect(await tracker.collect()).toEqual([NOT_ATTACHED]);
    expect(attached).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('a name the Files tab cannot address is reported, not attached', async () => {
    // A chip for `notes: q3.md` could only ever fail to download. The other
    // new file is still attached.
    const dir = await root();
    const { tracker, attached, warn } = await track(dir);
    await fs.writeFile(path.join(dir, 'notes: q3.md'), 'q3');
    await fs.writeFile(path.join(dir, 'fine.md'), 'ok');
    expect(await tracker.collect()).toEqual([
      { type: 'agent_file', path: 'fine.md', mediaType: 'text/markdown', sizeBytes: 2 },
      NOT_ATTACHED,
    ]);
    expect(attached).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
  });

  it('fails closed when the initial baseline is unavailable', async () => {
    const dir = path.join(await root(), 'missing');
    const { tracker, admit } = await track(dir);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'old.txt'), 'old');
    expect(await tracker.collect()).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
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
});

describe('agentFileReference', () => {
  it('names a regular file by its key with / separators', async () => {
    const dir = await root();
    await fs.mkdir(path.join(dir, 'reports', 'q3'), { recursive: true });
    await fs.writeFile(path.join(dir, 'reports', 'q3', 'Q3 plan #1 (50%).pdf'), 'pdf!');
    expect(await agentFileReference(dir, path.join('reports', 'q3', 'Q3 plan #1 (50%).pdf'))).toEqual({
      type: 'agent_file', path: 'reports/q3/Q3 plan #1 (50%).pdf', mediaType: 'application/pdf', sizeBytes: 4,
    });
  });

  // Each case fails exactly one check: the link points INSIDE the root, so
  // only the symlink refusal stops it; the folder is inside the root and has a
  // valid key, so only the regular-file check does; the escaping folder link
  // reaches a regular file with a valid key, so only containment does.
  it('refuses a symlink even to a file inside the agent files', async () => {
    const dir = await root();
    await fs.writeFile(path.join(dir, 'real.txt'), 'real');
    await fs.symlink(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
    await expect(agentFileReference(dir, 'link.txt')).rejects.toThrow();
  });

  it('refuses a folder', async () => {
    const dir = await root();
    await fs.mkdir(path.join(dir, 'folder'));
    await expect(agentFileReference(dir, 'folder')).rejects.toThrow();
  });

  it('refuses a file reached through a folder link that leaves the agent files', async () => {
    const dir = await root();
    const outside = await root();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(dir, 'escape'));
    await expect(agentFileReference(dir, path.join('escape', 'secret.txt'))).rejects.toThrow();
  });

  it('refuses a file that is gone', async () => {
    const dir = await root();
    await expect(agentFileReference(dir, 'missing.txt')).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('refuses a name the Files tab cannot address', async () => {
    const dir = await root();
    for (const name of ['notes: q3.md', 'a..b.txt']) {
      await fs.writeFile(path.join(dir, name), 'x');
      await expect(agentFileReference(dir, name)).rejects.toThrow();
    }
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
