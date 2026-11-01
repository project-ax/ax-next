import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type Logger } from '@ax/core';
import type {
  ReadUserFileRangeInput,
  ReadUserFilesInput,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import {
  cleanupUserFiles,
  measureUserFiles,
  ownerFromAgentId,
  readUserFileRange,
  readUserFiles,
} from '../user-files-host-ops.js';

// ---------------------------------------------------------------------------
// TASK-167 (filestore-user-files §11) — the subprocess provider's host-side
// realizations of host-read + cleanup. The subprocess sandbox shares the host
// FS, so these run directly against a real temp dir. A localDir-style resolver
// is registered on the bus exactly like @ax/workspace-localdir; the per-agent
// hostPath is `<root>/<agentId>`. These prove: host-read is read-only +
// confined; cleanup removes ONLY the target agent's subtree (cross-tenant
// isolation); both degrade gracefully when no resolver is loaded.
// ---------------------------------------------------------------------------

const PLUGIN = '@ax/sandbox-subprocess';
const MiB = 1024 * 1024;

// The host-read is the per-component no-follow walk, which needs Linux /proc.
// Off Linux it throws `unsupported-platform` (TASK-899), so the tests that read
// real files skip there. CI runs them on ubuntu.
const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
}

const silentLog: Logger = ctx().logger;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-uf-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** A localDir resolver over `root` — the per-agent subtree is `<root>/<agentId>`,
 *  honoring the readOnly flag exactly like @ax/workspace-localdir. */
function busWithLocaldir(): HookBus {
  const bus = new HookBus();
  bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
    'sandbox:resolve-mounts',
    'mock-localdir',
    async (_c, input) => ({
      mounts: input.owner.agentId
        ? [
            {
              kind: 'localDir' as const,
              mountPath: '/workspace',
              hostPath: path.join(root, input.owner.agentId),
              readOnly: input.readOnly === true,
              role: 'user-files' as const,
            },
          ]
        : [],
    }),
  );
  return bus;
}

async function seedAgentFiles(agentId: string): Promise<string> {
  const dir = path.join(root, agentId);
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'hello.txt'), 'hi from ' + agentId);
  await fs.writeFile(path.join(dir, 'docs', 'note.md'), '# note');
  return dir;
}

