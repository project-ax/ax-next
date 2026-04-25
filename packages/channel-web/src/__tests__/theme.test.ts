import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('design tokens', () => {
  it('declares Tide palette on :root', () => {
    const src = readFileSync(join(__dirname, '../index.css'), 'utf-8');
    for (const tok of ['--bg', '--ink', '--accent', '--rule', '--surface-raised',
                       '--bg-deep', '--ink-soft', '--ink-mute', '--ink-ghost',
                       '--accent-soft', '--you-wash', '--you-ink', '--danger',
                       '--shadow-sm', '--shadow-md', '--sans', '--mono', '--serif']) {
      // Match the token immediately followed by `:` (a CSS declaration)
      // — defeats prefix matching where e.g. `--bg` would be satisfied
      // by `--bg-deep` even if `--bg` itself were missing.
      const escaped = tok.replace(/-/g, '\\-');
      expect(src).toMatch(new RegExp(`${escaped}\\s*:`));
    }
    expect(src).toContain('[data-theme="dark"]');
    expect(src).toContain('prefers-color-scheme: dark');
  });
});
