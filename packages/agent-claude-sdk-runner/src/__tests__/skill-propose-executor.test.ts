import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSkillProposeExecutor } from '../skill-propose-executor.js';
import type { ToolCall } from '@ax/ipc-protocol';

// The draft root is now dynamic (filestore-user-files Phase 3 / TASK-165): drafts
// stage under `<root>/.skill-draft/<id>/` where `root` = AX_USERFILES_ROOT (durable
// mount, surfaced to the executor as `userFilesRoot`) ?? the ephemeral scratch root.
// The dotted subdir is `.skill-draft` regardless of root.
const DRAFT_SUBDIR = '.skill-draft';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-skill-propose-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeDraft(
  baseRoot: string,
  id: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = path.join(baseRoot, DRAFT_SUBDIR, id);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
  return dir;
}

function call(p: string): ToolCall {
  return { id: 't1', name: 'skill_propose', input: { path: p } };
}

const SKILL_MD =
  '---\nname: commit-style\ndescription: how we write commits\nversion: 1\n---\n# Commit style\nUse imperative mood.\n';

// A model-facing draft path under a given root (mirrors what the runner advertises).
const draftPathUnder = (baseRoot: string, id: string): string =>
  `${baseRoot}/${DRAFT_SUBDIR}/${id}`;

describe('createSkillProposeExecutor', () => {
  it('reads the draft, splits SKILL.md, ships skill.propose, returns the verdict (ephemeral root)', async () => {
    await writeDraft(root, 'commit-style', {
      'SKILL.md': SKILL_MD,
      'scripts/helper.py': 'print("hi")\n',
    });
    const calls: Array<{ action: string; payload: unknown }> = [];
    const exec = createSkillProposeExecutor({
      ephemeralRoot: root,
      client: {
        call: async (action: string, payload: unknown) => {
          calls.push({ action, payload });
          return { skillId: 'commit-style', status: 'active' };
        },
      } as never,
    });

    const out = await exec(call(draftPathUnder(root, 'commit-style')));
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

  it('prefers the durable userFilesRoot over the ephemeral root when both are wired', async () => {
    // Stage under the DURABLE root; the path is validated + read there even though
    // an ephemeral root is also configured.
    await writeDraft(root, 'linear', { 'SKILL.md': SKILL_MD });
    const exec = createSkillProposeExecutor({
      ephemeralRoot: '/some/other/ephemeral',
      userFilesRoot: root,
      client: { call: async () => ({ skillId: 'linear', status: 'active' }) } as never,
    });
    const out = await exec(call(draftPathUnder(root, 'linear')));
    expect(out).toEqual({ skillId: 'linear', status: 'active' });
  });

  it('rejects a path outside the active <root>/.skill-draft/ prefix', async () => {
    const exec = createSkillProposeExecutor({ ephemeralRoot: root });
    await expect(exec(call(`${root}/artifacts/x`))).rejects.toThrow(
      /skill-draft-path-not-allowed/,
    );
  });

  it('rejects a missing SKILL.md', async () => {
    await writeDraft(root, 'linear', { 'notes.md': 'x' });
    const exec = createSkillProposeExecutor({ ephemeralRoot: root });
    await expect(exec(call(draftPathUnder(root, 'linear')))).rejects.toThrow(/SKILL\.md not found/);
  });

  it('rejects a SKILL.md without a frontmatter fence', async () => {
    await writeDraft(root, 'linear', { 'SKILL.md': '# no frontmatter\n' });
    const exec = createSkillProposeExecutor({
      ephemeralRoot: root,
      client: { call: async () => ({}) } as never,
    });
    await expect(exec(call(draftPathUnder(root, 'linear')))).rejects.toThrow(/frontmatter fence/);
  });

  it('rejects when no draft tier (neither durable nor ephemeral) is wired', async () => {
    const exec = createSkillProposeExecutor({});
    await expect(exec(call('/ephemeral/.skill-draft/linear'))).rejects.toThrow(
      /no durable user-files or ephemeral tier|draft tier/i,
    );
  });

  it('rejects a reserved extra-file path (.mcp.json is generated)', async () => {
    await writeDraft(root, 'linear', { 'SKILL.md': SKILL_MD, '.mcp.json': '{}' });
    const exec = createSkillProposeExecutor({
      ephemeralRoot: root,
      client: { call: async () => ({}) } as never,
    });
    await expect(exec(call(draftPathUnder(root, 'linear')))).rejects.toThrow(/reserved bundle path/);
  });

  it('rejects a symlink in the bundle (extra file)', async () => {
    await writeDraft(root, 'linear', { 'SKILL.md': SKILL_MD });
    await fs.symlink('/etc/passwd', path.join(root, DRAFT_SUBDIR, 'linear', 'leak.txt'));
    const exec = createSkillProposeExecutor({
      ephemeralRoot: root,
      client: { call: async () => ({}) } as never,
    });
    await expect(exec(call(draftPathUnder(root, 'linear')))).rejects.toThrow(/symlink/);
  });

  // HR2 (design §7.2): SKILL.md itself, read at the top of the executor, must be
  // lstat-hardened. On a durable shared NFS mount a SKILL.md symlink could point
  // the read at an arbitrary host file (e.g. /etc/passwd) and ship its bytes to
  // the host gate as the proposed manifest — reject it like the extra-file walk.
  it('rejects a SKILL.md that is a symlink (HR2 lstat hardening)', async () => {
    const dir = path.join(root, DRAFT_SUBDIR, 'linear');
    await fs.mkdir(dir, { recursive: true });
    // Point SKILL.md at a real out-of-bundle file; without lstat it would be read.
    const target = path.join(root, 'secret.md');
    await fs.writeFile(target, SKILL_MD);
    await fs.symlink(target, path.join(dir, 'SKILL.md'));
    const exec = createSkillProposeExecutor({
      ephemeralRoot: root,
      client: { call: async () => ({ skillId: 'linear', status: 'active' }) } as never,
    });
    await expect(exec(call(draftPathUnder(root, 'linear')))).rejects.toThrow(/symlink/i);
  });

  // HR3 (design §7.3): on a successful promote (active/pending) the durable draft
  // dir is deleted so abandoned/finished drafts don't accumulate on NFS.
  it('removes the draft dir after a successful promote (active)', async () => {
    const dir = await writeDraft(root, 'commit-style', { 'SKILL.md': SKILL_MD });
    const exec = createSkillProposeExecutor({
      userFilesRoot: root,
      client: { call: async () => ({ skillId: 'commit-style', status: 'active' }) } as never,
    });
    await exec(call(draftPathUnder(root, 'commit-style')));
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the draft dir after a pending promote', async () => {
    const dir = await writeDraft(root, 'commit-style', { 'SKILL.md': SKILL_MD });
    const exec = createSkillProposeExecutor({
      userFilesRoot: root,
      client: { call: async () => ({ skillId: 'commit-style', status: 'pending' }) } as never,
    });
    await exec(call(draftPathUnder(root, 'commit-style')));
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('KEEPS the draft dir on a quarantined verdict (the agent fixes + re-proposes)', async () => {
    const dir = await writeDraft(root, 'commit-style', { 'SKILL.md': SKILL_MD });
    const exec = createSkillProposeExecutor({
      userFilesRoot: root,
      client: {
        call: async () => ({ skillId: 'commit-style', status: 'quarantined', reason: 'nope' }),
      } as never,
    });
    await exec(call(draftPathUnder(root, 'commit-style')));
    // Still present so the agent can edit + re-propose without re-authoring.
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it('does not fail the propose if cleanup races a delete (best-effort)', async () => {
    const dir = await writeDraft(root, 'commit-style', { 'SKILL.md': SKILL_MD });
    const exec = createSkillProposeExecutor({
      userFilesRoot: root,
      client: {
        call: async () => {
          // Remove the dir before the executor's own cleanup runs, so its rm is a
          // racing delete; the verdict must still come back.
          await fs.rm(dir, { recursive: true, force: true });
          return { skillId: 'commit-style', status: 'active' };
        },
      } as never,
    });
    const out = await exec(call(draftPathUnder(root, 'commit-style')));
    expect(out).toEqual({ skillId: 'commit-style', status: 'active' });
  });

  it('does not clean up when there is no host client (validation-only path)', async () => {
    const dir = await writeDraft(root, 'commit-style', { 'SKILL.md': SKILL_MD });
    const exec = createSkillProposeExecutor({ userFilesRoot: root });
    const out = await exec(call(draftPathUnder(root, 'commit-style')));
    expect(out.status).toBe('pending');
    // No verdict actually shipped, so the draft survives.
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });
});
