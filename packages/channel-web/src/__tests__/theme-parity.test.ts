import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The legacy shadcn variable names (--background, --primary, ...) are now
// aliases onto the @project-ax/ui --ax-* variables. This test proves every
// alias still resolves to exactly the value channel-web shipped before.

const here = import.meta.dirname;
const indexCss = readFileSync(resolve(here, '../index.css'), 'utf8');
const themeCss = readFileSync(resolve(here, '../../../ui/theme.css'), 'utf8');

interface Fixture {
  light: Record<string, string>;
  dark: Record<string, string>;
  // Deliberate, contrast-forced differences: { theme: { '--var': { old, new } } }
  changed: Partial<Record<'light' | 'dark', Record<string, { old: string; new: string }>>>;
}
const fixture = JSON.parse(readFileSync(resolve(here, 'theme-parity.fixture.json'), 'utf8')) as Fixture;

const ALIAS = /(--[\w-]+):\s*var\((--ax-[\w-]+)\);/g;
const aliases = new Map<string, string>();
for (const m of indexCss.matchAll(ALIAS)) aliases.set(m[1]!, m[2]!);

/** Declarations of the first block that starts with `selector {`. */
function block(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const end = css.indexOf('\n}', start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const light = block(themeCss, ':root');
const dark = { ...light, ...block(themeCss, ":root[data-theme='dark']") };

// 0.5625rem and 9px are the same radius at the fixed 16px root font size.
const norm = (v: string): string =>
  v.replace(/(-?[\d.]+)rem/g, (_, n: string) => `${Number(n) * 16}px`);

describe('theme parity', () => {
  it('every legacy var is aliased', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const name of Object.keys(fixture[theme])) {
        expect(aliases.has(name), `${name} missing from alias block`).toBe(true);
      }
    }
  });

  it('aliases keep triplet format', () => {
    expect(aliases.size).toBeGreaterThan(0);
    for (const [name, target] of aliases) {
      expect(target.startsWith('--ax-'), name).toBe(true);
    }
    // No alias may wrap its target in hsl(): opacity modifiers need bare triplets.
    for (const line of indexCss.split('\n')) {
      if (/^\s*--[\w-]+:\s*var\(--ax-/.test(line)) expect(line).not.toContain('hsl(');
    }
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('resolved values match the fixture (%s)', (theme, vars) => {
    const allowed = fixture.changed[theme] ?? {};
    for (const [name, expected] of Object.entries(fixture[theme])) {
      const target = aliases.get(name);
      expect(target, name).toBeDefined();
      const actual = vars[target!];
      expect(actual, `${name} -> ${target} is not defined in theme.css`).toBeDefined();
      const change = allowed[name];
      if (change) {
        expect(norm(change.old), name).toBe(norm(expected));
        expect(norm(actual!), name).toBe(norm(change.new));
      } else {
        expect(norm(actual!), `${name} -> ${target}`).toBe(norm(expected));
      }
    }
  });
});
