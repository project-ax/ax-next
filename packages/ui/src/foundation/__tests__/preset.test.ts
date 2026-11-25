import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { renderUiCss } from '../../../scripts/build-css.js';
import { axPreset } from '../../tailwind/preset.js';

const content =
  'ax-p-md ax-p-4 ax-gap-sm ax-text-meta ax-text-sm ax-bg-surface ax-bg-white ax-text-fg-muted ax-rounded-lg md:ax-grid-cols-2';
const out = (await postcss([tailwindcss({ presets: [axPreset], content: [{ raw: content }] })]).process(
  '@tailwind utilities;',
  { from: undefined },
)).css;
const flat = out.replace(/\s+/g, '');

describe('axPreset', () => {
  it('token-backed utilities exist', () => {
    expect(flat).toContain('.ax-p-md{padding:var(--ax-space-md)}');
    expect(flat).toContain('.ax-gap-sm{gap:var(--ax-space-sm)}');
    expect(flat).toContain('.ax-rounded-lg{border-radius:var(--ax-radius-lg)}');
    expect(flat).toContain('.ax-text-fg-muted');
  });

  it('default-scale utilities do not', () => {
    expect(out).not.toMatch(/\.ax-p-4\b/);
    expect(out).not.toMatch(/\.ax-text-sm\b/);
    expect(out).not.toMatch(/\.ax-bg-white\b/);
  });

  it('text roles and colors read theme variables', () => {
    expect(flat).toMatch(/\.ax-text-meta\{font-size:var\(--ax-text-meta-size\)/);
    expect(flat).toContain('line-height:var(--ax-text-meta-line)');
    expect(flat).toMatch(/\.ax-bg-surface\{[^}]*hsl\(var\(--ax-bg-surface\)/);
  });

  it('has no preflight', () => {
    expect(out).not.toMatch(/\*,\s*::before/);
  });

  it('screens are md and lg only', () => {
    expect(flat).toContain('@media(min-width:768px)');
  });
});

describe('renderUiCss', () => {
  it('committed file is current', async () => {
    const file = readFileSync(fileURLToPath(new URL('../../../ui.css', import.meta.url)), 'utf8');
    expect(file, 'run pnpm --filter @project-ax/ui gen').toBe(await renderUiCss());
  });

  // The header once said `src/**/*.{ts,tsx}`: its `*/` closed the comment early, the rest of the
  // header became the selector of the first rule, and browsers dropped `.ax-m-none` entirely.
  it('parses cleanly and every rule is an ax- rule (the header comment closes only once)', async () => {
    const css = await renderUiCss();
    const root = postcss.parse(css);
    const selectors: string[] = [];
    root.walkRules((r) => {
      // Keyframe steps (`to`, `50%`) are not utility selectors.
      if (r.parent?.type === 'atrule' && (r.parent as postcss.AtRule).name === 'keyframes') return;
      selectors.push(r.selector);
    });
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) expect(sel, sel).toMatch(/^\.(?:[a-z-]+\\:)?ax-/);
    expect(selectors).toContain('.ax-m-none');
  });
});
