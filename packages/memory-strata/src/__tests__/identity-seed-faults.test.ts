import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  makeAgentContext,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
} from '@ax/core';

// ---------------------------------------------------------------------------
// TASK-556: fault injection the real filesystem can't produce on demand.
//
//   (1) The CLI / local-FS identity read (`composeIdentityFromFiles`) must fail
//       the chat:start seed on a non-ENOENT lstat/readFile error, exactly like
//       the tier read does since TASK-553 — not degrade it to "absent" and seed
//       the placeholder that bootstrap then never replaced.
//   (3) `hydrateAgentTier` must remove its `mkdtemp` scratch dir when a read
//       throws mid-hydrate; the caller never gets a `dispose` to call.
//
// `node:fs/promises` is wrapped, not replaced: every call passes through to the
// real module unless a test arms a fault for a matching path.
// ---------------------------------------------------------------------------

type Fault = { match: (path: string) => boolean; code: string; remaining: number };
const faults: { lstat: Fault[]; readFile: Fault[] } = { lstat: [], readFile: [] };
const createdTemps: string[] = [];

function takeFault(list: Fault[], path: string): Fault | undefined {
  const f = list.find((x) => x.remaining > 0 && x.match(path));
  if (f !== undefined) f.remaining--;
  return f;
}

function errnoError(code: string, path: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: injected, ${path}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = {
    ...real,
    lstat: (async (p: Parameters<typeof real.lstat>[0], ...rest: unknown[]) => {
      const f = takeFault(faults.lstat, String(p));
      if (f !== undefined) throw errnoError(f.code, String(p));
      return (real.lstat as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.lstat,
    readFile: (async (p: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
      const f = takeFault(faults.readFile, String(p));
      if (f !== undefined) throw errnoError(f.code, String(p));
      return (real.readFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readFile,
    mkdtemp: (async (...args: Parameters<typeof real.mkdtemp>) => {
      const dir = await real.mkdtemp(...args);
      createdTemps.push(String(dir));
      return dir;
    }) as typeof real.mkdtemp,
  };
  return { ...wrapped, default: wrapped };
});

// Imported AFTER the mock is declared (vi.mock is hoisted regardless).
const { composeIdentityFromFiles } = await import('../compose-identity.js');
const { hydrateAgentTier } = await import('../agent-tier-sync.js');
const { createMemoryStrataPlugin } = await import('../plugin.js');
const { systemFile } = await import('../paths.js');
const { readRegularFile } = await import('../bootstrap.js');

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let workspaceRoot: string;

beforeEach(async () => {
  faults.lstat = [];
  faults.readFile = [];
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memory-strata-faults-'));
  createdTemps.length = 0; // don't count the fixture's own temp dir
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function writeIdentity(text: string): Promise<void> {
  const axDir = join(workspaceRoot, 'permanent', '.ax');
  await mkdir(axDir, { recursive: true });
  await writeFile(join(axDir, 'IDENTITY.md'), text, 'utf8');
}

const isIdentityPath = (p: string): boolean => p.endsWith(join('.ax', 'IDENTITY.md'));

function recordingCtx(workspace: string) {
  const warns: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
  const base = makeAgentContext({
    sessionId: 's1',
    agentId: 'atlas',
    userId: 'u1',
    workspace: { rootPath: workspace },
  });
  const ctx = makeAgentContext({
    sessionId: 's1',
    agentId: 'atlas',
    userId: 'u1',
    workspace: { rootPath: workspace },
    logger: {
      ...base.logger,
      warn: (msg: string, fields?: Record<string, unknown>) => {
        warns.push({ msg, fields });
      },
    },
  });
  return { ctx, warns };
}

function cliBus(): HookBus {
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'test-agents', async () => ({
    agent: { model: 'anthropic/claude-haiku-4-5-20251001' },
  }));
  bus.registerService('tool:register', 'test-tools', async () => ({ ok: true as const }));
  return bus;
}

describe('composeIdentityFromFiles: a non-ENOENT error is not "absent" (TASK-556)', () => {
  it('rejects, naming the file, when lstat fails with EACCES', async () => {
    await writeIdentity('I am Atlas.');
    faults.lstat.push({ match: isIdentityPath, code: 'EACCES', remaining: 1 });

    await expect(composeIdentityFromFiles(workspaceRoot)).rejects.toThrow(/\.ax\/IDENTITY\.md/);
  });

  it('rejects when readFile fails with EIO after a clean lstat', async () => {
    await writeIdentity('I am Atlas.');
    faults.readFile.push({ match: isIdentityPath, code: 'EIO', remaining: 1 });

    const err = await composeIdentityFromFiles(workspaceRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain('.ax/IDENTITY.md');
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe('EIO');
  });

  it('still treats ENOENT (absent file, or deleted between lstat and read) as absent', async () => {
    await writeIdentity('I am Atlas.');
    faults.readFile.push({ match: isIdentityPath, code: 'ENOENT', remaining: 1 });

    await expect(composeIdentityFromFiles(workspaceRoot)).resolves.toBe('');
    // And a workspace with no .ax/ at all is simply empty.
    await rm(join(workspaceRoot, 'permanent'), { recursive: true, force: true });
    await expect(composeIdentityFromFiles(workspaceRoot)).resolves.toBe('');
  });
});

describe('readRegularFile shares readAxFile\'s notion of "absent" (TASK-560)', () => {
  const isAgentPath = (p: string): boolean => p.endsWith(join('system', 'agent.md'));

  it('a file deleted between lstat and readFile (ENOENT) is absent', async () => {
    const abs = join(workspaceRoot, systemFile('agent'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, 'x', 'utf8');
    faults.readFile.push({ match: isAgentPath, code: 'ENOENT', remaining: 1 });

    await expect(readRegularFile(abs)).resolves.toBeUndefined();
    expect(faults.readFile[0]!.remaining).toBe(0);
  });

  it('ENOTDIR from readFile after a clean lstat is absent too (the shared predicate, not ENOENT alone)', async () => {
    const abs = join(workspaceRoot, systemFile('agent'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, 'x', 'utf8');
    faults.readFile.push({ match: isAgentPath, code: 'ENOTDIR', remaining: 1 });

    await expect(readRegularFile(abs)).resolves.toBeUndefined();
    expect(faults.readFile[0]!.remaining).toBe(0);
  });

  // Pin (passed before TASK-560 too): "absent" stays narrow.
  it('any other error still throws, from lstat or from readFile', async () => {
    const abs = join(workspaceRoot, systemFile('agent'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, 'x', 'utf8');

    faults.lstat.push({ match: isAgentPath, code: 'EACCES', remaining: 1 });
    await expect(readRegularFile(abs)).rejects.toMatchObject({ code: 'EACCES' });

    faults.readFile.push({ match: isAgentPath, code: 'EIO', remaining: 1 });
    await expect(readRegularFile(abs)).rejects.toMatchObject({ code: 'EIO' });
  });

  // Pin (the turn failed before TASK-560 too, at the agent.md read; now it
  // fails one step later, at bootstrap's mkdir). The whole CLI chat:start path
  // over a tree where `system/` is a regular file: agent.md reads as absent,
  // bootstrap cannot create system/, the turn warns and writes nothing.
  it('CLI chat:start over a corrupt tree still fails closed and leaves the file alone', async () => {
    const bus = cliBus();
    await createMemoryStrataPlugin({ consolidatorDebounceMs: 0 }).init?.({ bus, config: {} });
    const { ctx, warns } = recordingCtx(workspaceRoot);
    const systemPath = join(workspaceRoot, systemFile('agent'), '..');
    await mkdir(join(systemPath, '..'), { recursive: true });
    await writeFile(systemPath, 'not a dir', 'utf8');

    await bus.fire('chat:start', ctx, {});

    expect(warns.map((w) => w.msg)).toContain('memory_strata_bootstrap_failed');
    expect(await readFile(systemPath, 'utf8')).toBe('not a dir');
  });
});

describe('CLI chat:start: a failed identity read never seeds the placeholder (TASK-556)', () => {
  it('turn 1 (EACCES) seeds nothing and warns with the agent id; turn 2 seeds the real identity', async () => {
    await writeIdentity('I am Atlas, a careful deployer.');
    const bus = cliBus();
    await createMemoryStrataPlugin({ consolidatorDebounceMs: 0 }).init?.({ bus, config: {} });
    const { ctx, warns } = recordingCtx(workspaceRoot);
    faults.lstat.push({ match: isIdentityPath, code: 'EACCES', remaining: 1 });

    await bus.fire('chat:start', ctx, {});

    expect(faults.lstat[0]!.remaining).toBe(0);
    expect(await exists(join(workspaceRoot, systemFile('agent')))).toBe(false);
    const warn = warns.find((w) => w.msg === 'memory_strata_bootstrap_failed');
    expect(warn, JSON.stringify(warns.map((w) => w.msg))).toBeDefined();
    expect(warn!.fields?.agentId).toBe('atlas');
    expect(String(warn!.fields?.err)).toContain('.ax/IDENTITY.md');

    await bus.fire('chat:start', ctx, {});

    const agentMd = await readFile(join(workspaceRoot, systemFile('agent')), 'utf8');
    expect(agentMd).toContain('I am Atlas, a careful deployer.');
    expect(agentMd).not.toContain('has not authored its identity');
  });
});

describe('CLI chat:start: a warm agent never reads identity, so a stuck identity file cannot fail its seed (TASK-556)', () => {
  it('real agent.md + persistent EACCES on IDENTITY.md: no warn, a missing seed file is still created', async () => {
    await writeIdentity('I am Atlas.');
    const bus = cliBus();
    await createMemoryStrataPlugin({ consolidatorDebounceMs: 0 }).init?.({ bus, config: {} });
    const { ctx, warns } = recordingCtx(workspaceRoot);
    await bus.fire('chat:start', ctx, {});
    await rm(join(workspaceRoot, systemFile('session')));
    const lstatFault: Fault = { match: isIdentityPath, code: 'EACCES', remaining: 1000 };
    faults.lstat.push(lstatFault);

    await bus.fire('chat:start', ctx, {});

    expect(lstatFault.remaining).toBe(1000); // identity was never touched
    expect(warns.map((w) => w.msg)).not.toContain('memory_strata_bootstrap_failed');
    expect(await exists(join(workspaceRoot, systemFile('session')))).toBe(true);
  });
});

describe('hydrateAgentTier disposes its scratch dir when it throws (TASK-556)', () => {
  function tierBus(failPath: string): HookBus {
    const bus = new HookBus();
    bus.registerService<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      'test-tier',
      async (_ctx, input) => {
        if (input.path === failPath) throw new Error('storage backend blip');
        return { found: true, bytes: new TextEncoder().encode(`body of ${input.path}`) };
      },
    );
    bus.registerService('workspace:apply', 'test-tier', async () => {
      throw new Error('this test never reaches a flush');
    });
    bus.registerService<WorkspaceListInput, WorkspaceListOutput>(
      'workspace:list',
      'test-tier',
      async () => ({ paths: ['memory/system/agent.md', 'memory/system/user.md'] }),
    );
    bus.registerService('agents:resolve', 'test-agents', async () => ({
      agent: { model: 'anthropic/claude-haiku-4-5-20251001' },
    }));
    bus.registerService('tool:register', 'test-tools', async () => ({ ok: true as const }));
    return bus;
  }

  it('a read that throws after the first file landed: the error propagates and the scratch dir is gone', async () => {
    const bus = tierBus('memory/system/user.md');
    const { ctx } = recordingCtx('/opt/ax-next/host');

    await expect(hydrateAgentTier(bus, ctx)).rejects.toThrow('storage backend blip');

    expect(createdTemps).toHaveLength(1);
    expect(await exists(createdTemps[0]!)).toBe(false);
  });

  it('the chat:start seed (only mode) leaks nothing when its hydrate throws', async () => {
    const bus = tierBus('memory/system/session.md');
    await createMemoryStrataPlugin({ consolidatorDebounceMs: 0 }).init?.({ bus, config: {} });
    const { ctx, warns } = recordingCtx('/opt/ax-next/host');

    await bus.fire('chat:start', ctx, {});

    expect(warns.map((w) => w.msg)).toContain('memory_strata_bootstrap_failed');
    expect(createdTemps).toHaveLength(1);
    expect(await exists(createdTemps[0]!)).toBe(false);
  });
});
