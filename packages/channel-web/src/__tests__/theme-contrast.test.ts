/**
 * Every accent pair in both themes, measured against the WCAG AA floor.
 *
 * A browser walk found two buttons below it: "Just this once" on the permission
 * card at 3.75:1 and "Turn it off anyway" on the sign-in lockout dialog at
 * 3.40:1 — the two most consequential buttons in the product. Both were white
 * text on an accent that dark mode had deliberately LIGHTENED (primary 44% ->
 * 52%, destructive 55% -> 62%), which moves the accent toward white and
 * squeezes the text on top of it.
 *
 * A screenshot will not tell you that, and neither will a reviewer — 3.4:1 red
 * with white text looks fine until you measure it. So this measures, the same
 * way the walk did.
 *
 * Two directions matter and they pull against each other, which is the whole
 * reason the bug was subtle:
 *
 *   - `bg-primary` / `bg-destructive` with their `*-foreground` on top. Wants a
 *     DARK accent (or a dark foreground).
 *   - `text-primary` / `text-destructive` on the page background, which is how
 *     `--destructive` is used 37 times. Wants a BRIGHT accent in dark mode.
 *
 * Satisfying one by moving the accent breaks the other. Hence the split fix:
 * dark mode pairs its bright accents with a near-black foreground (which
 * `--warning-foreground` had been doing all along), and light mode darkens
 * `--destructive` because there that single move lifts both roles at once.
 *
 * This test reads the real stylesheet rather than a copy of the numbers, so it
 * fails on any future token edit that drops a pair below the floor.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

/** WCAG 2.1 AA for normal-sized text. Every string measured here is body copy or a button label. */
const AA_NORMAL = 4.5;

/**
 * Pull one `{ ... }` block's custom properties, starting from a selector.
 * Brace-matched rather than regex'd to the closing brace, because the dark
 * block nests an `@media` inside it.
 */
function tokensAfter(selector: string): Map<string, string> {
  const at = CSS.indexOf(selector);
  if (at === -1) throw new Error(`selector not found in index.css: ${selector}`);
  let i = CSS.indexOf('{', at);
  let depth = 0;
  const start = i;
  for (; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) break;
  }
  const body = CSS.slice(start, i);
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** `"211 100% 52%"` (the bare triple Tailwind wraps in `hsl()`) -> sRGB 0-255. */
function hslTripleToRgb(triple: string): [number, number, number] {
  const m = triple.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) throw new Error(`not an hsl triple: ${triple}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const mm = l - c / 2;
  return [
    Math.round((r1 + mm) * 255),
    Math.round((g1 + mm) * 255),
    Math.round((b1 + mm) * 255),
  ];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: string, b: string): number {
  const la = luminance(hslTripleToRgb(a));
  const lb = luminance(hslTripleToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: ReadonlyArray<readonly [string, string]> = [
  ['light', ':root {'],
  // Both dark blocks must agree; they are the system fallback and the explicit
  // toggle. Checking each separately also catches the two drifting apart.
  ['dark (system fallback)', ":root[data-theme='dark'],"],
  ['dark (explicit toggle)', ":root[data-theme='dark'] {"],
];

/** Accent backgrounds and the foreground each one is always paired with. */
const ACCENT_PAIRS = [
  ['--primary', '--primary-foreground'],
  ['--destructive', '--destructive-foreground'],
  ['--warning', '--warning-foreground'],
] as const;

/** Accents that are ALSO used as text directly on the page background. */
const ACCENTS_USED_AS_TEXT = ['--primary', '--destructive', '--warning'] as const;

describe('theme contrast', () => {
  for (const [name, selector] of THEMES) {
    describe(name, () => {
      const tokens = tokensAfter(selector);

      for (const [bg, fg] of ACCENT_PAIRS) {
        it(`${fg} on ${bg} clears AA`, () => {
          const bgv = tokens.get(bg);
          const fgv = tokens.get(fg);
          expect(bgv, `${bg} missing from ${selector}`).toBeDefined();
          expect(fgv, `${fg} missing from ${selector}`).toBeDefined();
          expect(contrast(bgv!, fgv!)).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }

      for (const accent of ACCENTS_USED_AS_TEXT) {
        it(`${accent} as text on --background clears AA`, () => {
          const accentV = tokens.get(accent);
          const bgV = tokens.get('--background');
          expect(accentV, `${accent} missing from ${selector}`).toBeDefined();
          expect(bgV, `--background missing from ${selector}`).toBeDefined();
          expect(contrast(accentV!, bgV!)).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    });
  }

  /**
   * Guards the conversion itself. If `hslTripleToRgb` ever went wrong, every
   * assertion above could pass on nonsense, so pin two known values: white on
   * black is the theoretical maximum, and a colour against itself is 1:1.
   */
  it('measures known values correctly', () => {
    expect(contrast('0 0% 100%', '0 0% 0%')).toBeCloseTo(21, 1);
    expect(contrast('211 100% 52%', '211 100% 52%')).toBeCloseTo(1, 5);
  });
});
