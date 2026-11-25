import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderThemeCss } from '../theme-css.js';

const css = renderThemeCss();
const block = (opener: string): string => {
  const start = css.indexOf(opener);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = start + opener.length;
  return css.slice(open, css.indexOf('}', open));
};

describe('renderThemeCss', () => {
  it('light root', () => {
    expect(css).toContain(':root {');
    expect(block(':root {')).toContain('--ax-bg-surface: 220.00 42.86% 98.63%;');
    expect(block(':root {')).toContain('color-scheme: light;');
  });

  it('respects explicit light', () => {
    const i = css.indexOf('@media (prefers-color-scheme: dark)');
    expect(i).toBeGreaterThanOrEqual(0);
    const after = css.slice(i);
    expect(after).toMatch(/@media \(prefers-color-scheme: dark\) \{\s+:root:not\(\[data-theme='light'\]\) \{/);
    expect(block(":root:not([data-theme='light']) {")).toContain('--ax-bg-surface: 226.67 15.25% 11.57%;');
  });

  it('explicit dark is byte-identical to the media block', () => {
    const norm = (b: string): string => b.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    expect(norm(block(":root[data-theme='dark'] {"))).toBe(norm(block(":root:not([data-theme='light']) {")));
  });

  it('non-color tokens only in :root', () => {
    expect(css.split('--ax-space-lg: 16px;').length - 1).toBe(1);
    expect(css).toContain('--ax-status-danger-hover:');
    expect(css).toContain('--ax-text-body-size: 15px;');
  });

  it('reduced motion zeroes the timed motion tokens', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+:root \{/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    const decls = block('@media (prefers-reduced-motion: reduce) {\n  :root {');
    expect(decls).toContain('--ax-motion-fast: 0ms;');
    expect(decls).toContain('--ax-motion-base: 0ms;');
    expect(decls).not.toContain('--ax-motion-ease');
    // Last in the file, so it wins over the same-specificity :root declarations above.
    expect(css.indexOf('--ax-motion-fast: 120ms;')).toBeLessThan(css.length - reduced.length);
  });

  it('committed file is current', () => {
    const file = readFileSync(fileURLToPath(new URL('../../../theme.css', import.meta.url)), 'utf8');
    expect(file, 'run pnpm --filter @project-ax/ui gen').toBe(css);
  });
});
