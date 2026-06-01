import { it, expect, describe } from 'vitest';
import { loadBuiltinSkills } from '../builtin-skills/index.js';

// Every builtin is materialized at lowest precedence with ZERO declared
// capabilities + no helper files — it's pure know-how (the reach it teaches is a
// connector/skill the user approves at install, never granted by the builtin
// itself). Parametrized so a new builtin gets the same contract for free.
describe.each([['ax-skill-creator'], ['ax-connector-creator']])(
  'builtin skill %s',
  (id) => {
    it('loads with empty capabilities and no files', () => {
      const skills = loadBuiltinSkills();
      const s = skills.find((x) => x.id === id);
      expect(s).toBeDefined();
      expect(s!.capabilities.allowedHosts).toEqual([]);
      expect(s!.capabilities.credentials).toEqual([]);
      expect(s!.capabilities.mcpServers).toEqual([]);
      expect(s!.capabilities.packages).toEqual({ npm: [], pypi: [] });
      expect(s!.files).toEqual([]);
      expect(s!.bodyMd.length).toBeGreaterThan(0);
    });
  },
);

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
