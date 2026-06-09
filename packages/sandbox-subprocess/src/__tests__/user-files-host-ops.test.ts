import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type Logger } from '@ax/core';
import type {
  ReadUserFilesInput,
  ResolveMountsInput,
  ResolveMountsOutput,
} from '@ax/sandbox-mount-protocol';
import {
  cleanupUserFiles,
  ownerFromAgentId,
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
  it('returns absent when no resolver is loaded', async () => {
    const bus = new HookBus();
    const out = await readUserFiles(ctx(), bus, PLUGIN, {
      owner: ownerFromAgentId('agent-a', 'u1'),
    });
    expect(out).toEqual({ kind: 'absent' });
  });

  it('lists the mount root directory (dir kind)', async () => {
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

  it('reads a file under the mount (file kind, exact bytes)', async () => {
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

  it('returns absent for a missing path', async () => {
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

  it('SECURITY: a symlink at the target is treated as absent (never followed)', async () => {
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
  // NOT catch this — only realpath-confinement does. Reading
  // `escape/secret.txt` where `escape -> <root>/agent-b` must yield ABSENT, not
  // agent-b's file.
  it('SECURITY: an INTERMEDIATE symlink to a sibling agent subtree does NOT disclose its files', async () => {
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

  it('SECURITY: an INTERMEDIATE symlink to an absolute host path does NOT disclose it', async () => {
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

  it('SECURITY: never opens a writable handle — the file is unchanged after a read', async () => {
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
