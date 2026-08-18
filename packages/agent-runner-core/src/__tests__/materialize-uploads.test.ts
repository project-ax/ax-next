import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  materializeUploads,
  resolveMaterializedPath,
} from '../materialize-uploads.js';

describe('resolveMaterializedPath', () => {
  // TASK-78: uploads materialize at the ADVERTISED workspace path
  // (`<workspaceRoot>/.ax/uploads/<rest>`) — same path the system prompt tells
  // the model — so the `.ax/` prefix is KEPT (not dropped under an ephemeral
  // root). The base is the workspace's `.ax/uploads` dir.
  const base = '/agent/.ax/uploads';

  it('maps a transcript upload key under the uploads base (keeps .ax/)', () => {
    expect(resolveMaterializedPath(base, '.ax/uploads/c/t/file.pdf')).toBe(
      path.join(base, 'c', 't', 'file.pdf'),
    );
  });

  it('rejects a non-upload key', () => {
    expect(resolveMaterializedPath(base, 'workspace/x.pdf')).toBeNull();
  });

  it('rejects a .. traversal segment (containment)', () => {
    expect(resolveMaterializedPath(base, '.ax/uploads/../../../etc/passwd')).toBeNull();
    expect(resolveMaterializedPath(base, '.ax/uploads/c/../../escape')).toBeNull();
  });

  it('rejects an empty / dot-only segment', () => {
    expect(resolveMaterializedPath(base, '.ax/uploads/c//file')).toBeNull();
    expect(resolveMaterializedPath(base, '.ax/uploads/')).toBeNull();
  });
});

