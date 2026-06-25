import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyFaviconFromImage, resetFaviconToDefault } from '../favicon';

// jsdom ships no canvas backend, so stub the 2d context + toDataURL.
let fakeCtx: { drawImage: ReturnType<typeof vi.fn>; filter: string };

beforeEach(() => {
  fakeCtx = { drawImage: vi.fn(), filter: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,STUB',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  resetFaviconToDefault();
});

function img(): HTMLImageElement {
  return document.createElement('img');
}

describe('applyFaviconFromImage', () => {
  it('installs a single <link rel="icon"> with the generated data URL', () => {
    applyFaviconFromImage(img(), { invert: false });
    const links = document.querySelectorAll('link[rel="icon"]');
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute('href')).toBe('data:image/png;base64,STUB');
  });

  it('replaces (does not duplicate) the link on a second call', () => {
    applyFaviconFromImage(img(), { invert: false });
    applyFaviconFromImage(img(), { invert: false });
    expect(document.querySelectorAll('link[rel="icon"]').length).toBe(1);
  });

  it('applies an invert filter to the canvas when asked', () => {
    applyFaviconFromImage(img(), { invert: true });
    expect(fakeCtx.filter).toContain('invert');
  });

  it('leaves no filter when not inverting', () => {
    applyFaviconFromImage(img(), { invert: false });
    expect(fakeCtx.filter).toBe('');
  });
});

describe('resetFaviconToDefault', () => {
  it('removes our injected favicon link', () => {
    applyFaviconFromImage(img(), { invert: false });
    resetFaviconToDefault();
    expect(document.querySelectorAll('link[rel="icon"]').length).toBe(0);
  });
});