describe('readUserFiles (subprocess host-read)', () => {
  it('returns UNAVAILABLE (not absent) when no resolver is loaded', async () => {
    /*
      TASK-403. "This deployment keeps no durable files for this agent" is a
      different answer from "that path is not there", and it used to be the
      same one — which left the Files tab with nothing to say but "either your
      agent wrote nothing or this server isn't keeping them, we can't tell
      which". It is decided before any path is consulted, so telling the two
      apart discloses nothing about which paths exist.
    */
    const bus = new HookBus();
    const out = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
    });
    expect(out).toEqual({ kind: 'unavailable' });
  });

  it.skipIf(!ON_LINUX)('lists the mount root directory (dir kind)', async () => {
    await seedAgentFiles('agent-a');
    const bus = busWithLocaldir();
    const out = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
    });
    expect(out.kind).toBe('dir');
    if (out.kind !== 'dir') throw new Error('expected dir');
    const byName = new Map(out.entries.map((e) => [e.name, e.kind]));
    expect(byName.get('hello.txt')).toBe('file');
    expect(byName.get('docs')).toBe('dir');
  });

  it.skipIf(!ON_LINUX)('reads a file under the mount (file kind, exact bytes)', async () => {
    await seedAgentFiles('agent-a');
    const bus = busWithLocaldir();
    const out = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'docs/note.md',
    });
    expect(out.kind).toBe('file');
    if (out.kind !== 'file') throw new Error('expected file');
    expect(Buffer.from(out.contents).toString('utf-8')).toBe('# note');
  });

  it.skipIf(!ON_LINUX)('returns absent for a missing path', async () => {
    await seedAgentFiles('agent-a');
    const bus = busWithLocaldir();
    const out = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'nope/missing.txt',
    });
    expect(out).toEqual({ kind: 'absent' });
  });

  it('SECURITY: rejects a traversal relPath (..) so a caller cannot escape the mount', async () => {
    // Plant a secret in a SIBLING agent's subtree.
    await seedAgentFiles('agent-a');
    await fs.writeFile(path.join(root, 'agent-b-secret'), 'TOPSECRET');
    const bus = busWithLocaldir();
    await expect(
      readUserFiles(ctx(), bus, PLUGIN, {
        owner: ownerFromAgentId('agent-a', 'u1'),
        relPath: '../agent-b-secret',
      }),
    ).rejects.toThrow(/\.\./);
  });

  it('SECURITY: rejects an absolute relPath', async () => {
    await seedAgentFiles('agent-a');
    const bus = busWithLocaldir();
    await expect(
      readUserFiles(ctx(), bus, PLUGIN, {
        owner: ownerFromAgentId('agent-a', 'u1'),
        relPath: '/etc/passwd',
      }),
    ).rejects.toThrow(/relative/);
  });

  it.skipIf(!ON_LINUX)('SECURITY: a symlink at the target is treated as absent (never followed)', async () => {
    const dir = await seedAgentFiles('agent-a');
    // Plant a symlink inside the mount pointing OUTSIDE it.
    await fs.writeFile(path.join(root, 'outside.txt'), 'OUTSIDE');
    await fs.symlink(path.join(root, 'outside.txt'), path.join(dir, 'link.txt'));
    const bus = busWithLocaldir();
    const out = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'link.txt',
    });
    expect(out).toEqual({ kind: 'absent' });
    // And a dir listing omits the symlink entirely.
    const list = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
    });
    if (list.kind !== 'dir') throw new Error('expected dir');
    expect(list.entries.map((e) => e.name)).not.toContain('link.txt');
  });

  // SECURITY REGRESSION (cross-tenant disclosure, HIGH): the agent can plant an
  // INTERMEDIATE symlink inside its OWN subtree pointing at a sibling agent's
  // subtree, then read THROUGH it. A lexical relPath guard (`..`/absolute) does
  // NOT catch this — only the per-component walk does. Reading
  // `escape/secret.txt` where `escape -> <root>/agent-b` must yield ABSENT, not
  // agent-b's file.
  it.skipIf(!ON_LINUX)('SECURITY: an INTERMEDIATE symlink to a sibling agent subtree does NOT disclose its files', async () => {
    const dirA = await seedAgentFiles('agent-a');
    const dirB = await seedAgentFiles('agent-b');
    await fs.writeFile(path.join(dirB, 'secret.txt'), 'AGENT-B-SECRET');
    // Inside agent-a's OWN subtree, a dir symlink pointing at agent-b's subtree.
    await fs.symlink(dirB, path.join(dirA, 'escape'));
    const bus = busWithLocaldir();

    // Read a file THROUGH the intermediate symlink.
    const file = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'escape/secret.txt',
    });
    expect(file).toEqual({ kind: 'absent' });

    // List THROUGH the intermediate symlink.
    const list = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'escape',
    });
    expect(list).toEqual({ kind: 'absent' });

    // And the symlink itself is not even listed at the root.
    const rootList = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
    });
    if (rootList.kind !== 'dir') throw new Error('expected dir');
    expect(rootList.entries.map((e) => e.name)).not.toContain('escape');
    // agent-b's subtree is entirely untouched.
    expect(
      Buffer.from(await fs.readFile(path.join(dirB, 'secret.txt'))).toString('utf-8'),
    ).toBe('AGENT-B-SECRET');
  });

  it.skipIf(!ON_LINUX)('SECURITY: an in-root symlink is absent: the host-read is the per-component walk', async () => {
    // A realpath reader serves both of these (they stay inside the subtree);
    // only the walk refuses a symlink at any depth, so this pins the reader.
    const dir = await seedAgentFiles('agent-a');
    await fs.symlink('hello.txt', path.join(dir, 'alias.md'));
    await fs.symlink('docs', path.join(dir, 'alias'));
    const bus = busWithLocaldir();
    for (const relPath of ['alias.md', 'alias/note.md']) {
      const out = await readUserFiles(ctx(), bus, PLUGIN, {
        owner: ownerFromAgentId('agent-a', 'u1'),
        relPath,
      });
      expect(out).toEqual({ kind: 'absent' });
    }
  });

  it.skipIf(!ON_LINUX)('SECURITY: an INTERMEDIATE symlink to an absolute host path does NOT disclose it', async () => {
    const dirA = await seedAgentFiles('agent-a');
    // A symlink to the host filesystem root.
    await fs.symlink('/', path.join(dirA, 'rootlink'));
    const bus = busWithLocaldir();
    const out = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'rootlink/etc/hostname',
    });
    expect(out).toEqual({ kind: 'absent' });
  });

  it.skipIf(!ON_LINUX)('SECURITY: never opens a writable handle — the file is unchanged after a read', async () => {
    const dir = await seedAgentFiles('agent-a');
    const before = await fs.stat(path.join(dir, 'hello.txt'));
    const bus = busWithLocaldir();
    await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'hello.txt',
    });
    const after = await fs.stat(path.join(dir, 'hello.txt'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it.skipIf(!ON_LINUX)('sandbox:read-user-files still returns a 2 MiB file as its first 1 MiB with truncated: true', async () => {
    // TASK-1014 added a second read of the same files, for downloads. The
    // preview read must not have quietly picked up its reach: a preview is
    // still the first MiB, and still says it is only the beginning.
    const dir = await seedAgentFiles('agent-a');
    const data = randomBytes(2 * MiB);
    await fs.writeFile(path.join(dir, 'docs', 'big.bin'), data);
    const out = await readUserFiles(ctx(), busWithLocaldir(), PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
      relPath: 'docs/big.bin',
    });
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.truncated).toBe(true);
    expect(out.contents.byteLength).toBe(MiB);
    expect(Buffer.from(out.contents).equals(data.subarray(0, MiB)), 'the first MiB').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK-1014 — `sandbox:read-user-file-range`: one byte range of one file under
// the resolved `localDir` hostPath, so a download can stream a file of any size
// a range at a time. Same resolver and the same confined walk as the preview
// read above (`@ax/user-files-read`), so the cross-tenant rules are pinned
// again HERE, at the provider: what matters is the root this provider hands the
// reader, and that it never hands it a writable one.
// ---------------------------------------------------------------------------
describe('readUserFileRange (subprocess, TASK-1014)', () => {
  function rangeInput(
    agentId: string,
    relPath: string,
    offset = 0,
    length = MiB,
  ): ReadUserFileRangeInput {
    return { owner: ownerFromAgentId(agentId, 'u1'), relPath, offset, length };
  }

  it('range: UNAVAILABLE when no resolver is loaded', async () => {
    // A fact about the deployment, decided before any path is looked at — the
    // same answer `sandbox:read-user-files` gives (TASK-403).
    const out = await readUserFileRange(
      ctx(),
      new HookBus(),
      PLUGIN,
      rangeInput('agent-a', 'hello.txt'),
    );
    expect(out).toEqual({ kind: 'unavailable' });
  });

  it('range: asks the resolver for a READ-ONLY realization', async () => {
    const bus = new HookBus();
    const asked: Array<boolean | undefined> = [];
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'mock-localdir',
      async (_c, input) => {
        asked.push(input.readOnly);
        return {
          mounts: [
            {
              kind: 'localDir',
              mountPath: '/workspace',
              hostPath: path.join(root, input.owner.agentId),
              readOnly: input.readOnly === true,
              role: 'user-files',
            },
          ],
        };
      },
    );
    // Off Linux the walk itself throws unsupported-platform; the resolve
    // happens first either way.
    await readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', 'hello.txt')).catch(
      () => undefined,
    );
    expect(asked).toEqual([true]);
  });

  it('SECURITY: range: rejects a traversal / absolute relPath', async () => {
    await seedAgentFiles('agent-a');
    await fs.writeFile(path.join(root, 'agent-b-secret'), 'TOPSECRET');
    const bus = busWithLocaldir();
    await expect(
      readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', '../agent-b-secret')),
    ).rejects.toThrow(/\.\./);
    await expect(
      readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', '/etc/passwd')),
    ).rejects.toThrow(/relative/);
  });

  it('range: throws PluginError on an nfs mount (mis-wired preset)', async () => {
    const bus = new HookBus();
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'mock-nfs',
      async () => ({
        mounts: [
          {
            kind: 'nfs',
            mountPath: '/workspace',
            server: '10.0.0.2',
            exportPath: '/vol1/agents',
            subPath: 'agent-a',
            readOnly: true,
            role: 'user-files',
          },
        ],
      }),
    );
    await expect(
      readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', 'hello.txt')),
    ).rejects.toMatchObject({ code: 'unrealizable-mount-kind' });
    await expect(
      readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', 'hello.txt')),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it.skipIf(!ON_LINUX)('range: exact bytes at an offset under the mount', async () => {
    const dir = await seedAgentFiles('agent-a');
    const data = randomBytes(3 * MiB);
    await fs.writeFile(path.join(dir, 'docs', 'big.bin'), data);
    const bus = busWithLocaldir();
    const out = await readUserFileRange(
      ctx(),
      bus,
      PLUGIN,
      rangeInput('agent-a', 'docs/big.bin', MiB + 7, MiB),
    );
    if (out.kind !== 'file') throw new Error(`expected file, got ${out.kind}`);
    expect(out.size).toBe(3 * MiB);
    expect(out.bytes.byteLength).toBe(MiB);
    expect(
      Buffer.from(out.bytes).equals(data.subarray(MiB + 7, 2 * MiB + 7)),
      'the bytes at [1 MiB + 7, 2 MiB + 7)',
    ).toBe(true);
    // The validation call a download ends with: nothing read, same answer.
    const end = await readUserFileRange(
      ctx(),
      bus,
      PLUGIN,
      rangeInput('agent-a', 'docs/big.bin', 3 * MiB, 0),
    );
    if (end.kind !== 'file') throw new Error(`expected file, got ${end.kind}`);
    expect(end.bytes.byteLength).toBe(0);
    expect(end.size).toBe(3 * MiB);
    expect(end.version).toBe(out.version);
    // The agent's root is a directory, answered without a listing.
    expect(
      await readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', '')),
    ).toEqual({ kind: 'dir' });
  });

  it.skipIf(!ON_LINUX)('SECURITY: range: intermediate symlink to a sibling agent subtree discloses nothing', async () => {
    const dirA = await seedAgentFiles('agent-a');
    const dirB = await seedAgentFiles('agent-b');
    await fs.writeFile(path.join(dirB, 'secret.txt'), 'AGENT-B-SECRET');
    await fs.symlink(dirB, path.join(dirA, 'escape'));
    const bus = busWithLocaldir();
    for (const relPath of ['escape/secret.txt', 'escape']) {
      expect(
        await readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', relPath)),
        relPath,
      ).toEqual({ kind: 'absent' });
    }
  });

  it.skipIf(!ON_LINUX)("CROSS-TENANT: range: the root is this agent's own folder, so a sibling's file is absent by any name", async () => {
    // The reader confines to the root it is handed, so the root is the
    // cross-tenant property: it must be `<root>/<agentId>`, never the folder
    // that holds every agent's. Named relative to that shared folder, a
    // sibling's file must not be there for this agent.
    await seedAgentFiles('agent-a');
    const dirB = await seedAgentFiles('agent-b');
    await fs.writeFile(path.join(dirB, 'secret.txt'), 'AGENT-B-SECRET');
    const bus = busWithLocaldir();
    for (const relPath of ['agent-b/secret.txt', 'agent-b']) {
      expect(
        await readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', relPath)),
        relPath,
      ).toEqual({ kind: 'absent' });
    }
    // The same request as agent-b reads agent-b's own file, so the absence
    // above is the confinement and not a broken fixture.
    const own = await readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-b', 'secret.txt'));
    if (own.kind !== 'file') throw new Error(`expected file, got ${own.kind}`);
    expect(Buffer.from(own.bytes).toString('utf-8')).toBe('AGENT-B-SECRET');
  });

  it.skipIf(!ON_LINUX)('SECURITY: range: final symlink is absent', async () => {
    const dir = await seedAgentFiles('agent-a');
    await fs.writeFile(path.join(root, 'outside.txt'), 'OUTSIDE');
    await fs.symlink(path.join(root, 'outside.txt'), path.join(dir, 'link.txt'));
    // In-root links too: where a link points is never looked at.
    await fs.symlink('hello.txt', path.join(dir, 'alias.md'));
    const bus = busWithLocaldir();
    for (const relPath of ['link.txt', 'alias.md']) {
      expect(
        await readUserFileRange(ctx(), bus, PLUGIN, rangeInput('agent-a', relPath)),
        relPath,
      ).toEqual({ kind: 'absent' });
    }
  });

  it.skipIf(!ON_LINUX)('SECURITY: range: FIFO is absent', async () => {
    const dir = await seedAgentFiles('agent-a');
    const fifo = path.join(dir, 'pipe');
    expect(spawnSync('mkfifo', [fifo]).status, `mkfifo ${fifo}`).toBe(0);
    // If the open ever waited for a writer, the timer says so quickly instead
    // of leaving the test to hang until its timeout.
    let timer: NodeJS.Timeout | undefined;
    const blocked = new Promise<'blocked'>((resolve) => {
      timer = setTimeout(() => resolve('blocked'), 3_000);
    });
    try {
      const out = await Promise.race([
        readUserFileRange(ctx(), busWithLocaldir(), PLUGIN, rangeInput('agent-a', 'pipe')),
        blocked,
      ]);
      expect(out).toEqual({ kind: 'absent' });
    } finally {
      clearTimeout(timer);
      // A parked open, if there is one, finishes once a writer appears.
      await (await fs.open(fifo, constants.O_RDWR | constants.O_NONBLOCK)).close();
    }
  });

  it.skipIf(!ON_LINUX)('SECURITY: range: never opens a writable handle (mtime unchanged after reads)', async () => {
    const dir = await seedAgentFiles('agent-a');
    const file = path.join(dir, 'hello.txt');
    const before = await fs.stat(file);
    const flags: unknown[] = [];
    const realOpen = fs.open;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (p, f, mode) => {
      flags.push(f);
      return realOpen(p, f, mode);
    });
    try {
      const bus = busWithLocaldir();
      for (const [offset, length] of [
        [0, 0],
        [0, MiB],
        [3, 2],
      ] as const) {
        const out = await readUserFileRange(
          ctx(),
          bus,
          PLUGIN,
          rangeInput('agent-a', 'hello.txt', offset, length),
        );
        expect(out.kind).toBe('file');
      }
    } finally {
      spy.mockRestore();
    }
    const after = await fs.stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    // And structurally: no open the range read made could have written.
    const WRITE =
      constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      expect(typeof f).toBe('number');
      expect((f as number) & WRITE).toBe(0);
    }
  });
});

