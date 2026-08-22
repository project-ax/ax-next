// @vitest-environment node
/**
 * No workspace component may import a fixture.
 *
 * The whole agent-workspace surface began as a clickable prototype whose every
 * sentence was a string in `mock/workspace.ts`. Those strings were plausible,
 * confident, and wrong — a permission list the agent did not have, a counter
 * nobody was counting, a status line nothing reported. AW-9 through AW-14
 * replaced them one block at a time.
 *
 * This is the wall that keeps them out. It is a real risk rather than a
 * theoretical one: the fastest way to make a rail block "work" in a hurry is to
 * import the shape a test already builds, and on THIS surface a plausible
 * string is a security claim nobody made.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS_DIR = join(import.meta.dirname, '..');

/** Every component file in the workspace surface — not the tests beside them. */
function workspaceComponentSources(): Array<{ file: string; src: string }> {
  return readdirSync(COMPONENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => ({
      file: e.name,
      src: readFileSync(join(COMPONENTS_DIR, e.name), 'utf-8'),
    }));
}

/**
 * Anything that is a bag of made-up strings. `mock/` was the prototype's home;
 * `*-fixture` and `*-seed` are what a test helper is called around here, and a
 * component reaching for one is the exact mistake this guards.
 */
const FIXTURE_IMPORT =
  /\bfrom\s+['"][^'"]*(workspace-seed|\/mock\/|-fixture|__tests__)[^'"]*['"]/;

describe('workspace components', () => {
  it('exist, so a passing empty sweep cannot be mistaken for a passing test', () => {
    const files = workspaceComponentSources();
    expect(files.length).toBeGreaterThan(8);
    expect(files.map((f) => f.file)).toContain('AgentRail.tsx');
  });

  it('import no fixture module', () => {
    const offenders = workspaceComponentSources()
      .filter(({ src }) => FIXTURE_IMPORT.test(src))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('the rail names no tool, host or capability of its own', () => {
    /*
      Every noun on the rail arrives from a hook. A literal naming a specific
      tool, vendor or hostname inside the renderer is a fixture wearing a
      different hat — it renders as a claim about THIS agent while being a
      claim about nothing at all.
    */
    const rail = readFileSync(join(COMPONENTS_DIR, 'AgentRail.tsx'), 'utf-8');
    const body = rail.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(body).not.toMatch(/linear|gmail|slack|api\.[a-z]/i);
    expect(body).not.toMatch(/\b(Bash|WebFetch|web_search|memory_search)\b/);
  });
});
