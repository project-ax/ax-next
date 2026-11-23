import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProjectedSkillNames, skillRefusal } from '../projected-skills.js';

// TASK-1207: the claude-sdk runner lets the model invoke a skill only when AX
// installed it, i.e. when it is a folder in the projection under
// $CLAUDE_CONFIG_DIR/skills/. The CLI's bundled skills (update-config, simplify,
// init, …) are refused at the PreToolUse gate, so these two functions are the
// whole allowlist: the reader builds it once at boot, and the refusal decides
// per call and writes the sentence the model and the transcript see.

let tmp: string;
let cfg: string;
let skillsDir: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-t1207-'));
  cfg = path.join(tmp, 'cfg');
  skillsDir = path.join(cfg, 'skills');
});
afterEach(async () => {
  // The unreadable-dir case drops every permission bit; restore so rm works.
  await fs.chmod(skillsDir, 0o755).catch(() => undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function plantSkill(name: string): Promise<void> {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A projected skill.\n---\nBody.\n`,
  );
}

describe('readProjectedSkillNames', () => {
  it('returns exactly the skill folders: not a stray file, not a symlinked folder', async () => {
    await plantSkill('weekly-report');
    // A connector's usage-note bundle is a projected folder too (the
    // orchestrator's connectorSandboxDirId shape), and it must stay invocable.
    await plantSkill('cx-linear-1a2b3c4d');
    await fs.writeFile(path.join(skillsDir, 'stray.md'), 'not a skill');
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'SKILL.md'), '---\nname: linked\n---\n');
    await fs.symlink(outside, path.join(skillsDir, 'linked'));
    const log = vi.fn();

    const names = await readProjectedSkillNames(cfg, log);

    expect([...names].sort()).toEqual(['cx-linear-1a2b3c4d', 'weekly-report']);
    expect(log).not.toHaveBeenCalled();
  });

  it('a session with no skills/ dir has no skills, and says nothing', async () => {
    await fs.mkdir(cfg, { recursive: true });
    const log = vi.fn();

    const names = await readProjectedSkillNames(cfg, log);

    expect(names.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('no config dir gives no skills and one log line', async () => {
    const log = vi.fn();

    const names = await readProjectedSkillNames(undefined, log);

    expect(names.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a skills/ path that is not a directory gives no skills and one log line, never a throw', async () => {
    await fs.mkdir(cfg, { recursive: true });
    await fs.writeFile(skillsDir, 'not a directory');
    const log = vi.fn();

    const names = await readProjectedSkillNames(cfg, log);

    expect(names.size).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0] as string).toContain('ENOTDIR');
  });

  // Root ignores permission bits, so the chmod below would not make the
  // directory unreadable there; the ENOTDIR case above covers the same branch.
  it.skipIf(process.getuid?.() === 0)(
    'an unreadable skills/ dir gives no skills and one log line, never a throw',
    async () => {
      await plantSkill('weekly-report');
      await fs.chmod(skillsDir, 0o000);
      const log = vi.fn();

      const names = await readProjectedSkillNames(cfg, log);

      expect(names.size).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0] as string).toContain('EACCES');
    },
  );
});

describe('skillRefusal', () => {
  const projected: ReadonlySet<string> = new Set(['weekly-report', 'cx-linear-1a2b3c4d']);

  it('lets an installed skill through, including with whitespace or a leading slash', () => {
    expect(skillRefusal({ skill: 'weekly-report' }, projected)).toBeUndefined();
    expect(skillRefusal({ skill: ' /weekly-report ' }, projected)).toBeUndefined();
    expect(skillRefusal({ skill: '/weekly-report' }, projected)).toBeUndefined();
    expect(skillRefusal({ skill: 'cx-linear-1a2b3c4d', args: 'x' }, projected)).toBeUndefined();
  });

  it('refuses a bundled skill by name and points at routines', () => {
    expect(skillRefusal({ skill: 'update-config' }, projected)).toBe(
      '"update-config" is not one of this agent\'s skills, so it isn\'t available here. ' +
        'Use the skills and tools you were given. To do something on a schedule, create a routine.',
    );
  });

  it('names a slash-command skill without its slash', () => {
    const reason = skillRefusal({ skill: '/init' }, projected);
    expect(reason).toContain('"init" is not one of this agent\'s skills');
  });

  it('strips one leading slash, as the CLI does, not two', () => {
    const reason = skillRefusal({ skill: '//weekly-report' }, projected);
    expect(reason).toBeDefined();
    expect(reason!.startsWith('That skill ')).toBe(true);
  });

  it('refuses a call that names no skill', () => {
    for (const input of [{}, { skill: 42 }, { skill: '' }, { skill: '  ' }, { skill: '/' }, null, undefined, 'weekly-report', ['weekly-report']]) {
      const reason = skillRefusal(input, projected);
      expect(reason, JSON.stringify(input)).toBeDefined();
      expect(reason!.startsWith('That skill is not one of this agent\'s skills'), JSON.stringify(input)).toBe(true);
    }
  });

  // The reason becomes an is_error tool_result, which is persisted and rendered
  // in the web transcript (TASK-239). The skill name is model output, so it is
  // echoed only when it is a plain short name.
  it('never echoes a long or marked-up name into the transcript', () => {
    for (const skill of [
      'x'.repeat(200),
      'evil\n# heading',
      '[click](https://evil.example)',
      '`rm -rf ~`',
      '<img src=x onerror=alert(1)>',
      'two words',
      '-leading-dash',
      'a'.repeat(65),
    ]) {
      const reason = skillRefusal({ skill }, projected);
      expect(reason, skill).toBeDefined();
      expect(reason!.startsWith('That skill '), skill).toBe(true);
      expect(reason, skill).not.toContain(skill);
    }
  });

  it('echoes a plain name up to 64 characters', () => {
    const name = `a${'b'.repeat(62)}:`;
    expect(name).toHaveLength(64);
    expect(skillRefusal({ skill: name }, projected)).toContain(`"${name}"`);
    expect(skillRefusal({ skill: 'plugin:some_skill' }, projected)).toContain('"plugin:some_skill"');
  });

  it('refuses everything when nothing is projected', () => {
    expect(skillRefusal({ skill: 'weekly-report' }, new Set())).toContain('"weekly-report" is not one of this agent\'s skills');
  });
});