describe('cleanupUserFiles (subprocess agent-delete cleanup)', () => {
  it('rm -rf the deleted agent subtree', async () => {
    const dir = await seedAgentFiles('agent-a');
    expect(await exists(dir)).toBe(true);
    const bus = busWithLocaldir();
    await cleanupUserFiles(
      ctx(),
      bus,
      PLUGIN,
      ownerFromAgentId('agent-a', 'u1'),
      silentLog,
    );
    expect(await exists(dir)).toBe(false);
  });

  it('CROSS-TENANT: deleting agent A does NOT touch agent B subtree', async () => {
    const dirA = await seedAgentFiles('agent-a');
    const dirB = await seedAgentFiles('agent-b');
    const bus = busWithLocaldir();
    await cleanupUserFiles(
      ctx(),
      bus,
      PLUGIN,
      ownerFromAgentId('agent-a', 'u1'),
      silentLog,
    );
    expect(await exists(dirA)).toBe(false);
    // B's subtree + its files are entirely untouched.
    expect(await exists(dirB)).toBe(true);
    expect(
      Buffer.from(await fs.readFile(path.join(dirB, 'hello.txt'))).toString('utf-8'),
    ).toBe('hi from agent-b');
  });

  it('is a graceful no-op when no resolver is loaded', async () => {
    const dir = await seedAgentFiles('agent-a');
    const bus = new HookBus();
    await cleanupUserFiles(
      ctx(),
      bus,
      PLUGIN,
      ownerFromAgentId('agent-a', 'u1'),
      silentLog,
    );
    // Nothing resolved → nothing deleted.
    expect(await exists(dir)).toBe(true);
  });

  it('is a no-op (not a throw) for an empty/absent subtree', async () => {
    // No files seeded for agent-c at all.
    const bus = busWithLocaldir();
    await expect(
      cleanupUserFiles(
        ctx(),
        bus,
        PLUGIN,
        ownerFromAgentId('agent-c', 'u1'),
        silentLog,
      ),
    ).resolves.toBeUndefined();
  });

  it('does NOT throw on a mis-wired resolver (nfs kind) — logs + continues', async () => {
    // An nfs-emitting resolver paired with the subprocess provider is a wiring
    // bug; cleanup must not crash the (already-committed) delete.
    const bus = new HookBus();
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'mock-nfs',
      async () => ({
        mounts: [
          {
            kind: 'nfs',
            mountPath: '/workspace',
            server: '10.0.0.2',
            exportPath: '/vol1/agents',
            subPath: 'agent-a',
            readOnly: false,
            role: 'user-files',
          },
        ],
      }),
    );
    await expect(
      cleanupUserFiles(
        ctx(),
        bus,
        PLUGIN,
        ownerFromAgentId('agent-a', 'u1'),
        silentLog,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('readUserFiles unrealizable kind', () => {
  it('throws PluginError on an nfs mount (mis-wired preset)', async () => {
    const bus = new HookBus();
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'mock-nfs',
      async () => ({
        mounts: [
          {
            kind: 'nfs',
            mountPath: '/workspace',
            server: '10.0.0.2',
            exportPath: '/vol1/agents',
            subPath: 'agent-a',
            readOnly: true,
            role: 'user-files',
          },
        ],
      }),
    );
    const input: ReadUserFilesInput = { owner: ownerFromAgentId('agent-a', 'u1') };
    await expect(readUserFiles(ctx(), bus, PLUGIN, input)).rejects.toBeInstanceOf(
      PluginError,
    );
  });
});

// ---------------------------------------------------------------------------
// TASK-993 — `sandbox:user-files-usage`: how much an agent's /files holds, for
// the storage limit. Measured at the resolved `localDir` hostPath.
// ---------------------------------------------------------------------------
describe('measureUserFiles (subprocess, TASK-993)', () => {
  /** Allocated bytes of the tree at `dir`, never following a link. */
  async function lstatOracle(dir: string): Promise<number> {
    const st = await fs.lstat(dir);
    let total = st.blocks * 512;
    if (!st.isDirectory()) return total;
    for (const name of await fs.readdir(dir)) total += await lstatOracle(path.join(dir, name));
    return total;
  }

  it('no resolver means home-unavailable', async () => {
    await expect(
      measureUserFiles(ctx(), new HookBus(), PLUGIN, silentLog, { agentId: 'agent-a' }),
    ).rejects.toMatchObject({ code: 'home-unavailable' });
  });

  it('an nfs mount is unrealizable here', async () => {
    const bus = new HookBus();
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'mock-nfs',
      async () => ({
        mounts: [
          {
            kind: 'nfs',
            mountPath: '/workspace',
            server: 'files.example.invalid',
            exportPath: '/vol1/agents',
            subPath: 'agent-a',
            readOnly: true,
            role: 'user-files',
          },
        ],
      }),
    );
    await expect(
      measureUserFiles(ctx(), bus, PLUGIN, silentLog, { agentId: 'agent-a' }),
    ).rejects.toMatchObject({ code: 'unrealizable-mount-kind' });
  });

  it('invalid-input: a missing or empty agentId is refused before the resolver is asked', async () => {
    const bus = new HookBus();
    let asked = 0;
    bus.registerService<ResolveMountsInput, ResolveMountsOutput>(
      'sandbox:resolve-mounts',
      'mock-localdir',
      async () => {
        asked++;
        return { mounts: [] };
      },
    );
    for (const input of [{ agentId: '' }, {}, undefined, { agentId: 7 }]) {
      await expect(
        measureUserFiles(ctx(), bus, PLUGIN, silentLog, input as unknown as { agentId: string }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
    }
    expect(asked).toBe(0);
  });

  it.skipIf(!ON_LINUX)('measures the resolved hostPath', async () => {
    const dir = await seedAgentFiles('agent-a');
    await fs.writeFile(path.join(dir, 'docs', 'big.bin'), Buffer.alloc(256 * 1024, 7));
    // A sibling agent's files are not this agent's.
    const other = await seedAgentFiles('agent-b');
    await fs.writeFile(path.join(other, 'huge.bin'), Buffer.alloc(4 * 1024 * 1024, 1));
    const out = await measureUserFiles(ctx(), busWithLocaldir(), PLUGIN, silentLog, {
      agentId: 'agent-a',
    });
    expect(out).toEqual({ bytes: await lstatOracle(dir) });
    expect(out.bytes).toBeGreaterThanOrEqual(256 * 1024);
    expect(out.bytes).toBeLessThan(4 * 1024 * 1024);
  });

  it.skipIf(!ON_LINUX)('a folder that does not exist yet is 0', async () => {
    // The agent has never had a session, so its folder was never made. The
    // folder that would hold it (the resolver's root) is there.
    const out = await measureUserFiles(ctx(), busWithLocaldir(), PLUGIN, silentLog, {
      agentId: 'agent-never-ran',
    });
    expect(out).toEqual({ bytes: 0 });
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
