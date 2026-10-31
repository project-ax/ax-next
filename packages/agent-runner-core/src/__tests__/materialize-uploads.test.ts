import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AttachmentsListResponseSchema } from '@ax/ipc-protocol';
import {
  collisionName,
  materializeUploads,
  sanitizeUploadName,
  scratchUploadsDir,
  type MaterializedUpload,
} from '../materialize-uploads.js';

// ---------------------------------------------------------------------------
// Uploads are copied flat into `<scratch>/uploads/` under the names people gave
// their files. Those names are hostile input — whoever named the file chose
// them — and the directory sits in agent-writable scratch. So these tests
// plant what an agent could plant (files, symlinks, a swapped directory) and
// check that nothing is overwritten, followed, or written outside uploads/.
//
// The fake client answers `attachments.list` through the REAL response schema
// (mistakes.md, 2026-08-19: a hand-typed fake with the wrong shape once
// disabled this whole path silently).
// ---------------------------------------------------------------------------

interface Listed {
  attachmentId: string;
  filename: string;
  bytes: Buffer;
  mediaType?: string;
  /** The host lists it, but `blob.get` cannot find its bytes. */
  missing?: boolean;
}

let t: string;
let uploadsDir: string;
let blobTmp: string;

beforeEach(async () => {
  t = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-mat-up-'));
  await fs.mkdir(path.join(t, 'scratch'));
  uploadsDir = path.join(t, 'scratch', 'uploads');
  blobTmp = path.join(t, 'blob-tmp');
  await fs.mkdir(blobTmp);
});

afterEach(async () => {
  await fs.rm(t, { recursive: true, force: true });
});

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function fakeClient(listed: Listed[]) {
  const blobs = new Map<string, Buffer>();
  for (const f of listed) if (f.missing !== true) blobs.set(sha(f.bytes), f.bytes);
  let n = 0;
  return {
    call: vi.fn(async (action: string, _payload: unknown) => {
      if (action !== 'attachments.list') throw new Error(`unexpected call: ${action}`);
      return AttachmentsListResponseSchema.parse({
        files: listed.map((f) => ({
          attachmentId: f.attachmentId,
          filename: f.filename,
          sha256: sha(f.bytes),
          mediaType: f.mediaType ?? 'application/octet-stream',
          sizeBytes: f.bytes.length,
        })),
      });
    }),
    // Like the real client: streams the blob to a temp file the caller owns.
    callBinary: vi.fn(async (action: string, payload: unknown) => {
      if (action !== 'blob.get') throw new Error(`unexpected binary call: ${action}`);
      const bytes = blobs.get((payload as { sha256: string }).sha256);
      if (bytes === undefined) throw new Error('blob not found');
      const tmp = path.join(blobTmp, `blob-${n++}.bin`);
      await fs.writeFile(tmp, bytes);
      return { path: tmp, bytes: bytes.length };
    }),
  };
}

async function run(listed: Listed[], known = new Map<string, MaterializedUpload>()) {
  const client = fakeClient(listed);
  const warnings: string[] = [];
  await materializeUploads({
    client,
    conversationId: 'c1',
    uploadsDir,
    known,
    warn: (m) => warnings.push(m),
  });
  return { client, known, warnings };
}

const names = (known: Map<string, MaterializedUpload>): Record<string, string> =>
  Object.fromEntries([...known].map(([id, u]) => [id, path.basename(u.path)]));

describe('scratchUploadsDir', () => {
  // The one definition of where the copies land: the runner writes there, and
  // the files note names it to the model.
  it('is `uploads/` directly under the scratch root', () => {
    expect(scratchUploadsDir('/tmp')).toBe('/tmp/uploads');
    expect(scratchUploadsDir('/var/scratch-9/')).toBe('/var/scratch-9/uploads');
  });
});

