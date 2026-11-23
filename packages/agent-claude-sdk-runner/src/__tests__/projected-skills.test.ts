import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_COMMAND_NAMES, readProjectedSkills, skillRefusal } from '../projected-skills.js';

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

describe('readProjectedSkills', () => {
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

    const projected = await readProjectedSkills(cfg, log);

    expect([...projected.names].sort()).toEqual(['cx-linear-1a2b3c4d', 'weekly-report']);
    expect(projected.loadError).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('a session with no skills/ dir has no skills, and says nothing', async () => {
    await fs.mkdir(cfg, { recursive: true });
    const log = vi.fn();

    const projected = await readProjectedSkills(cfg, log);

    expect(projected.names.size).toBe(0);
    // No skills is not a failure: a refusal says "not one of this agent's
    // skills", which is true.
    expect(projected.loadError).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('no config dir gives no skills, a load error and one log line', async () => {
    const log = vi.fn();

    const projected = await readProjectedSkills(undefined, log);

    expect(projected.names.size).toBe(0);
    expect(projected.loadError).toBeDefined();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a skills/ path that is not a directory gives no skills, a load error and one log line, never a throw', async () => {
    await fs.mkdir(cfg, { recursive: true });
    await fs.writeFile(skillsDir, 'not a directory');
    const log = vi.fn();

    const projected = await readProjectedSkills(cfg, log);

    expect(projected.names.size).toBe(0);
    expect(projected.loadError).toBe('ENOTDIR');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0] as string).toContain('ENOTDIR');
  });

  // Root ignores permission bits, so the chmod below would not make the
  // directory unreadable there; the ENOTDIR case above covers the same branch.
  it.skipIf(process.getuid?.() === 0)(
    'an unreadable skills/ dir gives no skills, a load error and one log line, never a throw',
    async () => {
      await plantSkill('weekly-report');
      await fs.chmod(skillsDir, 0o000);
      const log = vi.fn();

      const projected = await readProjectedSkills(cfg, log);

      expect(projected.names.size).toBe(0);
      expect(projected.loadError).toBe('EACCES');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0] as string).toContain('EACCES');
    },
  );
});

