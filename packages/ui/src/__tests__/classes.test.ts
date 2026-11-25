import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(fileURLToPath(new URL('../../ui.css', import.meta.url)), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p);
    return p.endsWith('.tsx') && !p.endsWith('.stories.tsx') ? [p] : [];
  });
}

const escapeSelector = (cls: string): string => cls.replace(/:/g, '\\:');
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Anchored: `.ax-text-fg` must not be satisfied by `.ax-text-fg-muted`.
const selectorRe = (cls: string): RegExp => new RegExp(escapeRegExp(`.${escapeSelector(cls)}`) + '(?![\\w-])');

describe('component classes are compiled into ui.css', () => {
  const files = walk(src);
  it('finds component sources', () => expect(files.length).toBeGreaterThanOrEqual(6));
  for (const file of files) {
    it(file.slice(src.length), () => {
      const text = readFileSync(file, 'utf8');
      const tokens = new Set<string>();
      for (const lit of text.match(/(['"`])(?:(?!\1).)*\1/g) ?? []) {
        for (const m of lit.match(/\b(?:md|lg):ax-[\w-]+|\bax-[\w:-]+/g) ?? []) tokens.add(m);
      }
      for (const cls of tokens) expect(css, cls).toMatch(selectorRe(cls));
    });
  }
});
