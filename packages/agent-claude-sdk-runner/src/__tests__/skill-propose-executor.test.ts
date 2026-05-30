import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSkillProposeExecutor } from '../skill-propose-executor.js';
import type { ToolCall } from '@ax/ipc-protocol';

let ephemeralRoot: string;

beforeEach(async () => {
  ephemeralRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-skill-propose-'));
});

afterEach(async () => {
  await fs.rm(ephemeralRoot, { recursive: true, force: true });
});

async function writeDraft(id: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(ephemeralRoot, 'skill-draft', id);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
}

function call(p: string): ToolCall {
  return { id: 't1', name: 'skill_propose', input: { path: p } };
}

const SKILL_MD = '---\nname: commit-style\ndescription: how we write commits\nversion: 1\n---\n# Commit style\nUse imperative mood.\n';

describe('createSkillProposeExecutor', () => {
  it('reads the draft, splits SKILL.md, ships skill.propose, returns the verdict', async () => {
    await writeDraft('commit-style', {
      'SKILL.md': SKILL_MD,
      'scripts/helper.py': 'print("hi")\n',
    });
    const calls: Array<{ action: string; payload: unknown }> = [];
    const exec = createSkillProposeExecutor({
      ephemeralRoot,
      client: {
        call: async (action: string, payload: unknown) => {
          calls.push({ action, payload });
          return { skillId: 'commit-style', status: 'active' };
        },
      } as never,
    });

    const out = await exec(call('/ephemeral/skill-draft/commit-style'));
    expect(out).toEqual({ skillId: 'commit-style', status: 'active' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.action).toBe('skill.propose');
    const p = calls[0]!.payload as {
      manifestYaml: string;
      bodyMd: string;
      files: Array<{ path: string; contents: string }>;
      origin: string;
    };
    expect(p.origin).toBe('authored');
    expect(p.manifestYaml).toContain('name: commit-style');
    expect(p.bodyMd).toContain('imperative mood');
    expect(p.files).toEqual([{ path: 'scripts/helper.py', contents: 'print("hi")\n' }]);
  });

  it('rejects a path outside /ephemeral/skill-draft/', async () => {
    const exec = createSkillProposeExecutor({ ephemeralRoot });
    await expect(exec(call('/ephemeral/artifacts/x'))).rejects.toThrow(/skill-draft-path-not-allowed/);
  });

  it('rejects a missing SKILL.md', async () => {
    await writeDraft('linear', { 'notes.md': 'x' });
    const exec = createSkillProposeExecutor({ ephemeralRoot });
    await expect(exec(call('/ephemeral/skill-draft/linear'))).rejects.toThrow(/SKILL\.md not found/);
  });

  it('rejects a SKILL.md without a frontmatter fence', async () => {
    await writeDraft('linear', { 'SKILL.md': '# no frontmatter\n' });
    const exec = createSkillProposeExecutor({ ephemeralRoot, client: { call: async () => ({}) } as never });
    await expect(exec(call('/ephemeral/skill-draft/linear'))).rejects.toThrow(/frontmatter fence/);
  });

  it('rejects when the ephemeral tier is not wired', async () => {
    const exec = createSkillProposeExecutor({});
    await expect(exec(call('/ephemeral/skill-draft/linear'))).rejects.toThrow(/ephemeral tier/);
  });

  it('rejects a reserved extra-file path (.mcp.json is generated)', async () => {
    await writeDraft('linear', { 'SKILL.md': SKILL_MD, '.mcp.json': '{}' });
    const exec = createSkillProposeExecutor({ ephemeralRoot, client: { call: async () => ({}) } as never });
    await expect(exec(call('/ephemeral/skill-draft/linear'))).rejects.toThrow(/reserved bundle path/);
  });

  it('rejects a symlink in the bundle', async () => {
    await writeDraft('linear', { 'SKILL.md': SKILL_MD });
    await fs.symlink('/etc/passwd', path.join(ephemeralRoot, 'skill-draft', 'linear', 'leak.txt'));
    const exec = createSkillProposeExecutor({ ephemeralRoot, client: { call: async () => ({}) } as never });
    await expect(exec(call('/ephemeral/skill-draft/linear'))).rejects.toThrow(/symlink/);
  });
});
