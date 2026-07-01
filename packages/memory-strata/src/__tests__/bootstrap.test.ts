import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { bootstrapMemoryTree } from '../bootstrap.js';
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
