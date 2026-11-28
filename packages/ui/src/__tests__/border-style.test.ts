import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Preflight is off in this package, so border-style stays `none`: a border width class draws nothing unless the same
// element also says ax-border-solid (or -dashed). Divider pairs them; this keeps every other component honest.
const src = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p);
    return /\.tsx?$/.test(p) && !p.endsWith('.stories.tsx') ? [p] : [];
  });
}

const WIDTH = /(^|\s)(?:[a-z-]+:)*ax-border(?:-[tblrxyse])?(?=\s|$)/;
const STYLE = /(^|\s)ax-border-(?:solid|dashed|dotted)(?=\s|$)/;

// Joins `'a ' + 'b'` so a class string split across lines is judged as one string.
export function offenders(text: string): string[] {
  const joined = text.replace(/(['"`])\s*\+\s*\n?\s*\1/g, '');
  return (joined.match(/(['"`])(?:(?!\1).)*\1/g) ?? []).map((l) => l.slice(1, -1)).filter((s) => WIDTH.test(s) && !STYLE.test(s));
}

describe('border width classes carry a border style', () => {
  it('bites on a scratch case', () => {
    expect(offenders(`const a = 'ax-p-md ax-border-t ax-border-line-soft';`)).toHaveLength(1);
    expect(offenders(`const a = 'ax-border ' + 'ax-border-solid';`)).toHaveLength(0);
    expect(offenders(`const a = 'ax-border-transparent ax-border-0 ax-border-line-border';`)).toHaveLength(0);
    expect(offenders(`const a = 'ax-border-t ax-border-solid';`)).toHaveLength(0);
  });
  for (const file of walk(src)) {
    it(file.slice(src.length), () => expect(offenders(readFileSync(file, 'utf8'))).toEqual([]));
  }
});
