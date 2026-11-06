import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { attachmentBlockFromArtifact } from '@ax/ipc-protocol';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';

// The executor validates against the session's REAL files root, so these tests
// use a real temp directory as the root and pass real paths — the same thing
// the model does, since the operating notes hand it the real path.

let files: string;

beforeEach(async () => {
  files = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-files-'));
});

async function write(root: string, rel: string, bytes: Buffer | string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

/** A host that answers like `artifact.publish` does: id, version, title, kind, extension. */
function mockClient(answer: Record<string, unknown> = {}) {
  const calls: { put: Buffer[]; publish: { action: string; payload: unknown }[] } = { put: [], publish: [] };
  const client = {
    callBinaryUpload: async (_action: string, bytes: Buffer) => {
      calls.put.push(bytes);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    },
    call: async (action: string, payload: unknown) => {
      calls.publish.push({ action, payload });
      const p = payload as { title: string };
      return { artifactId: 'art_1', version: 1, title: p.title, kind: 'document', extension: 'PDF', ...answer };
    },
  };
  return { client: client as never, calls };
}

function executor(over: { conversationId?: string | null; answer?: Record<string, unknown> } = {}) {
  const { client, calls } = mockClient(over.answer);
  const exec = createArtifactPublishExecutor({
    userFilesRoot: files,
    client,
    conversationId: 'conversationId' in over ? over.conversationId : 'conv-1',
  });
  return { exec, calls };
}

const call = (input: unknown) => ({ id: 'toolu_1', name: 'artifact_publish', input }) as never;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('artifact_publish executor: what it sends and returns', () => {
  it('sends {conversationId, sha256, path: <relative>, title, artifactId} and nothing else', async () => {
    await write(files, 'reports/Q4.pdf', 'hello pdf');
    const { exec, calls } = executor();
    await exec(call({ path: path.join(files, 'reports/Q4.pdf'), title: 'Q4 report' }));
    await exec(call({ path: path.join(files, 'reports/Q4.pdf'), title: 'Q4 report', artifactId: 'art_1' }));
    expect(calls.put.map(String)).toEqual(['hello pdf', 'hello pdf']);
    expect(calls.publish).toEqual([
      {
        action: 'artifact.publish',
        payload: { conversationId: 'conv-1', sha256: sha('hello pdf'), path: 'reports/Q4.pdf', title: 'Q4 report' },
      },
      {
        action: 'artifact.publish',
        payload: {
          conversationId: 'conv-1', sha256: sha('hello pdf'), path: 'reports/Q4.pdf', title: 'Q4 report', artifactId: 'art_1',
        },
      },
    ]);
  });

  it('returns url ax://artifact/<id> and the relative path, and never a share code', async () => {
    await write(files, 'reports/Q4.pdf', 'hello pdf');
    // A host answer carrying more than the wire allows still yields only the named fields.
    const { exec } = executor({ answer: { version: 3, title: 'Stored title', shareCode: 'A'.repeat(32) } });
    const out = await exec(call({ path: path.join(files, 'reports/Q4.pdf'), title: 'Q4 report' }));
    expect(out).toEqual({
      artifactId: 'art_1',
      version: 3,
      title: 'Stored title',
      kind: 'document',
      extension: 'PDF',
      url: 'ax://artifact/art_1',
      path: 'reports/Q4.pdf',
    });
    expect(JSON.stringify(out)).not.toContain('A'.repeat(32));
  });

  it('its output makes no attachment block', async () => {
    await write(files, 'r.pdf', 'x');
    const { exec } = executor();
    const out = await exec(call({ path: path.join(files, 'r.pdf'), title: 'R' }));
    expect(attachmentBlockFromArtifact(out)).toBeNull();
  });

  // P6: the agent's artifact list names files relative to the files folder.
  it('takes a relative path relative to the files folder', async () => {
    await write(files, 'reports/q3.pdf', 'q3');
    const { exec, calls } = executor();
    const out = await exec(call({ path: 'reports/q3.pdf', title: 'Q3' }));
    expect(out.path).toBe('reports/q3.pdf');
    expect(calls.publish[0]!.payload).toMatchObject({ path: 'reports/q3.pdf', sha256: sha('q3') });
  });

  it('refuses a relative path that climbs out of the files folder', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'no');
    const { exec, calls } = executor();
    const rel = path.relative(files, path.join(outside, 'secret.txt'));
    expect(rel.startsWith('..')).toBe(true);
    await expect(exec(call({ path: rel, title: 'S' }))).rejects.toThrow(/artifact-path-not-publishable/);
    expect(calls.put).toHaveLength(0);
  });
});

