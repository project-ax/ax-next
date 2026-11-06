import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INTER_FONT_URLS,
  VISUAL_FONT_FACE_CSS,
  VISUAL_LIBRARY_SOURCES,
  fontFaceCss,
} from '../visual-assets';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(HERE, '..', 'fonts');
const PKG_DIR = join(HERE, '..', '..', '..', '..', '..');

describe('visual assets', () => {
  it('inlines the three subsets as WOFF data URLs', () => {
    for (const url of Object.values(INTER_FONT_URLS)) {
      expect(url).toMatch(/^data:font\/woff;base64,[A-Za-z0-9+/]+=*$/);
    }
  });

  it('keeps each subset a small, real WOFF', () => {
    for (const w of [400, 500, 600]) {
      const b = readFileSync(join(FONTS_DIR, `inter-${w}-latin.woff`));
      expect(b.subarray(0, 4).toString('latin1')).toBe('wOFF');
      expect(b.byteLength).toBeLessThan(40_000);
    }
  });

  it('declares one face per weight from data URLs only', () => {
    const css = fontFaceCss({ 400: 'data:a', 500: 'data:b', 600: 'data:c' });
    expect(css.match(/@font-face/g)).toHaveLength(3);
    expect(css).toContain("font-family:'Inter'");
    expect(css).not.toMatch(/url\((?!data:)/);
  });

  it('builds the shipped face CSS from the inlined subsets', () => {
    expect(VISUAL_FONT_FACE_CSS).toBe(fontFaceCss(INTER_FONT_URLS));
    expect(VISUAL_FONT_FACE_CSS).toContain('font-weight:600');
  });

  it('vendors the pinned libraries', () => {
    expect(VISUAL_LIBRARY_SOURCES[0]).toMatch(/\bChart\b/);
    expect(VISUAL_LIBRARY_SOURCES[0]!.length).toBeGreaterThan(150_000);
    expect(VISUAL_LIBRARY_SOURCES[1]).toMatch(/htmlToImage/);
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
    expect([pkg.devDependencies['chart.js'], pkg.devDependencies['html-to-image']]).toEqual([
      '4.5.1',
      '1.11.13',
    ]);
  });
});
