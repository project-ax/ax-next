import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  materializeUploads,
  resolveMaterializedPath,
} from '../materialize-uploads.js';

describe('resolveMaterializedPath', () => {
  const base = '/ephemeral/uploads';

  it('maps a transcript upload key under the uploads base (drops .ax/)', () => {
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
  let ephemeral: string;

  beforeEach(async () => {
    ephemeral = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-mat-up-'));
  });

  afterEach(async () => {
    await fs.rm(ephemeral, { recursive: true, force: true }).catch(() => {});
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
        const tmp = path.join(ephemeral, `.blobget-${sha.slice(0, 8)}`);
        await fs.writeFile(tmp, bytes);
        tmpFiles.push(tmp);
        return { path: tmp, bytes: bytes.length };
      },
    };
    return { client, tmpFiles };
  }

  it('materializes each upload into <ephemeralRoot>/uploads/<rest>', async () => {
    const { client } = mockClient({
      files: [
        { path: '.ax/uploads/c1/t1/a.png', sha256: 'a'.repeat(64), mediaType: 'image/png', displayName: 'a.png', sizeBytes: 3 },
        { path: '.ax/uploads/c1/t2/b.txt', sha256: 'b'.repeat(64), mediaType: 'text/plain', displayName: 'b.txt', sizeBytes: 5 },
      ],
      blobs: { ['a'.repeat(64)]: Buffer.from('PNG'), ['b'.repeat(64)]: Buffer.from('hello') },
    });
    const n = await materializeUploads({ client, conversationId: 'c1', ephemeralRoot: ephemeral, warn: () => {} });
    expect(n).toBe(2);
    expect((await fs.readFile(path.join(ephemeral, 'uploads/c1/t1/a.png'))).toString()).toBe('PNG');
    expect((await fs.readFile(path.join(ephemeral, 'uploads/c1/t2/b.txt'))).toString()).toBe('hello');
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
    const n = await materializeUploads({ client, conversationId: 'c1', ephemeralRoot: ephemeral, warn: (m) => warnings.push(m) });
    expect(n).toBe(1);
    expect((await fs.readFile(path.join(ephemeral, 'uploads/c1/t1/ok.txt'))).toString()).toBe('ok');
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
    const n = await materializeUploads({ client, conversationId: 'c1', ephemeralRoot: ephemeral, warn: (m) => warnings.push(m) });
    expect(n).toBe(0);
    expect(warnings.some((w) => w.includes('unsafe path'))).toBe(true);
  });

  it('returns 0 cleanly when the conversation has no uploads', async () => {
    const { client } = mockClient({ files: [], blobs: {} });
    const n = await materializeUploads({ client, conversationId: 'c1', ephemeralRoot: ephemeral, warn: () => {} });
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
    const n = await materializeUploads({ client, conversationId: 'c1', ephemeralRoot: ephemeral, warn: (m) => warnings.push(m) });
    expect(n).toBe(0);
    expect(warnings.some((w) => w.includes('attachments.list failed'))).toBe(true);
  });
});