describe('skillRefusal', () => {
  const projected = { names: new Set(['weekly-report', 'cx-linear-1a2b3c4d']) };

  it('lets an installed skill through, including with whitespace or a leading slash', () => {
    expect(skillRefusal({ skill: 'weekly-report' }, projected)).toBeUndefined();
    expect(skillRefusal({ skill: ' /weekly-report ' }, projected)).toBeUndefined();
    expect(skillRefusal({ skill: '/weekly-report' }, projected)).toBeUndefined();
    expect(skillRefusal({ skill: 'cx-linear-1a2b3c4d', args: 'x' }, projected)).toBeUndefined();
  });

  it('refuses a bundled skill by name', () => {
    expect(skillRefusal({ skill: 'update-config' }, projected)).toBe(
      '"update-config" is not one of this agent\'s skills, so it isn\'t available here. ' +
        'Use the skills and tools you were given.',
    );
  });

  // Only a scheduling skill gets the routine pointer: "To do something on a
  // schedule, create a routine." after a refused `/init` is noise.
  it('points at routines only when the refused skill is a scheduling one', () => {
    for (const skill of ['loop', '/loop', 'schedule', 'cron', 'Loop']) {
      expect(skillRefusal({ skill }, projected), skill).toMatch(
        /Use the skills and tools you were given\. To do something on a schedule, create a routine\.$/,
      );
    }
    for (const skill of ['update-config', 'init', 'simplify', 'feedback-loop', 'x'.repeat(200)]) {
      expect(skillRefusal({ skill }, projected), skill).not.toContain('routine');
    }
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
    expect(skillRefusal({ skill: 'weekly-report' }, { names: new Set() })).toContain('"weekly-report" is not one of this agent\'s skills');
  });

  // Failing closed is right, but "not one of this agent's skills" would be a
  // false sentence when the skills exist and could not be read. The refusal
  // carries the cause instead, for every name, and says nothing about the
  // error itself (no path, no code).
  it('says the skills could not be read when the projection failed to load', () => {
    const broken = { names: new Set<string>(), loadError: 'EACCES' };
    for (const skill of ['weekly-report', 'update-config', 'x'.repeat(200)]) {
      const reason = skillRefusal({ skill }, broken);
      expect(reason, skill).toBeDefined();
      expect(reason, skill).toContain("this agent's skills couldn't be read when the session started");
      expect(reason, skill).not.toContain('not one of this agent');
      expect(reason, skill).not.toContain('EACCES');
    }
    expect(skillRefusal({ skill: 'weekly-report' }, broken)).toBe(
      '"weekly-report" isn\'t available, because this agent\'s skills couldn\'t be read when the ' +
        'session started. Use the tools you were given.',
    );
  });

  // `readProjectedSkills` never returns both today, but the order is the
  // fail-closed rule: a load error refuses even a name the set holds, so a
  // reorder that checks `names` first goes red here.
  it('a load error refuses even a name the set holds', () => {
    const both = { names: new Set(['weekly-report']), loadError: 'EACCES' };
    const reason = skillRefusal({ skill: 'weekly-report' }, both);
    expect(reason).toBeDefined();
    expect(reason).toContain("this agent's skills couldn't be read when the session started");
  });

  // TASK-1217: the CLI resolves a `Skill` name to its own command first, so an
  // AX skill that shares a name with one never runs; the CLI's would run in
  // its place (measured with `simplify`). The name IS a projected folder, so
  // the allowlist alone lets it through. The refusal asks for a rename.
  describe('an AX skill named like a built-in CLI command', () => {
    const shadowed = { names: new Set(['simplify', 'weekly-report']) };
    const RENAME =
      "\"simplify\" can't be opened here, because the agent's toolkit has a built-in command " +
      'with the same name and that would run instead. Ask the person to give the skill a different name.';

    it('is refused with a rename request, however the name is written', () => {
      for (const skill of ['simplify', '/simplify', ' simplify ', ' /simplify ']) {
        expect(skillRefusal({ skill }, shadowed), skill).toBe(RENAME);
      }
    });

    it('is refused for every name the CLI answers to', () => {
      // The full list is pinned against the binary by the DRIFT case in
      // bundled-skills-real-sdk.e2e.test.ts. Here: the loop below is not
      // vacuous, and it covers the names a bundled skill or a local command
      // owns, not just the ones in the model's listing.
      for (const name of ['simplify', 'update-config', 'batch', 'debug', 'clear', 'compact']) {
        expect(CLI_COMMAND_NAMES.has(name), name).toBe(true);
      }
      for (const name of CLI_COMMAND_NAMES) {
        const reason = skillRefusal({ skill: name }, { names: new Set([name]) });
        expect(reason, name).toContain(`"${name}" can't be opened here`);
        expect(reason, name).toContain('give the skill a different name');
      }
    });

    it('leaves a projected skill with any other name alone', () => {
      expect(skillRefusal({ skill: 'weekly-report' }, shadowed)).toBeUndefined();
      expect(skillRefusal({ skill: ' /weekly-report ' }, shadowed)).toBeUndefined();
    });

    it('keeps the plain refusal for a CLI command name AX did not project', () => {
      expect(skillRefusal({ skill: 'update-config' }, shadowed)).toBe(
        '"update-config" is not one of this agent\'s skills, so it isn\'t available here. ' +
          'Use the skills and tools you were given.',
      );
    });

    it('says the skills could not be read before it asks for a rename', () => {
      const reason = skillRefusal({ skill: 'simplify' }, { names: new Set(['simplify']), loadError: 'EACCES' });
      expect(reason).toContain("this agent's skills couldn't be read when the session started");
      expect(reason).not.toContain('different name');
    });
  });
});
