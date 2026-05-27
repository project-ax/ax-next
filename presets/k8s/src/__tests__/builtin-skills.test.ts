import { it, expect } from 'vitest';
import { loadBuiltinSkills } from '../builtin-skills/index.js';

it('loads ax-skill-creator with empty capabilities and no files', () => {
  const skills = loadBuiltinSkills();
  const s = skills.find((x) => x.id === 'ax-skill-creator');
  expect(s).toBeDefined();
  expect(s!.capabilities.allowedHosts).toEqual([]);
  expect(s!.capabilities.credentials).toEqual([]);
  expect(s!.capabilities.mcpServers).toEqual([]);
  expect(s!.capabilities.packages).toEqual({ npm: [], pypi: [] });
  expect(s!.files).toEqual([]);
  expect(s!.bodyMd.length).toBeGreaterThan(0);
});
