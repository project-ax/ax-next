import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { bootstrapMemoryTree, readRegularFile } from '../bootstrap.js';
import { composeIdentityFromFiles } from '../compose-identity.js';
import { workspaceMemoryRoot, systemFile, mapFile, MEMORY_ROOT } from '../paths.js';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memory-strata-bootstrap-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (m === null) throw new Error('no frontmatter found');
  const fm = yamlLoad(m[1] ?? '') as Record<string, unknown>;
  return { fm, body: m[2] ?? '' };
}

describe('bootstrapMemoryTree', () => {
  it('seeds system/{agent,user,session}.md with valid frontmatter', async () => {
    await bootstrapMemoryTree({
      workspaceRoot,
      composedIdentity: 'You are a helpful assistant who likes long walks.',
    });

    const root = join(workspaceRoot, MEMORY_ROOT);
    expect((await stat(root)).isDirectory()).toBe(true);

    for (const name of ['agent', 'user', 'session'] as const) {
      const path = join(workspaceRoot, systemFile(name));
      const raw = await readFile(path, 'utf8');
      const { fm } = splitFrontmatter(raw);

      expect(fm['id']).toBe(name);
      expect(fm['type']).toBe(`system/${name}`);
      expect(typeof fm['created']).toBe('string');
      expect(Number.isNaN(Date.parse(fm['created'] as string))).toBe(false);
      expect(fm['confidence']).toBe(1.0);
      expect(fm['pinned']).toBe(true);
      expect(typeof fm['summary']).toBe('string');
    }
  });

  it("seeds agent.md body from the composed identity", async () => {
    const prompt = 'You are Atlas, a friendly research assistant.';
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: prompt });

    const raw = await readFile(join(workspaceRoot, systemFile('agent')), 'utf8');
    const { body } = splitFrontmatter(raw);
    expect(body).toContain(prompt);
  });

  it('is idempotent — second call leaves existing files untouched', async () => {
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: 'first' });
    const path = join(workspaceRoot, systemFile('agent'));
    const before = await readFile(path, 'utf8');

    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: 'second' });
    const after = await readFile(path, 'utf8');

    expect(after).toBe(before);
  });

  it('TASK-190: seeds an empty system/map.md so inject always has a map to read', async () => {
    const { created } = await bootstrapMemoryTree({
      workspaceRoot,
      composedIdentity: 'identity',
    });
    expect(created).toContain(mapFile());

    const raw = await readFile(join(workspaceRoot, mapFile()), 'utf8');
    const { fm, body } = splitFrontmatter(raw);
    expect(fm['id']).toBe('map');
    expect(fm['type']).toBe('system/map');
    expect(fm['pinned']).toBe(true);
    expect(body).toContain('# Memory Map');
    expect(body).toContain('_No memory yet._');
  });

  it('TASK-190: map seed is idempotent — a later consolidated map is not clobbered', async () => {
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: 'identity' });
    // Simulate a consolidation having rewritten the map with real content.
    const { writeFile } = await import('node:fs/promises');
    const populated = '---\nid: map\ntype: system/map\n---\n# Memory Map\n\n## entity/\n- x: real content\n';
    await writeFile(join(workspaceRoot, mapFile()), populated, 'utf8');

    // A re-bootstrap (fires on every chat:start) must NOT overwrite it.
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: 'identity' });
    const after = await readFile(join(workspaceRoot, mapFile()), 'utf8');
    expect(after).toBe(populated);
  });

  it('serializes concurrent bootstraps without corrupting agent.md', async () => {
    // Regression: a stat-then-write fileExists guard let two concurrent
    // callers both pass the check and race on the write, producing a file
    // whose content was a torn mix or whose mtime jumped backwards. The
    // fix is `writeFile(..., { flag: 'wx' })` — exactly one writer wins.
    // Each parallel call uses a distinct prompt; the file must end up
    // containing exactly one of them, never a mixture.
    //
    // Prompts must NOT be substrings of each other: e.g. "prompt-1" is a
    // substring of "prompt-17", which would cause `raw.includes("prompt-1")`
    // to fire spuriously when "prompt-17" won the race. Use 2-digit
    // zero-padded suffixes so every prompt is a distinct fixed-width token.
    const prompts = Array.from({ length: 20 }, (_, i) => `prompt-${String(i).padStart(2, '0')}`);
    const results = await Promise.allSettled(
      prompts.map((p) =>
        bootstrapMemoryTree({ workspaceRoot, composedIdentity: p }),
      ),
    );

    // Every call must resolve cleanly — EEXIST is swallowed inside.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    const raw = await readFile(join(workspaceRoot, systemFile('agent')), 'utf8');
    const winners = prompts.filter((p) => raw.includes(p));
    expect(winners).toHaveLength(1);
  });

  it('TASK-204: threads nowFn through so seed frontmatter stamps replay-time, not wall-clock', async () => {
    // Bench temporal-fidelity seam: an e2e replay of a corpus whose fiction
    // happened on a fixed historical date must stamp the seed files with that
    // date, not `new Date()`. Without the seam these admin/system files carry
    // wall-clock dates that are fiction-vs-reality in the replay. Production
    // omits nowFn, so this defaults to `() => new Date()` and is a no-op there.
    const fixed = '2023-05-20T00:00:00.000Z';
    await bootstrapMemoryTree({
      workspaceRoot,
      composedIdentity: 'identity',
      nowFn: () => new Date(fixed),
    });

    for (const name of ['agent', 'user', 'session'] as const) {
      const raw = await readFile(join(workspaceRoot, systemFile(name)), 'utf8');
      const { fm } = splitFrontmatter(raw);
      expect(fm['created']).toBe(fixed);
      expect(fm['event_time']).toBe(fixed);
      expect(fm['recorded_at']).toBe(fixed);
    }

    const mapRaw = await readFile(join(workspaceRoot, mapFile()), 'utf8');
    const { fm: mapFm } = splitFrontmatter(mapRaw);
    expect(mapFm['created']).toBe(fixed);
    expect(mapFm['event_time']).toBe(fixed);
    expect(mapFm['recorded_at']).toBe(fixed);
  });

  it('isolates per agent inside the same workspace root', async () => {
    const second = join(workspaceRoot, 'second-agent-workspace');
    await bootstrapMemoryTree({
      workspaceRoot,
      composedIdentity: 'agent A',
    });
    await bootstrapMemoryTree({
      workspaceRoot: second,
      composedIdentity: 'agent B',
    });

    const a = await readFile(join(workspaceRoot, systemFile('agent')), 'utf8');
    const b = await readFile(join(second, systemFile('agent')), 'utf8');
    expect(a).toContain('agent A');
    expect(b).toContain('agent B');
  });
});