describe('sanitizeUploadName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../files/x', 'x'],
    ['a/b', 'b'],
    ['a\\b', 'b'],
    ['..', 'file'],
    ['.', 'file'],
    ['', 'file'],
    ['/', 'file'],
    ['a\nb.txt', 'ab.txt'],
    ['\u0000\u001f\u007f', 'file'],
    ['  report.pdf  ', 'report.pdf'],
    // Line and paragraph separators and C1 controls would break the one-line
    // mention the model reads, just like a newline.
    ['a b c\u0085d.txt', 'abcd.txt'],
  ])('%j becomes %j', (input, want) => {
    expect(sanitizeUploadName(input)).toBe(want);
  });

  it('caps a 300-byte name and keeps its extension', () => {
    const out = sanitizeUploadName('x'.repeat(296) + '.pdf');
    expect(out).toBe('x'.repeat(196) + '.pdf');
  });

  it('cuts a long multi-byte name on a code-point boundary', () => {
    // 'é' is two bytes: 98 of them plus '.pdf' is exactly 200 bytes.
    expect(sanitizeUploadName('é'.repeat(200) + '.pdf')).toBe('é'.repeat(98) + '.pdf');
    // An astral character is four bytes (a surrogate pair in JS); never split one.
    expect(sanitizeUploadName('😀'.repeat(60) + '.txt')).toBe('😀'.repeat(49) + '.txt');
  });

  it('does not keep an extension longer than 16 bytes', () => {
    expect(sanitizeUploadName('a'.repeat(250) + '.' + 'b'.repeat(20))).toBe('a'.repeat(200));
  });

  it('replaces a lone surrogate, so the name on disk is the name in memory', () => {
    expect(sanitizeUploadName('a\uD800b.txt')).toBe('a�b.txt');
  });

  it('leaves room for the largest collision suffix under the 255-byte name limit', () => {
    const out = sanitizeUploadName('x'.repeat(400) + '.pdf');
    expect(Buffer.byteLength(collisionName(out, 999))).toBeLessThanOrEqual(255);
  });
});

describe('collisionName', () => {
  it.each([
    ['report.pdf', 2, 'report (2).pdf'],
    ['report.pdf', 3, 'report (3).pdf'],
    ['notes', 2, 'notes (2)'],
    ['.bashrc', 2, '.bashrc (2)'],
    ['archive.tar.gz', 2, 'archive.tar (2).gz'],
  ])('%j number %i is %j', (name, n, want) => {
    expect(collisionName(name, n)).toBe(want);
  });
});

