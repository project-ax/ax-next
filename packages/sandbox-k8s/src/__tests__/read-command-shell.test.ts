import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReadCommand, parseReadOutput } from '../user-files-ops.js';

// ---------------------------------------------------------------------------
// The one-shot reader pod's SCRIPT, run through a real POSIX shell.
//
// Everything else about this script is invisible to a type checker and to
// every other test in this package: `plugin.test.ts` proves the pod is built
// and its log is parsed, `user-files-ops.test.ts` greps the generated text for
// the confinement clauses. Neither runs a single line of it. Quoting bugs,
// glob bugs and delimiter bugs live exactly in that gap, and the cost of one
// is either a broken file browser or a listing an agent can forge.
//
// So this runs the REAL generated script through `/bin/sh` and feeds its stdout
// to the REAL `parseReadOutput`. One caveat, stated plainly: the script hard-
// codes `/export` as the mount point, which we cannot create on a dev machine,
// so the mount path is textually rewritten to a temp dir. That is the ONLY
// edit — every quote, glob, `realpath`, `case` and `printf` is the shipped one.
// A test that mounted `/export` for real would need Docker, and Docker in this
// suite is the single most reliable source of red builds we have.
// ---------------------------------------------------------------------------

const EXPORT_MOUNT = '/export';
const SUBPATH = 'agent-abc';

let root: string;
/** The agent's own subtree — `$EXPORT/$SUBPATH` in the shipped script. */
let agentDir: string;

