import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('design tokens', () => {
  it('declares the shadcn HSL palette on :root', () => {
    const src = readFileSync(join(__dirname, '../index.css'), 'utf-8');
    // The chat UI now shares the shadcn HSL token surface admin uses.
    // Tide raw tokens (--bg, --ink, --accent, ...) were retired during
    // the Tailwind migration in favor of these.
    for (const tok of [
      '--background',
      '--foreground',
      '--card',
      '--card-foreground',
      '--popover',
      '--popover-foreground',
      '--primary',
      '--primary-foreground',
      '--primary-soft',
      '--secondary',
      '--secondary-foreground',
      '--muted',
      '--muted-foreground',
      '--accent',
      '--accent-foreground',
      '--destructive',
      '--destructive-foreground',
      '--destructive-soft',
      '--border',
      '--input',
      '--ring',
      '--radius',
      '--rule-soft',
      '--ink-ghost',
    ]) {
      const escaped = tok.replace(/-/g, '\\-');
      expect(src).toMatch(new RegExp(`${escaped}\\s*:`));
    }
    expect(src).toContain('[data-theme=\'dark\']');
    expect(src).toContain('prefers-color-scheme: dark');
  });
});
