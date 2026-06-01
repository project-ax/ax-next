import { it, expect, describe } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSkillMd, parseSkillManifest } from '@ax/skills-parser';
import { loadBuiltinSkills } from '../builtin-skills/index.js';

// Every builtin is pure know-how — it declares NO capabilities (TASK-100 removed
// the skill capability block; the reach it teaches is a connector the user
// approves, never granted by the builtin itself) + no helper files. Parametrized
// so a new builtin gets the same contract for free.
describe.each([['ax-skill-creator'], ['ax-connector-creator']])(
  'builtin skill %s',
  (id) => {
    it('loads cap-free, with no files, and surfaces its connectors[]', () => {
      const skills = loadBuiltinSkills();
      const s = skills.find((x) => x.id === id);
      expect(s).toBeDefined();
      // TASK-100 — the loader no longer carries a capabilities field at all.
      expect('capabilities' in s!).toBe(false);
      expect(s!.files).toEqual([]);
      expect(s!.bodyMd.length).toBeGreaterThan(0);
      // The loader surfaces the manifest's connectors[] (the shipped builtins
      // reference none, so []). The field must be present (not dropped) so a
      // builtin that ever references a connector folds its reach via the
      // skill→connector bridge.
      expect(s!.connectors).toEqual([]);
    });
  },
);

// Invariant #4 guard (TASK-100): NO shipped builtin skill manifest may carry a
// `capabilities` block — the parser hard-rejects one, so a stray block would fail
// to load at boot. This walks every builtin SKILL.md and asserts its frontmatter
// parses cleanly (which can only happen when it is cap-free).
describe('invariant #4 — no builtin skill manifest carries a capabilities block', () => {
  const dir = fileURLToPath(new URL('../builtin-skills/', import.meta.url));
  const builtinIds = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it.each(builtinIds.map((id) => [id]))('%s/SKILL.md parses cap-free', (id) => {
    const md = readFileSync(fileURLToPath(new URL(`../builtin-skills/${id}/SKILL.md`, import.meta.url)), 'utf8');
    const split = splitSkillMd(md);
    expect(split).not.toBeNull();
    if (split === null) return;
    const parsed = parseSkillManifest(split.manifestYaml);
    // A capabilities block would make this `capability-block-forbidden`.
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('capabilities' in parsed.value).toBe(false);
  });
});

it('loads BOTH builtins (ax-skill-creator + ax-connector-creator)', () => {
  const ids = loadBuiltinSkills().map((s) => s.id);
  expect(ids).toEqual(expect.arrayContaining(['ax-skill-creator', 'ax-connector-creator']));
});

it('ax-connector-creator drives the connector_propose authoring loop', () => {
  const s = loadBuiltinSkills().find((x) => x.id === 'ax-connector-creator');
  expect(s).toBeDefined();
  // The builtin must point the agent at the real model-facing tool (TASK-95),
  // not a host-only hook name — a SKILL.md naming a non-existent tool is a
  // half-wired skill (invariant #3).
  expect(s!.bodyMd).toContain('connector_propose');
});

it('ax-skill-creator is narrowed to know-how: no capabilities block, uses skill_propose + connectors[]', () => {
  const s = loadBuiltinSkills().find((x) => x.id === 'ax-skill-creator');
  expect(s).toBeDefined();
  const body = s!.bodyMd;
  // Narrowed to the LIVE authoring tool (skill_propose), not the deleted
  // install_authored_skill.
  expect(body).toContain('skill_propose');
  expect(body).not.toContain('install_authored_skill');
  // References connectors instead of authoring capability blocks.
  expect(body).toContain('connectors');
  expect(body).toContain('ax-connector-creator');
});