beforeEach(async () => {
  // realpath the temp dir: macOS hands out /var/... which is a symlink to
  // /private/var, and the script's realpath confinement would compare a
  // resolved target against an unresolved base and fail for the wrong reason.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-readcmd-')));
  agentDir = path.join(root, SUBPATH);
  await fs.mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** Run the shipped script for `relPath` and parse its output the way the host does. */
function read(relPath: string) {
  const script = buildReadCommand().split(EXPORT_MOUNT).join(root);
  const raw = execFileSync('/bin/sh', ['-c', script], {
    env: { SUBPATH, RELPATH: relPath, PATH: process.env.PATH ?? '' },
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseReadOutput(raw);
}

/** The listing as a name→kind map, for assertions that do not care about order. */
function listing(relPath: string): Map<string, string> {
  const out = read(relPath);
  if (out.kind !== 'dir') throw new Error(`expected dir, got ${out.kind}`);
  return new Map(out.entries.map((e) => [e.name, e.kind]));
}

describe('the reader script, through a real shell', () => {
  it('lists the agent subtree root', async () => {
    await fs.writeFile(path.join(agentDir, 'hello.txt'), 'hi');
    await fs.mkdir(path.join(agentDir, 'reports'));
    const byName = listing('.');
    expect(byName.get('hello.txt')).toBe('file');
    expect(byName.get('reports')).toBe('dir');
  });

  it('lists dotfiles — this is the user’s own file area, not ours to hide', async () => {
    await fs.writeFile(path.join(agentDir, '.env.example'), 'K=v');
    expect(listing('.').get('.env.example')).toBe('file');
  });

  it('never lists `.` or `..` as entries', async () => {
    await fs.writeFile(path.join(agentDir, 'a.txt'), 'a');
    const names = [...listing('.').keys()];
    expect(names).not.toContain('.');
    expect(names).not.toContain('..');
  });

  it('reads a nested file byte-for-byte', async () => {
    await fs.mkdir(path.join(agentDir, 'reports'));
    await fs.writeFile(path.join(agentDir, 'reports', 'summary.md'), '# Plan\nShip.\n');
    const out = read('reports/summary.md');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('# Plan\nShip.\n');
  });

  it('reads a BINARY file intact — base64 is why the log channel is safe', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x09, 0x80, 0x00]);
    await fs.writeFile(path.join(agentDir, 'blob.bin'), bytes);
    const out = read('blob.bin');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).equals(bytes)).toBe(true);
  });

  it('serves a PREFIX of an over-cap file, not an absence', async () => {
    // The cap is 1 MiB; write past it and check we get exactly the cap back.
    // The old script emitted `BIG` here, which the host turned into `absent` —
    // "no such file" over a file the agent definitely wrote.
    await fs.writeFile(path.join(agentDir, 'big.bin'), Buffer.alloc(1024 * 1024 + 512, 0x41));
    const out = read('big.bin');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.contents.byteLength).toBe(1024 * 1024);
  });

  it('an empty directory lists as an empty dir, not as absent', () => {
    const out = read('.');
    expect(out).toEqual({ kind: 'dir', entries: [] });
  });

  it('REGRESSION: a zero-byte file reads as an empty file, not as absent', async () => {
    // base64 of no bytes is the empty string, so this line arrives as a bare
    // `FILE`. It used to fall through to `absent`, i.e. "not found" about a
    // file the agent had definitely created.
    await fs.writeFile(path.join(agentDir, 'empty.txt'), '');
    const out = read('empty.txt');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.contents.byteLength).toBe(0);
  });

  it('REGRESSION: a directory holding ONLY a skipped symlink lists as empty', async () => {
    // The listing drops symlinks, so this directory produces no rows at all —
    // the same empty-payload path as an empty directory, reached a different
    // way. It must still be a directory.
    await fs.symlink('/', path.join(agentDir, 'rootlink'));
    expect(read('.')).toEqual({ kind: 'dir', entries: [] });
  });

  it('a missing path is ABSENT', () => {
    expect(read('nope/missing.txt')).toEqual({ kind: 'absent' });
  });

  // --- the confinement, actually executed --------------------------------

  it('SECURITY: an INTERMEDIATE symlink to a sibling subtree yields ABSENT', async () => {
    const other = path.join(root, 'agent-xyz');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'secret.txt'), 'SIBLING-SECRET');
    await fs.symlink(other, path.join(agentDir, 'escape'));
    expect(read('escape/secret.txt')).toEqual({ kind: 'absent' });
    expect(read('escape')).toEqual({ kind: 'absent' });
    // And it is not even named.
    expect([...listing('.').keys()]).not.toContain('escape');
  });

  it('SECURITY: a symlink to the host filesystem root yields ABSENT', async () => {
    await fs.symlink('/', path.join(agentDir, 'rootlink'));
    expect(read('rootlink/etc/hostname')).toEqual({ kind: 'absent' });
  });

  it('SECURITY: a sibling whose name PREFIXES the subtree is not reachable', async () => {
    // `<root>/agent-abc-evil` starts with `<root>/agent-abc` as a string. The
    // script's `case` requires `$realbase` or `$realbase/*`, so it does not
    // match — this is the shell equivalent of the separator check the
    // TypeScript reader makes.
    const evil = path.join(root, `${SUBPATH}-evil`);
    await fs.mkdir(evil, { recursive: true });
    await fs.writeFile(path.join(evil, 'secret'), 'EVIL');
    await fs.symlink(evil, path.join(agentDir, 'sneak'));
    expect(read('sneak/secret')).toEqual({ kind: 'absent' });
  });

  // --- the listing format, which the agent controls the inputs to ---------

  it('SECURITY: a filename containing a literal `\\t` cannot forge an entry', async () => {
    /*
      The bug this pins. The listing used to accumulate `name<TAB>kind` rows in
      one variable and emit them with `printf %b`, which interprets backslash
      escapes IN THE DATA — so a file literally named `x\\tdir\\ny` became two
      rows, and the browser showed a directory that does not exist. Names are
      base64'd individually now, so there is no delimiter left in the payload.
    */
    const hostile = 'x\\tdir\\nphantom';
    await fs.writeFile(path.join(agentDir, hostile), 'payload');
    const byName = listing('.');
    // The real name, exactly as written, and nothing else.
    expect(byName.get(hostile)).toBe('file');
    expect(byName.has('phantom')).toBe(false);
    expect(byName.size).toBe(1);
  });

  it('SECURITY: a filename containing a REAL newline cannot forge an entry', async () => {
    // POSIX allows it, so an agent can do it. A row-per-line format passes it
    // straight through; base64 does not.
    const hostile = 'a\ndir\nphantom';
    await fs.writeFile(path.join(agentDir, hostile), 'payload');
    const byName = listing('.');
    expect(byName.get(hostile)).toBe('file');
    expect(byName.has('phantom')).toBe(false);
    expect(byName.size).toBe(1);
  });

  it('SECURITY: a filename containing a REAL tab cannot forge a kind', async () => {
    const hostile = 'b\tdir';
    await fs.writeFile(path.join(agentDir, hostile), 'payload');
    const byName = listing('.');
    expect(byName.get(hostile)).toBe('file');
    expect(byName.size).toBe(1);
  });

  it('SECURITY: shell metacharacters in a filename are data, never code', async () => {
    // If any of these reached a shell word unquoted, this test would not fail
    // politely — it would run something. That is why it is here.
    const names = ['$(touch pwned)', '`touch pwned2`', 'a;b', 'a b', "a'b", 'a"b', 'a*b'];
    for (const n of names) await fs.writeFile(path.join(agentDir, n), 'x');
    const byName = listing('.');
    for (const n of names) expect(byName.get(n)).toBe('file');
    // Nothing executed.
    await expect(fs.stat(path.join(agentDir, 'pwned'))).rejects.toThrow();
    await expect(fs.stat(path.join(process.cwd(), 'pwned'))).rejects.toThrow();
  });

  it('reads a file whose name has shell metacharacters in it', async () => {
    await fs.writeFile(path.join(agentDir, 'a b;c.txt'), 'quoted fine');
    const out = read('a b;c.txt');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('quoted fine');
  });

  it('skips a socket/fifo rather than listing it as a file', async () => {
    const fifo = path.join(agentDir, 'pipe');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo here; nothing to assert differently per-OS
    }
    await fs.writeFile(path.join(agentDir, 'real.txt'), 'r');
    const byName = listing('.');
    expect(byName.has('pipe')).toBe(false);
    expect(byName.get('real.txt')).toBe('file');
  });
});
