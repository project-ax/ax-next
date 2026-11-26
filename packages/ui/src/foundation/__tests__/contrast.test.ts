import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../contrast.js';
import { accent, action, bg, fg, status } from '../tokens.js';

describe('contrastRatio', () => {
  it('black on white is 21, identical is 1', () => {
    expect(Math.abs(contrastRatio('0 0% 0%', '0 0% 100%') - 21)).toBeLessThan(0.01);
    expect(contrastRatio('220 40% 50%', '220 40% 50%')).toBeCloseTo(1, 5);
  });
});

const themes = ['light', 'dark'] as const;
const surfaces = ['canvas', 'surface', 'surface-raised', 'overlay', 'muted'] as const;

describe.each(themes)('contrast (%s)', (t) => {
  const check = (name: string, a: string, b: string, min: number) => {
    const r = contrastRatio(a, b);
    expect(r, `${name}: ${a} on ${b} = ${r.toFixed(2)} (< ${min})`).toBeGreaterThanOrEqual(min);
  };

  it('text on surfaces', () => {
    for (const s of surfaces) {
      for (const k of ['default', 'muted', 'link'] as const) check(`fg.${k} on bg.${s}`, fg[t][k], bg[t][s], 4.5);
      check(`fg.subtle on bg.${s}`, fg[t].subtle, bg[t][s], 3.0);
    }
  });

  it('inverse on action, accent fg on accent', () => {
    check('fg.inverse on action.base', fg[t].inverse, action[t].base, 4.5);
    check('accent.fg on accent.base', accent[t].fg, accent[t].base, 4.5);
  });

  it.each(Object.keys(status) as (keyof typeof status)[])('status %s', (tone) => {
    const s = status[tone][t];
    check(`${tone}.fg on ${tone}.base`, s.fg, s.base, 4.5);
    check(`${tone}.base on ${tone}.soft`, s.base, s.soft, 4.5);
    check(`${tone}.base on bg.surface`, s.base, bg[t].surface, 4.5);
    // StatusBadge: the mark sits on the plain raised fill (neutral, success), where non-text contrast needs 3:1.
    check(`${tone}.base on bg.surface-raised`, s.base, bg[t]['surface-raised'], 3.0);
  });
});
