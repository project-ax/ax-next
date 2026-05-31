/**
 * index.css contract for the composer accent glow + markdown list spacing.
 *
 * These are CSS-only behaviors that jsdom can't exercise via layout, so we
 * pin the load-bearing rules in the stylesheet directly — the same approach
 * theme.test.ts takes for the token palette.
 *
 * The list-spacing block is a regression guard: assistant/user message bodies
 * carry `white-space: pre-wrap` (to preserve newlines in plain-text turns),
 * which made react-markdown's structural newlines between <li> render as
 * blank lines — a full line-height gap between every bullet. The fix resets
 * the markdown container to normal whitespace and gives lists the prose
 * rhythm. If someone drops `.msg-body .aui-md { white-space: normal }`, the
 * blank-line gap comes back, so this test would fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, '../index.css'), 'utf-8');

describe('composer accent glow', () => {
  it('defines the --shadow-sm baseline', () => {
    expect(css).toContain('--shadow-sm:');
  });

  it('no longer paints the ambient body::before pool of light', () => {
    // The bottom-of-viewport radial glow and its breathing animation were
    // removed; the composer field keeps its own halo (below).
    expect(css).not.toContain('body::before');
    expect(css).not.toContain('composer-glow-breathe');
    expect(css).not.toContain('--composer-glow-center');
    expect(css).not.toContain('--composer-glow-mid');
  });

  it('gives the composer field an accent halo over --shadow-sm', () => {
    // Resting: hairline ring (10%) + drop bloom (30%) + radial bloom (18%) + --shadow-sm.
    expect(css).toMatch(
      /\.composer-field\s*\{[^}]*0 0 0 1px color-mix\(in oklch, hsl\(var\(--primary\)\) 10%, transparent\)/,
    );
    expect(css).toMatch(/\.composer-field\s*\{[^}]*var\(--shadow-sm\)/);
  });

  it('deepens the halo and tints the border on focus-within', () => {
    expect(css).toMatch(
      /\.composer-field:focus-within\s*\{[^}]*0 0 0 4px color-mix\(in oklch, hsl\(var\(--primary\)\) 16%, transparent\)/,
    );
    expect(css).toContain(
      'border-color: color-mix(in oklch, hsl(var(--primary)) 50%, hsl(var(--border)))',
    );
  });
});

describe('markdown list spacing', () => {
  it('resets the markdown container to normal whitespace (the regression fix)', () => {
    expect(css).toMatch(/\.msg-body \.aui-md\s*\{[^}]*white-space:\s*normal/);
  });

  it('gives lists the same 0.6em block rhythm as paragraphs', () => {
    expect(css).toMatch(
      /\.msg-body \.aui-md :is\(ul, ol\)\s*\{[^}]*margin:\s*0\.6em 0/,
    );
    expect(css).toMatch(/\.msg-body \.aui-md li\s*\{[^}]*margin-bottom:\s*0\.6em/);
    expect(css).toMatch(
      /\.msg-body \.aui-md li:last-child\s*\{[^}]*margin-bottom:\s*0/,
    );
    // Same rhythm paragraphs use, so list items match normal element spacing.
    expect(css).toMatch(/\.msg-body p\s*\{[^}]*margin-bottom:\s*0\.6em/);
  });
});
