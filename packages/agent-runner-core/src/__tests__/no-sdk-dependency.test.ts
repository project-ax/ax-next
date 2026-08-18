import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname;

const SOURCE_EXTENSIONS = ['.ts', '.js', '.cjs', '.mjs'];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

describe('@ax/agent-runner-core', () => {
  it('never imports the Claude Agent SDK', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const body = await readFile(file, 'utf8');
      // Match real import/require sites, not prose. src/index.ts documents
      // this very rule in a comment, so a substring match self-trips.
      if (/(from|require\()\s*['"]@anthropic-ai\/claude-agent-sdk/.test(body)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not declare the SDK as a dependency', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain(
      '@anthropic-ai/claude-agent-sdk',
    );
  });
});
