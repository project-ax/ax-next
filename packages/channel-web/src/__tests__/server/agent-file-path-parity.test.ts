// @vitest-environment node
/**
 * The `agent_file` key rule and the download route's path rule must agree
 * (TASK-1012).
 *
 * A runner attaches a file it created by its key in the agent's files
 * (`isAgentFilePath`, in the browser-safe `@ax/ipc-protocol`). The chip
 * downloads it through a route that validates the splat with
 * `workspaceFilePath`, which needs `node:path` and so cannot live in the
 * protocol package. If the two drift, a looser protocol rule mints chips the
 * route always refuses (`notes: q3.md`), and a stricter one turns files the
 * Files tab can serve into text notes. The client encodes the whole key once
 * with `encodeURIComponent`, so that is the input the route sees.
 *
 * Two protocol rules have no route counterpart and are not in these tables:
 * the 4096-unit key limit, and refusing a lone surrogate (which
 * `encodeURIComponent` throws on). `@ax/ipc-protocol`'s own tests pin both.
 */
import { describe, expect, it } from 'vitest';
import { isAgentFilePath } from '@ax/ipc-protocol';
import { workspaceFilePath } from '../../server/safe-path.js';

/** What the route answers for the URL a chip would build for `key`. */
function routeServes(key: string): boolean {
  return workspaceFilePath(encodeURIComponent(key)) === key;
}

/** `[test label, key]`, so a 256-unit name does not become the test title. */
function rows(keys: readonly string[]): Array<[string, string]> {
  return keys.map((key) => [key.length > 40 ? `a ${key.length}-unit name` : JSON.stringify(key), key]);
}

const SERVED = [
  'docs/report.pdf',
  '.gitignore',
  'reports/Q3 plan #1 (50%).pdf',
  'a b/c d.txt',
  'ünï/cødé.md',
  'x‮y.pdf',
  '📊 chart.png',
  's'.repeat(255),
];

const REFUSED = [
  '',
  '/etc/passwd',
  '../x',
  'a/../b',
  'a//b',
  'a/',
  './a',
  'a/./b',
  'a\\b',
  'a:b',
  'a..b',
  'a\u0000b',
  ' a',
  'a.',
  'a ',
  's'.repeat(256),
  // The names the plan's review calls out: each would be a chip that always fails.
  'notes: q3.md',
  'a..b.txt',
  'file.',
  // JavaScript's `\s` covers Unicode spaces too, on both sides: a no-break
  // space leads, an ideographic space trails.
  ' a',
  'a　',
];

describe('isAgentFilePath agrees with workspaceFilePath', () => {
  it.each(rows(SERVED))('both accept %s', (_label, key) => {
    expect(routeServes(key)).toBe(true);
    expect(isAgentFilePath(key)).toBe(true);
  });

  it.each(rows(REFUSED))('both refuse %s', (_label, key) => {
    expect(routeServes(key)).toBe(false);
    expect(isAgentFilePath(key)).toBe(false);
  });

  it('agrees on every short key built from the characters the rules care about', () => {
    // A seeded generator (Park–Miller), so a failure names a key that
    // reproduces. Each element is a whole code point, so no key has a lone
    // surrogate; lengths stay far under the 4096-unit protocol limit.
    let seed = 1012;
    const random = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const alphabet = ['a', 'Z', '.', '/', ' ', '\t', '\n', ' ', '　', '\\', ':', '\u0000', '#', '%', 'ü', '‮', '📊'];
    let served = 0;
    for (let i = 0; i < 5000; i += 1) {
      const length = Math.floor(random() * 9);
      let key = '';
      for (let j = 0; j < length; j += 1) key += alphabet[Math.floor(random() * alphabet.length)];
      const expected = routeServes(key);
      if (expected) served += 1;
      expect(isAgentFilePath(key), JSON.stringify(key)).toBe(expected);
    }
    // Not a vacuous agreement: the generator reached both answers.
    expect(served).toBeGreaterThan(100);
    expect(served).toBeLessThan(4900);
  });
});