describe('artifact_publish executor: input checks, before any byte leaves', () => {
  it('refuses a missing or blank title', async () => {
    await write(files, 'r.pdf', 'x');
    const { exec, calls } = executor();
    for (const title of [undefined, '', '   ', 7]) {
      await expect(exec(call({ path: path.join(files, 'r.pdf'), title }))).rejects.toThrow(/title is required/);
    }
    expect(calls.put).toHaveLength(0);
  });

  it('refuses a title over 200 characters', async () => {
    await write(files, 'r.pdf', 'x');
    const { exec, calls } = executor();
    await expect(exec(call({ path: path.join(files, 'r.pdf'), title: 'a'.repeat(201) }))).rejects.toThrow(/title too long/);
    expect(calls.put).toHaveLength(0);
  });

  it('refuses a non-string artifactId', async () => {
    await write(files, 'r.pdf', 'x');
    const { exec } = executor();
    await expect(exec(call({ path: path.join(files, 'r.pdf'), title: 'R', artifactId: 5 }))).rejects.toThrow(/artifactId/);
  });

  it('refuses a path holding a control or bidi character', async () => {
    const { exec, calls } = executor();
    for (const name of ['a\u0007b.md', 'evil\u202Efdp.exe', 'x\u2028y.md', 'z\u200Bw.md']) {
      await write(files, name, 'x');
      await expect(exec(call({ path: path.join(files, name), title: 'T' }))).rejects.toThrow(/control or invisible/);
    }
    expect(calls.put).toHaveLength(0);
  });

  it('refuses when the session is bound to no conversation', async () => {
    await write(files, 'r.pdf', 'x');
    const { exec, calls } = executor({ conversationId: null });
    await expect(exec(call({ path: path.join(files, 'r.pdf'), title: 'R' }))).rejects.toThrow(/not bound to a conversation/);
    expect(calls.put).toHaveLength(0);
  });

  it('rejects non-object / missing path input', async () => {
    const { exec } = executor();
    await expect(exec(call({}))).rejects.toThrow(/path/);
    await expect(exec(call(undefined))).rejects.toThrow(/path/);
  });
});

