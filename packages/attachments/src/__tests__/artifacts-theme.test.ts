import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startContentOrigin, type ServedArtifact } from '../artifacts/content-origin.js';
import { ARTIFACT_PALETTE, injectTheme, themeStyleElement, type ArtifactTheme } from '../artifacts/theme.js';
import { signViewToken, verifyViewToken } from '../artifacts/view-token.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('injectTheme', () => {
  const style = themeStyleElement('dark');
  const GUARD = '<script>/*guard*/</script>';

  it('goes right after the guard, which stays first in <head>, after the doctype, so the page keeps standards mode', () => {
    const out = dec(injectTheme(enc(`<!DOCTYPE html><html lang="en"><head>${GUARD}<meta charset="utf-8"><style>:root{--accent:#d9a05b}</style></head><body>x</body></html>`), 'dark'));
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain(`<head>${GUARD}${style}<meta charset="utf-8">`);
    // The page's own style still comes later, so it wins for anything it names.
    expect(out.indexOf(style)).toBeLessThan(out.indexOf('--accent:#d9a05b'));
  });

  it('inserts at a byte offset, whatever is in the file before the head', () => {
    const out = injectTheme(enc(`<!-- é — ü --><!DOCTYPE html><html><head>${GUARD}<title>t</title></head>`), 'dark');
    expect(dec(out)).toContain(`<head>${GUARD}${style}<title>t</title>`);
  });

  it('leaves a page that is not the guard\'s output exactly as it is', () => {
    for (const page of [
      '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>x</body></html>',
      '<HTML><HEAD lang="en"><title>t</title></HEAD></HTML>',
      '<p>x</p>',
    ]) {
      expect(dec(injectTheme(enc(page), 'dark'))).toBe(page);
    }
  });

  it('adds nothing but the one fixed block: its text is the same whatever the page says', () => {
    const page = `<html><head>${GUARD}<title>"; } body{display:none} /*</title></head></html>`;
    expect(dec(injectTheme(enc(page), 'dark'))).toBe(`<html><head>${GUARD}${style}<title>"; } body{display:none} /*</title></head></html>`);
  });

  it('offers whole colors under --ax-*, never bare triplets and never an unprefixed name', () => {
    for (const theme of ['light', 'dark'] as const) {
      const el = themeStyleElement(theme);
      expect(el).toMatch(/--ax-chart-1:hsl\(\d/);
      expect(el).toContain(`color-scheme:${theme}`);
      expect(el).not.toMatch(/[{;]--(?!ax-)[a-z]/);
    }
  });
});

describe('the palette copies the app stylesheet', () => {
  const css = readFileSync(fileURLToPath(new URL('../../../channel-web/src/index.css', import.meta.url)), 'utf8');

  function blockAfter(selector: string): string {
    const start = css.indexOf(selector);
    expect(start, `${selector} in index.css`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (depth > 0) {
      if (css[i] === '{') depth++;
      if (css[i] === '}') depth--;
      i++;
    }
    return css.slice(open + 1, i - 1);
  }

  const blocks: Record<ArtifactTheme, string> = {
    light: blockAfter(':root {'),
    dark: blockAfter(":root[data-theme='dark'] {"),
  };

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: every value matches --<name> in index.css`, () => {
      for (const [name, triplet] of Object.entries(ARTIFACT_PALETTE[theme])) {
        const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(blocks[theme]);
        expect(m?.[1]?.trim(), `--${name} (${theme})`).toBe(triplet);
      }
    });
  }
});

describe('view token theme claim', () => {
  const key = randomBytes(32);
  const now = Math.floor(Date.now() / 1000);
  const base = { artifactId: 'a1', version: 2, purpose: 'view' as const, linkBinding: null, expiresAt: now + 200 };

  it('round-trips, and a token with none reads back with no theme at all', () => {
    expect(verifyViewToken(key, signViewToken(key, { ...base, theme: 'dark' }), now)?.theme).toBe('dark');
    expect(verifyViewToken(key, signViewToken(key, base), now)).toEqual(base);
  });

  it('a token minted without a theme is byte-for-byte what it was before themes existed', () => {
    const payload = signViewToken(key, base).split('.')[1] as string;
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
      a: 'a1', n: 2, p: 'view', l: null, e: base.expiresAt,
    });
  });

  it('cannot be changed after signing', () => {
    const [p, payload, sig] = signViewToken(key, { ...base, theme: 'light' }).split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), t: 'dark' })).toString('base64url');
    expect(verifyViewToken(key, `${p}.${forged}.${sig}`, now)).toBeNull();
  });
});

describe('content origin', () => {
  const key = randomBytes(32);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  const PAGE = '<!doctype html><html><head><title>t</title></head><body>hi</body></html>';

  async function start() {
    const served: ServedArtifact = { bytes: enc(PAGE), mediaType: 'text/html', preview: 'html', filename: 'p.html' };
    const origin = await startContentOrigin({
      host: '127.0.0.1',
      port: 0,
      frameAncestors: ['http://localhost:9090'],
      key,
      serve: async () => served,
    });
    closers.push(() => origin.close());
    return origin.url;
  }

  const tokenFor = (purpose: 'view' | 'download', theme?: ArtifactTheme) =>
    signViewToken(key, {
      artifactId: 'a1', version: 1, purpose, linkBinding: null,
      expiresAt: Math.floor(Date.now() / 1000) + 200,
      ...(theme === undefined ? {} : { theme }),
    });

  it('a view token with a theme gets the palette; the CSP is unchanged', async () => {
    const url = await start();
    const res = await fetch(`${url}/v/${tokenFor('view', 'dark')}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(themeStyleElement('dark'));
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-downloads');
  });

  it('a view token with no theme adds no theme block (the page still gets the frame guard)', async () => {
    const url = await start();
    const body = await (await fetch(`${url}/v/${tokenFor('view')}`)).text();
    expect(body).not.toContain(':root{--ax-');
    expect(body).toContain('<title>t</title>');
    expect(body).toContain('hi');
  });

  it('a download is never changed, theme or not', async () => {
    const url = await start();
    expect(await (await fetch(`${url}/d/${tokenFor('download', 'dark')}`)).text()).toBe(PAGE);
  });
});
