import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * This package's sources spell invisible and bidi characters as escapes
 * (backslash, `u`, four hex digits), never as the characters themselves. Its
 * tests feed exactly those characters to the cleaners (a team name, an
 * admin's name, a sender label), and a literal one is invisible in an editor
 * and in review: a right-to-left override can make the code on screen read
 * differently from the code that runs. The escape is the same value at
 * runtime and can't hide anything.
 *
 * The ranges are the Arabic letter mark (U+061C, a direction mark like
 * U+200E/U+200F), the zero-width and direction marks (U+200B-U+200F), the bidi
 * embeddings and overrides (U+202A-U+202E), the word joiner, invisible
 * operators and the bidi isolates (U+2060-U+2069), and the byte-order mark.
 */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('channel-slack source hygiene', () => {
  it('reads every source file under src/, tests included (the scan is not vacuous)', () => {
    const files = sourceFiles(SRC).map((f) => relative(SRC, f));
    expect(files).toContain('router.ts');
    expect(files).toContain('__tests__/admin-routes.test.ts');
    expect(files).toContain('__tests__/source-hygiene.test.ts');
  });

  it('no source spells an invisible or bidi character literally: each is an escape', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const found = INVISIBLE.exec(line);
          if (found !== null) {
            const code = found[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
            offenders.push(`${relative(SRC, file)}:${i + 1} U+${code}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern itself matches each range, so a clean result means something', () => {
    for (const code of [0x061c, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff]) {
      expect(INVISIBLE.test(String.fromCodePoint(code)), code.toString(16)).toBe(true);
    }
    for (const code of [0x061b, 0x061d, 0x200a, 0x2010, 0x2029, 0x205f, 0x206a, 0xfffd]) {
      expect(INVISIBLE.test(String.fromCodePoint(code)), code.toString(16)).toBe(false);
    }
  });
});