describe('paths', () => {
  it('workspaceMemoryRoot returns "permanent/memory" with no leading slash', () => {
    const p = workspaceMemoryRoot();
    expect(p.startsWith('/')).toBe(false);
    expect(p).toBe(MEMORY_ROOT);
    expect(p).toBe('permanent/memory');
  });

  it('systemFile builds the correct relative path for each fixed name', () => {
    expect(systemFile('agent')).toBe('permanent/memory/system/agent.md');
    expect(systemFile('user')).toBe('permanent/memory/system/user.md');
    expect(systemFile('session')).toBe('permanent/memory/system/session.md');
  });
});

describe('BOOTSTRAP_SEED_FILES drift guard (TASK-513)', () => {
  it('equals exactly the set of files bootstrapMemoryTree creates on an empty root', async () => {
    // Dynamic import so this one test (not the whole file) goes red if the
    // export is missing. chat:start hydrates ONLY these paths from the tier,
    // so a seed file bootstrap creates but this list omits would be re-created
    // (and overwritten) on every turn.
    const mod = (await import('../bootstrap.js')) as { BOOTSTRAP_SEED_FILES?: readonly string[] };
    const { created } = await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '' });
    expect(mod.BOOTSTRAP_SEED_FILES).toBeDefined();
    expect([...(mod.BOOTSTRAP_SEED_FILES ?? [])].sort()).toEqual([...created].sort());
    expect(created.length).toBe(4);
  });
});

