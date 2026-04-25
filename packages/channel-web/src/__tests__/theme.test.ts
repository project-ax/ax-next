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
      expect(src).toContain(tok);
    }
    expect(src).toContain('[data-theme="dark"]');
    expect(src).toContain('prefers-color-scheme: dark');
  });
});