describe('artifact_publish executor: only the files folder (C2)', () => {
  it('refuses a scratch artifacts/ path', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-eph-'));
    const abs = await write(scratch, 'artifacts/draft.png', 'img');
    const { exec, calls } = executor();
    await expect(exec(call({ path: abs, title: 'Draft' }))).rejects.toThrow(/^artifact-path-not-publishable:/);
    expect(calls.put).toHaveLength(0);
  });

  it('refuses scratch uploads and transcripts, and a link in the files folder that leads to them', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-scratch-'));
    const upload = await write(scratch, 'uploads/a.pdf', 'the person file');
    const transcript = await write(scratch, 'transcripts/s.jsonl', '{"type":"user"}\n');
    const { exec, calls } = executor();
    for (const p of [upload, transcript]) {
      await expect(exec(call({ path: p, title: 'T' }))).rejects.toThrow(/artifact-path-not-publishable/);
    }
    await fs.symlink(transcript, path.join(files, 'x.jsonl'));
    await expect(exec(call({ path: path.join(files, 'x.jsonl'), title: 'T' }))).rejects.toThrow(/symlink/i);
    await fs.symlink(path.join(scratch, 'uploads'), path.join(files, 'u'));
    await expect(exec(call({ path: path.join(files, 'u/a.pdf'), title: 'T' }))).rejects.toThrow(
      /resolved outside the files folder/,
    );
    expect(calls.put).toHaveLength(0);
  });

  it('rejects paths outside the files folder, naming the real root', async () => {
    const { exec } = executor();
    await expect(exec(call({ path: '/etc/passwd', title: 'P' }))).rejects.toThrow(
      new RegExp(`artifact-path-not-publishable: path must be under ${files.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\*\\*`),
    );
  });

  it("rejects another agent's files folder (only this session's is publishable)", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-files-other-'));
    await write(other, 'x.pdf', 'not this session');
    const { exec, calls } = executor();
    await expect(exec(call({ path: path.join(other, 'x.pdf'), title: 'X' }))).rejects.toThrow(
      /artifact-path-not-publishable/,
    );
    expect(calls.put).toHaveLength(0);
  });

  it('refuses a real file in a sibling memory tree, directly and through a link in the files folder', async () => {
    const t = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-mem-'));
    const filesRoot = path.join(t, 'files');
    await fs.mkdir(filesRoot, { recursive: true });
    const factFile = await write(t, 'memory/facts/a.md', 'real fact bytes');
    const { client } = mockClient();
    const exec = createArtifactPublishExecutor({ userFilesRoot: filesRoot, client, conversationId: 'conv-1' });
    await expect(exec(call({ path: factFile, title: 'F' }))).rejects.toThrow(/artifact-path-not-publishable/);
    // The link passes the lexical allowlist; the realpath containment re-check refuses it.
    await fs.symlink(path.join(t, 'memory'), path.join(filesRoot, 'mem'));
    await expect(exec(call({ path: path.join(filesRoot, 'mem/facts/a.md'), title: 'F' }))).rejects.toThrow(
      /^artifact_publish: resolved outside the files folder/,
    );
  });
});

describe('artifact_publish executor: the file itself', () => {
  it('rejects a symlinked final component', async () => {
    const real = await write(files, 'real.txt', 'r');
    await fs.symlink(real, path.join(files, 'link.txt'));
    const { exec, calls } = executor();
    await expect(exec(call({ path: path.join(files, 'link.txt'), title: 'L' }))).rejects.toThrow(/symlink/i);
    expect(calls.put).toHaveLength(0);
  });

  // The textual allowlist does no I/O, so it cannot see that a directory is a
  // symlink; `lstat` declines to follow only the FINAL component. The agent
  // writes every byte of its own folder, so planting one is trivial — the
  // executor's realpath containment is what actually enforces "inside".
  it('rejects a path that escapes through a symlinked INTERMEDIATE directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.symlink(outside, path.join(files, 'escape'));
    const { exec, calls } = executor();
    await expect(exec(call({ path: path.join(files, 'escape/secret.txt'), title: 'S' }))).rejects.toThrow(
      /resolved outside the files folder/,
    );
    expect(calls.put).toHaveLength(0);
  });

  it('still publishes through a symlinked directory that stays INSIDE the folder', async () => {
    await write(files, 'real/deck.pdf', 'x');
    await fs.symlink(path.join(files, 'real'), path.join(files, 'alias'));
    const { exec } = executor();
    const out = await exec(call({ path: path.join(files, 'alias/deck.pdf'), title: 'Deck' }));
    expect(out.path).toBe('alias/deck.pdf');
  });

  it('rejects directories', async () => {
    await fs.mkdir(path.join(files, 'dir'), { recursive: true });
    const { exec } = executor();
    await expect(exec(call({ path: path.join(files, 'dir'), title: 'D' }))).rejects.toThrow(/not a regular file/i);
  });

  it('rejects files larger than 100 MiB', async () => {
    // A sparse file: lstat sees the full size and the executor refuses before any read.
    const abs = await write(files, 'big.bin', Buffer.alloc(0));
    await fs.truncate(abs, 100 * 1024 * 1024 + 1);
    const { exec, calls } = executor();
    await expect(exec(call({ path: abs, title: 'B' }))).rejects.toThrow(/100 MiB|too large/i);
    expect(calls.put).toHaveLength(0);
  });

  it('rejects missing files', async () => {
    const { exec } = executor();
    await expect(exec(call({ path: path.join(files, 'nope.txt'), title: 'N' }))).rejects.toThrow(/not found|ENOENT/i);
  });
});