// TASK-556: an agent.md seeded with the placeholder (a still-bootstrapping
// agent, or one poisoned by a pre-TASK-553 read blip) is repaired once a real
// identity is composed. Anything else in agent.md is the agent's and is kept.
describe('placeholder agent.md repair (TASK-556)', () => {
  const agentPath = (): string => join(workspaceRoot, systemFile('agent'));

  it('rewrites a placeholder agent.md when a real identity is composed, and reports it', async () => {
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '' });
    expect(await readFile(agentPath(), 'utf8')).toContain('has not authored its identity');

    const out = await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '## Identity\n\nI am Atlas.' });

    const raw = await readFile(agentPath(), 'utf8');
    expect(raw).toContain('I am Atlas.');
    expect(raw).not.toContain('has not authored its identity');
    expect(splitFrontmatter(raw).fm['type']).toBe('system/agent');
    expect(out.created).toEqual([]);
    expect(out.repaired).toEqual([systemFile('agent')]);
    // The atomic replace leaves no temp file beside it.
    expect((await readdir(join(workspaceRoot, MEMORY_ROOT, 'system'))).sort()).toEqual([
      'agent.md',
      'map.md',
      'session.md',
      'user.md',
    ]);
  });

  it('leaves a placeholder alone while the composed identity is still empty', async () => {
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '' });
    const before = await readFile(agentPath(), 'utf8');

    const out = await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '   ' });

    expect(await readFile(agentPath(), 'utf8')).toBe(before);
    expect(out.repaired).toEqual([]);
  });

  it('never rewrites an agent.md that holds anything but the exact placeholder', async () => {
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '' });
    const edited = (await readFile(agentPath(), 'utf8')).replace(
      '_The agent has not authored its identity yet._',
      '_The agent has not authored its identity yet._\n\nNote to self: I like tea.',
    );
    await writeFile(agentPath(), edited, 'utf8');

    const out = await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '## Identity\n\nI am Atlas.' });

    expect(await readFile(agentPath(), 'utf8')).toBe(edited);
    expect(out.repaired).toEqual([]);
  });

  it('a symlinked agent.md is not the placeholder: neither it nor its target is written', async () => {
    await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '' });
    const target = join(workspaceRoot, 'outside.md');
    await writeFile(target, await readFile(agentPath(), 'utf8'), 'utf8');
    const targetBefore = await readFile(target, 'utf8');
    await rm(agentPath());
    await symlink(target, agentPath());

    const out = await bootstrapMemoryTree({ workspaceRoot, composedIdentity: '## Identity\n\nI am Atlas.' });

    expect(out.repaired).toEqual([]);
    expect(await readFile(target, 'utf8')).toBe(targetBefore);
    expect((await lstat(agentPath())).isSymbolicLink()).toBe(true);
  });
});

// TASK-560: the two local "read a file only if it is really there" helpers
// (`readRegularFile` for agent.md, `readAxFile` for .ax/IDENTITY.md + SOUL.md)
// agree on what "absent" means: ENOENT, or ENOTDIR (a path component is a
// regular file, so the path cannot exist). Anything else throws in both.
describe('ENOTDIR is "absent" in both local readers (TASK-560)', () => {
  it('readRegularFile: a path beneath a regular file reads as absent, not a throw', async () => {
    await writeFile(join(workspaceRoot, 'not-a-dir'), 'x', 'utf8');

    await expect(readRegularFile(join(workspaceRoot, 'not-a-dir', 'agent.md'))).resolves.toBeUndefined();
  });

  it('readRegularFile: a plainly missing path is absent too', async () => {
    await expect(readRegularFile(join(workspaceRoot, 'nope', 'agent.md'))).resolves.toBeUndefined();
  });

  it('composeIdentityFromFiles: a regular file where .ax/ should be is no identity', async () => {
    await mkdir(join(workspaceRoot, 'permanent'), { recursive: true });
    await writeFile(join(workspaceRoot, 'permanent', '.ax'), 'x', 'utf8');

    await expect(composeIdentityFromFiles(workspaceRoot)).resolves.toBe('');
  });

  it('bootstrap over that corrupt tree still fails closed: it rejects and leaves the file alone', async () => {
    // Reading agent.md as absent only moves the failure one step later — the
    // seed's own mkdir cannot create system/ where a file stands.
    const systemDir = join(workspaceRoot, MEMORY_ROOT, 'system');
    await mkdir(join(workspaceRoot, MEMORY_ROOT), { recursive: true });
    await writeFile(systemDir, 'not a dir', 'utf8');

    await expect(
      bootstrapMemoryTree({ workspaceRoot, composedIdentity: '## Identity\n\nI am Atlas.' }),
    ).rejects.toThrow();
    expect(await readFile(systemDir, 'utf8')).toBe('not a dir');
  });
});