describe('materializeUploads', () => {
  let workspace: string;
  let uploadsBase: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-mat-up-'));
    uploadsBase = path.join(workspace, '.ax', 'uploads');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  function mockClient(opts: {
    files: Array<{ path: string; sha256: string; mediaType: string; displayName: string; sizeBytes: number }>;
    blobs: Record<string, Buffer | undefined>;
  }) {
    const tmpFiles: string[] = [];
    const client = {
      call: async (_action: string, _payload: unknown) => ({ files: opts.files }),
      callBinary: async (_action: string, payload: unknown) => {
        const sha = (payload as { sha256: string }).sha256;
        const bytes = opts.blobs[sha];
        if (bytes === undefined) throw new Error('blob not found');
        const tmp = path.join(workspace, `.blobget-${sha.slice(0, 8)}`);
        await fs.writeFile(tmp, bytes);
        tmpFiles.push(tmp);
        return { path: tmp, bytes: bytes.length };
      },
    };
    return { client, tmpFiles };
  }

  it('materializes each upload at the advertised <workspaceRoot>/.ax/uploads/<rest>', async () => {
    const { client } = mockClient({
      files: [
        { path: '.ax/uploads/c1/t1/a.png', sha256: 'a'.repeat(64), mediaType: 'image/png', displayName: 'a.png', sizeBytes: 3 },
        { path: '.ax/uploads/c1/t2/b.txt', sha256: 'b'.repeat(64), mediaType: 'text/plain', displayName: 'b.txt', sizeBytes: 5 },
      ],
      blobs: { ['a'.repeat(64)]: Buffer.from('PNG'), ['b'.repeat(64)]: Buffer.from('hello') },
    });
    const n = await materializeUploads({ client, conversationId: 'c1', workspaceRoot: workspace, warn: () => {} });
    expect(n).toBe(2);
    // The file is readable at exactly the absolute path the system prompt
    // advertises: `<workspaceRoot>/.ax/uploads/<conv>/<turn>/<file>`.
    expect((await fs.readFile(path.join(uploadsBase, 'c1/t1/a.png'))).toString()).toBe('PNG');
    expect((await fs.readFile(path.join(uploadsBase, 'c1/t2/b.txt'))).toString()).toBe('hello');
  });

  it('skips a missing blob (best-effort) and still materializes the rest', async () => {
    const warnings: string[] = [];
    const { client } = mockClient({
      files: [
        { path: '.ax/uploads/c1/t1/ok.txt', sha256: 'a'.repeat(64), mediaType: 'text/plain', displayName: 'ok.txt', sizeBytes: 2 },
        { path: '.ax/uploads/c1/t1/gone.txt', sha256: 'c'.repeat(64), mediaType: 'text/plain', displayName: 'gone.txt', sizeBytes: 2 },
      ],
      blobs: { ['a'.repeat(64)]: Buffer.from('ok') }, // 'c...' missing
    });
    const n = await materializeUploads({ client, conversationId: 'c1', workspaceRoot: workspace, warn: (m) => warnings.push(m) });
    expect(n).toBe(1);
    expect((await fs.readFile(path.join(uploadsBase, 'c1/t1/ok.txt'))).toString()).toBe('ok');
    expect(warnings.some((w) => w.includes('gone.txt'))).toBe(true);
  });

  it('skips an upload with an unsafe path (never writes outside the base)', async () => {
    const warnings: string[] = [];
    const { client } = mockClient({
      files: [
        { path: '.ax/uploads/../../escape.txt', sha256: 'a'.repeat(64), mediaType: 'text/plain', displayName: 'x', sizeBytes: 1 },
      ],
      blobs: { ['a'.repeat(64)]: Buffer.from('x') },
    });
    const n = await materializeUploads({ client, conversationId: 'c1', workspaceRoot: workspace, warn: (m) => warnings.push(m) });
    expect(n).toBe(0);
    expect(warnings.some((w) => w.includes('unsafe path'))).toBe(true);
  });

  it('returns 0 cleanly when the conversation has no uploads', async () => {
    const { client } = mockClient({ files: [], blobs: {} });
    const n = await materializeUploads({ client, conversationId: 'c1', workspaceRoot: workspace, warn: () => {} });
    expect(n).toBe(0);
  });

  it('returns 0 (non-fatal) when attachments.list itself fails', async () => {
    const client = {
      call: async () => {
        throw new Error('host down');
      },
      callBinary: async () => ({ path: '/tmp/x', bytes: 0 }),
    };
    const warnings: string[] = [];
    const n = await materializeUploads({ client, conversationId: 'c1', workspaceRoot: workspace, warn: (m) => warnings.push(m) });
    expect(n).toBe(0);
    expect(warnings.some((w) => w.includes('attachments.list failed'))).toBe(true);
  });

  // TASK-78: stale cross-conversation residue. A warm runner (or a /agent
  // tier that persisted from a prior conversation) can carry another
  // conversation's uploads under `.ax/uploads/`. Re-materializing must WIPE the
  // uploads dir first so only THIS conversation's set remains — no leak across
  // conversations.
  it('clears stale cross-conversation residue under .ax/uploads before writing', async () => {
    // Seed residue from a prior conversation `c-old`.
    const stale = path.join(uploadsBase, 'c-old', 't9', 'secret.txt');
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, 'OTHER CONVERSATION SECRET');

    const { client } = mockClient({
      files: [
        { path: '.ax/uploads/c1/t1/mine.txt', sha256: 'a'.repeat(64), mediaType: 'text/plain', displayName: 'mine.txt', sizeBytes: 4 },
      ],
      blobs: { ['a'.repeat(64)]: Buffer.from('mine') },
    });
    const n = await materializeUploads({ client, conversationId: 'c1', workspaceRoot: workspace, warn: () => {} });
    expect(n).toBe(1);
    // This conversation's upload is present...
    expect((await fs.readFile(path.join(uploadsBase, 'c1/t1/mine.txt'))).toString()).toBe('mine');
    // ...and the prior conversation's residue is GONE.
    await expect(fs.readFile(stale)).rejects.toThrow();
  });

  // TASK-78 (warm rebind): a fresh upload arriving on a later turn must be
  // materialized too. Because materializeUploads re-lists the full upload set
  // each call, a second call after a new upload lands writes the new file while
  // keeping the earlier one (the earlier one is still in the list).
  it('is idempotent + additive across re-materialize (warm-rebind turns)', async () => {
    // Turn 1: one upload.
    const c1 = mockClient({
      files: [
        { path: '.ax/uploads/c1/t1/first.txt', sha256: 'a'.repeat(64), mediaType: 'text/plain', displayName: 'first.txt', sizeBytes: 5 },
      ],
      blobs: { ['a'.repeat(64)]: Buffer.from('first') },
    });
    expect(await materializeUploads({ client: c1.client, conversationId: 'c1', workspaceRoot: workspace, warn: () => {} })).toBe(1);

    // Turn 2 (warm rebind): a second upload arrives; the list now has both.
    const c2 = mockClient({
      files: [
        { path: '.ax/uploads/c1/t1/first.txt', sha256: 'a'.repeat(64), mediaType: 'text/plain', displayName: 'first.txt', sizeBytes: 5 },
        { path: '.ax/uploads/c1/t2/second.txt', sha256: 'b'.repeat(64), mediaType: 'text/plain', displayName: 'second.txt', sizeBytes: 6 },
      ],
      blobs: { ['a'.repeat(64)]: Buffer.from('first'), ['b'.repeat(64)]: Buffer.from('second') },
    });
    expect(await materializeUploads({ client: c2.client, conversationId: 'c1', workspaceRoot: workspace, warn: () => {} })).toBe(2);
    expect((await fs.readFile(path.join(uploadsBase, 'c1/t1/first.txt'))).toString()).toBe('first');
    expect((await fs.readFile(path.join(uploadsBase, 'c1/t2/second.txt'))).toString()).toBe('second');
  });
});