describe('materializeUploads', () => {
  it("writes the conversation's uploads flat into uploads/ in list order", async () => {
    const png = Buffer.from('PNG');
    const txt = Buffer.from('hello');
    const { client, known, warnings } = await run([
      { attachmentId: 'att-a', filename: 'a.png', bytes: png, mediaType: 'image/png' },
      { attachmentId: 'att-b', filename: 'b.txt', bytes: txt, mediaType: 'text/plain' },
    ]);

    expect(warnings).toEqual([]);
    expect(client.call).toHaveBeenCalledWith('attachments.list', { conversationId: 'c1' });
    expect((await fs.readdir(uploadsDir)).sort()).toEqual(['a.png', 'b.txt']);
    expect(await fs.readFile(path.join(uploadsDir, 'a.png'))).toEqual(png);
    expect(await fs.readFile(path.join(uploadsDir, 'b.txt'))).toEqual(txt);
    expect(known.get('att-a')).toEqual({
      attachmentId: 'att-a',
      filename: 'a.png',
      path: path.join(uploadsDir, 'a.png'),
      sha256: sha(png),
      mediaType: 'image/png',
      sizeBytes: 3,
    });
    expect(known.get('att-b')?.path).toBe(path.join(uploadsDir, 'b.txt'));
    // Private to the sandbox user, and every blob.get temp file is gone.
    expect((await fs.stat(uploadsDir)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(blobTmp)).toEqual([]);
  });

  it('names duplicates report.pdf, report (2).pdf, report (3).pdf', async () => {
    // The ids sort differently from the list: the order of the list decides.
    const { known } = await run([
      { attachmentId: 'z1', filename: 'report.pdf', bytes: Buffer.from('one') },
      { attachmentId: 'a2', filename: 'report.pdf', bytes: Buffer.from('two') },
      { attachmentId: 'm3', filename: 'report.pdf', bytes: Buffer.from('three') },
      { attachmentId: 'n1', filename: 'notes', bytes: Buffer.from('n-one') },
      { attachmentId: 'n2', filename: 'notes', bytes: Buffer.from('n-two') },
      { attachmentId: 'b1', filename: '.bashrc', bytes: Buffer.from('b-one') },
      { attachmentId: 'b2', filename: '.bashrc', bytes: Buffer.from('b-two') },
    ]);
    expect(names(known)).toEqual({
      z1: 'report.pdf',
      a2: 'report (2).pdf',
      m3: 'report (3).pdf',
      n1: 'notes',
      n2: 'notes (2)',
      b1: '.bashrc',
      b2: '.bashrc (2)',
    });
    expect(await fs.readFile(path.join(uploadsDir, 'report (2).pdf'), 'utf8')).toBe('two');
    expect(await fs.readFile(path.join(uploadsDir, 'notes (2)'), 'utf8')).toBe('n-two');
    expect(await fs.readdir(blobTmp)).toEqual([]);
  });

  it.each([
    ['../../files/x', 'x'],
    ['a/b', 'b'],
    ['a\\b', 'b'],
    ['..', 'file'],
    ['.', 'file'],
    ['/', 'file'],
    ['a\nb.txt', 'ab.txt'],
    ['\u0000\u001f\u007f', 'file'],
  ])('keeps the hostile name %j inside uploads/ (as %j)', async (filename, want) => {
    const { known } = await run([{ attachmentId: 'att', filename, bytes: Buffer.from('x') }]);
    const copy = known.get('att')!.path;
    expect(path.basename(copy)).toBe(want);
    expect(path.dirname(await fs.realpath(copy))).toBe(await fs.realpath(uploadsDir));
    // Nothing landed anywhere else.
    expect((await fs.readdir(t)).sort()).toEqual(['blob-tmp', 'scratch']);
    expect(await fs.readdir(path.join(t, 'scratch'))).toEqual(['uploads']);
  });

  it('keeps a 300-byte name under the file-name limit and keeps its extension', async () => {
    const { known } = await run([
      { attachmentId: 'att', filename: 'x'.repeat(296) + '.pdf', bytes: Buffer.from('x') },
    ]);
    const name = path.basename(known.get('att')!.path);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(path.dirname(await fs.realpath(known.get('att')!.path))).toBe(
      await fs.realpath(uploadsDir),
    );
  });

  it('never overwrites or follows an existing name', async () => {
    const outside = path.join(t, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'victim'), 'VICTIM');
    await fs.mkdir(uploadsDir);
    // What an agent could plant ahead of a later turn's upload: a link to a
    // file it wants overwritten, a dangling link to a file it wants created,
    // and a plain file of its own.
    await fs.symlink(path.join(outside, 'victim'), path.join(uploadsDir, 'report.pdf'));
    await fs.symlink(path.join(outside, 'planted'), path.join(uploadsDir, 'data.csv'));
    await fs.writeFile(path.join(uploadsDir, 'notes'), 'AGENT');

    const { known } = await run([
      { attachmentId: 'r', filename: 'report.pdf', bytes: Buffer.from('REPORT') },
      { attachmentId: 'd', filename: 'data.csv', bytes: Buffer.from('DATA') },
      { attachmentId: 'n', filename: 'notes', bytes: Buffer.from('NOTES') },
    ]);

    expect(await fs.readFile(path.join(outside, 'victim'), 'utf8')).toBe('VICTIM');
    await expect(fs.lstat(path.join(outside, 'planted'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(uploadsDir, 'notes'), 'utf8')).toBe('AGENT');
    expect(names(known)).toEqual({ r: 'report (2).pdf', d: 'data (2).csv', n: 'notes (2)' });
    expect(await fs.readFile(known.get('r')!.path, 'utf8')).toBe('REPORT');
    expect(await fs.readFile(known.get('d')!.path, 'utf8')).toBe('DATA');
    expect(await fs.readFile(known.get('n')!.path, 'utf8')).toBe('NOTES');
    // The runner deletes nothing: the planted entries are still there.
    expect((await fs.lstat(path.join(uploadsDir, 'report.pdf'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(uploadsDir, 'data.csv'))).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(blobTmp)).toEqual([]);
  });

  it('refuses an uploads path that is a symlink', async () => {
    // The agent swapped the directory for a link to somewhere it wants the
    // person's files written.
    const elsewhere = path.join(t, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, uploadsDir);
    const { client, known, warnings } = await run([
      { attachmentId: 'a', filename: 'a.txt', bytes: Buffer.from('A') },
    ]);
    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect(known.size).toBe(0);
    expect(warnings).toEqual([expect.stringContaining(uploadsDir)]);
    expect(client.callBinary).not.toHaveBeenCalled();
  });

  it('refuses a symlinked uploads path even when it is named with a trailing slash', async () => {
    // `lstat("dir/")` resolves a symlink before it looks: the trailing slash
    // must not turn the link check into a check of the link's target.
    const elsewhere = path.join(t, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, uploadsDir);
    const client = fakeClient([{ attachmentId: 'a', filename: 'a.txt', bytes: Buffer.from('A') }]);
    const known = new Map<string, MaterializedUpload>();
    const warnings: string[] = [];
    await materializeUploads({
      client,
      conversationId: 'c1',
      uploadsDir: `${uploadsDir}/`,
      known,
      warn: (m) => warnings.push(m),
    });
    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect(known.size).toBe(0);
    expect(warnings).toHaveLength(1);
    // Refused as a directory, before any bytes were fetched.
    expect(client.callBinary).not.toHaveBeenCalled();
  });

  it('refuses an uploads path that is a file', async () => {
    await fs.writeFile(uploadsDir, 'not a directory');
    const { client, known, warnings } = await run([
      { attachmentId: 'a', filename: 'a.txt', bytes: Buffer.from('A') },
    ]);
    expect(await fs.readFile(uploadsDir, 'utf8')).toBe('not a directory');
    expect(known.size).toBe(0);
    expect(warnings).toEqual([expect.stringContaining(uploadsDir)]);
    expect(client.callBinary).not.toHaveBeenCalled();
  });

  it('a later call writes only new attachments and keeps earlier names', async () => {
    const first = Buffer.from('first report');
    const second = Buffer.from('second report');
    const known = new Map<string, MaterializedUpload>();
    await run([{ attachmentId: 'r1', filename: 'report.pdf', bytes: first }], known);
    // The agent edits its copy between turns. A later materialize must leave it.
    await fs.writeFile(path.join(uploadsDir, 'report.pdf'), 'AGENT EDIT');

    const later = await run(
      [
        { attachmentId: 'r1', filename: 'report.pdf', bytes: first },
        { attachmentId: 'r2', filename: 'report.pdf', bytes: second },
      ],
      known,
    );

    expect(names(known)).toEqual({ r1: 'report.pdf', r2: 'report (2).pdf' });
    expect(await fs.readFile(path.join(uploadsDir, 'report.pdf'), 'utf8')).toBe('AGENT EDIT');
    expect(await fs.readFile(path.join(uploadsDir, 'report (2).pdf'))).toEqual(second);
    // Only the new attachment's bytes were fetched.
    expect(later.client.callBinary.mock.calls).toEqual([['blob.get', { sha256: sha(second) }]]);
  });

  it('a fresh process given the same list derives the same names', async () => {
    const list: Listed[] = [
      { attachmentId: 'a', filename: 'report.pdf', bytes: Buffer.from('1') },
      { attachmentId: 'b', filename: 'notes', bytes: Buffer.from('2') },
      { attachmentId: 'c', filename: 'report.pdf', bytes: Buffer.from('3') },
      { attachmentId: 'd', filename: '../report.pdf', bytes: Buffer.from('4') },
    ];
    // The first pod saw the uploads arrive one turn at a time.
    const live = new Map<string, MaterializedUpload>();
    for (let i = 1; i <= list.length; i += 1) await run(list.slice(0, i), live);

    // A fresh pod: new scratch, empty map, the whole list in one go.
    await fs.mkdir(path.join(t, 'scratch2'));
    uploadsDir = path.join(t, 'scratch2', 'uploads');
    const fresh = new Map<string, MaterializedUpload>();
    await run(list, fresh);

    expect(names(live)).toEqual({
      a: 'report.pdf',
      b: 'notes',
      c: 'report (2).pdf',
      d: 'report (3).pdf',
    });
    expect(names(fresh)).toEqual(names(live));
  });

  it('a list failure writes and deletes nothing', async () => {
    const before: MaterializedUpload = {
      attachmentId: 'old',
      filename: 'kept.txt',
      path: path.join(uploadsDir, 'kept.txt'),
      sha256: sha(Buffer.from('kept')),
      mediaType: 'text/plain',
      sizeBytes: 4,
    };
    for (const answer of [
      async () => {
        throw new Error('host down');
      },
      // A response that fails the schema is a failure too.
      async () => ({ attachments: [] }),
    ]) {
      await fs.rm(uploadsDir, { recursive: true, force: true });
      const known = new Map([['old', before]]);
      const client = { call: vi.fn(answer), callBinary: vi.fn() };
      const warnings: string[] = [];
      await materializeUploads({
        client,
        conversationId: 'c1',
        uploadsDir,
        known,
        warn: (m) => warnings.push(m),
      });
      // Nothing was even created: the uploads dir does not exist yet.
      await expect(fs.lstat(uploadsDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect([...known]).toEqual([['old', before]]);
      expect(client.callBinary).not.toHaveBeenCalled();
      expect(warnings).toEqual([expect.stringContaining('attachments.list')]);

      // And with earlier copies on disk, they stay exactly as they were.
      await fs.mkdir(uploadsDir);
      await fs.writeFile(before.path, 'kept');
      await materializeUploads({ client, conversationId: 'c1', uploadsDir, known, warn: () => {} });
      expect(await fs.readdir(uploadsDir)).toEqual(['kept.txt']);
      expect(await fs.readFile(before.path, 'utf8')).toBe('kept');
    }
  });

  it('skips an upload whose bytes cannot be fetched, copies the rest, and retries it later', async () => {
    const known = new Map<string, MaterializedUpload>();
    const list: Listed[] = [
      { attachmentId: 'gone', filename: 'gone.txt', bytes: Buffer.from('G'), missing: true },
      { attachmentId: 'ok', filename: 'ok.txt', bytes: Buffer.from('K') },
    ];
    const first = await run(list, known);
    expect(names(known)).toEqual({ ok: 'ok.txt' });
    expect(first.warnings).toEqual([expect.stringContaining('gone')]);

    await run(list.map((f) => ({ ...f, missing: false })), known);
    expect(names(known)).toEqual({ ok: 'ok.txt', gone: 'gone.txt' });
    expect(await fs.readdir(blobTmp)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'a copy that fails leaves no temp file and does not stop the others',
    async () => {
      await fs.mkdir(uploadsDir, { mode: 0o500 });
      try {
        const { known, warnings } = await run([
          { attachmentId: 'a', filename: 'a.txt', bytes: Buffer.from('A') },
          { attachmentId: 'b', filename: 'b.txt', bytes: Buffer.from('B') },
        ]);
        expect(known.size).toBe(0);
        expect(warnings).toHaveLength(2);
        expect(await fs.readdir(blobTmp)).toEqual([]);
      } finally {
        await fs.chmod(uploadsDir, 0o700);
      }
    },
  );
});
