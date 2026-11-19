// @vitest-environment node
//
// The Slack bot's picture, tested in a real browser (TASK-1133). Slack takes
// only a square raster 512 to 2000 px a side, and prod's branding logo is a
// 517x123 SVG wordmark. jsdom has no canvas, so only Chromium can say whether
// the real drawing code turns that wordmark into an opaque 512 px PNG, and
// whether the logo's response headers (the `sandbox` CSP, `nosniff`) leave the
// canvas readable.
//
// The drawing module is loaded into the page transpiled, not reimplemented
// (as visual-hostile.browser.test.ts does with visual-doc.ts), and every image
// is served from the page's own origin, as branding serves its logo, so the
// canvas isn't tainted.
//
// Locally this skips when Playwright's Chromium isn't installed. In CI it never
// skips: CI installs Chromium (.github/workflows/ci.yml), and if that ever
// stops working the suite fails instead of going quietly green.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import ts from 'typescript';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLACK_AVATAR_MAX_BYTES, SLACK_AVATAR_PX } from '../lib/slack-avatar-draw';

const PKG = resolve(__dirname, '../..');
const DRAW_TS = resolve(PKG, 'src/lib/slack-avatar-draw.ts');
const AX_MARK_SVG = resolve(PKG, 'src/assets/design/ax-mark-light.svg');

const IN_CI = !!process.env.CI;
const CHROMIUM_MISSING = !existsSync(chromium.executablePath());

/** The branding logo route's headers for an SVG (packages/branding/src/routes.ts `getLogo`). */
const LOGO_HEADERS = {
  'content-type': 'image/svg+xml',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'cache-control': 'public, max-age=31536000, immutable',
};

const WIDE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="517" height="123" viewBox="0 0 517 123"><rect width="517" height="123" fill="#123456"/></svg>';
// No width or height, as design tools often export.
const VIEWBOX_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="#123456"/></svg>';

/** draw.ts as a browser module. It must stay import-free to load this way. */
function drawModule(): string {
  const source = readFileSync(DRAW_TS, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  if (/^\s*import\s/m.test(out)) throw new Error('slack-avatar-draw.ts grew an import; load it differently');
  return out;
}

function listen(server: Server): Promise<number> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port));
  });
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((done) => {
    if (!server) return done();
    server.closeAllConnections();
    server.close(() => done());
  });
}

type Rgba = [number, number, number, number];
interface Drawn {
  base64: string | null;
  /** RGBA at each probe, read back from the PNG itself. */
  pixels: Rgba[];
}

const WHITE: Rgba = [255, 255, 255, 255];
const NAVY: Rgba = [0x12, 0x34, 0x56, 255];

function near(actual: Rgba | undefined, want: Rgba, tolerance = 8): void {
  expect(actual).toBeDefined();
  for (let i = 0; i < 4; i += 1) {
    expect(Math.abs(actual![i]! - want[i]!), `channel ${i} of ${String(actual)} vs ${String(want)}`).toBeLessThanOrEqual(tolerance);
  }
}

describe.skipIf(CHROMIUM_MISSING && !IN_CI)('Slack bot picture in Chromium', () => {
  let browser: Browser;
  let app: Server;
  let origin: string;
  let drawJs: string;
  let axMark: Buffer;

  beforeAll(async () => {
    if (CHROMIUM_MISSING) {
      // Only reachable in CI: locally a missing browser skips the suite above.
      throw new Error(
        `Playwright Chromium is not installed at ${chromium.executablePath()}. CI must run this suite, not skip it: ` +
          'check the "Install Playwright Chromium" step in .github/workflows/ci.yml.',
      );
    }
    drawJs = drawModule();
    axMark = readFileSync(AX_MARK_SVG);
    app = createServer((req, res) => {
      switch (req.url) {
        case '/':
          // Vite rewrites a dynamic import() inside page.evaluate, so the page loads the module itself.
          res.writeHead(200, { 'content-type': 'text/html' }).end(
            '<!doctype html><html><head><title>avatar probe</title></head><body>' +
              '<script type="module">import * as m from "/slack-avatar-draw.js"; window.__draw = m;</script></body></html>',
          );
          return;
        case '/slack-avatar-draw.js':
          res.writeHead(200, { 'content-type': 'text/javascript' }).end(drawJs);
          return;
        case '/logo/wide.svg':
          res.writeHead(200, LOGO_HEADERS).end(WIDE_SVG);
          return;
        case '/logo/viewbox.svg':
          res.writeHead(200, LOGO_HEADERS).end(VIEWBOX_SVG);
          return;
        case '/logo/ax-mark.svg':
          res.writeHead(200, LOGO_HEADERS).end(axMark);
          return;
        case '/logo/missing.svg':
          res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not-found"}');
          return;
        default:
          res.writeHead(404).end();
      }
    });
    origin = `http://127.0.0.1:${await listen(app)}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await close(app);
  });

  async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/`);
      await page.waitForFunction(() => (window as unknown as { __draw?: unknown }).__draw !== undefined);
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  /** Loads and draws `logo` with the real module, then reads `probes` back out of the exported PNG. */
  function draw(logo: string, probes: Array<[number, number]>): Promise<Drawn> {
    return withPage((page) =>
      page.evaluate(
        async ({ url, points }) => {
          const mod = (window as unknown as { __draw: typeof import('../lib/slack-avatar-draw') }).__draw;
          const img = await mod.loadAvatarImage(url, 5000);
          const base64 = mod.drawSlackAvatar(img);
          if (base64 === null) return { base64, pixels: [] };
          const back = new Image();
          back.src = `data:image/png;base64,${base64}`;
          await back.decode();
          const canvas = document.createElement('canvas');
          canvas.width = back.naturalWidth;
          canvas.height = back.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(back, 0, 0);
          const pixels = points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data) as [number, number, number, number]);
          return { base64, pixels };
        },
        { url: logo, points: probes },
      ),
    );
  }

  function expectSquarePng(base64: string | null): void {
    expect(base64).not.toBeNull();
    const bytes = Buffer.from(base64!, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(bytes.readUInt32BE(16)).toBe(SLACK_AVATAR_PX);
    expect(bytes.readUInt32BE(20)).toBe(SLACK_AVATAR_PX);
    expect(bytes.length).toBeLessThanOrEqual(SLACK_AVATAR_MAX_BYTES);
  }

  it('a wide SVG wordmark served like the branding logo becomes a 512 px opaque square, centred', async () => {
    // The 517x123 wordmark contained in the 384 box is a band at x 64-448, y 211-302.
    const probes: Array<[number, number]> = [
      [256, 256], [70, 256], [440, 256], // inside the band
      [256, 190], [256, 320], [32, 256], [480, 256], // white around it
      [2, 2], [509, 2], [2, 509], [509, 509], // corners
    ];
    const { base64, pixels } = await draw('/logo/wide.svg', probes);
    expectSquarePng(base64);
    for (const i of [0, 1, 2]) near(pixels[i], NAVY);
    for (let i = 3; i < probes.length; i += 1) near(pixels[i], WHITE, 0);
  });

  it('an SVG with only a viewBox is letterboxed, not stretched', async () => {
    // A 4:1 band in the 384 box spans y 208-304; stretched to a square it would cover (256,190).
    const { base64, pixels } = await draw('/logo/viewbox.svg', [[256, 256], [256, 190], [256, 320]]);
    expectSquarePng(base64);
    near(pixels[0], NAVY);
    near(pixels[1], WHITE, 0);
    near(pixels[2], WHITE, 0);
  });

  it('the AX mark fills the box and leaves white corners', async () => {
    const corners: Array<[number, number]> = [[2, 2], [509, 2], [2, 509], [509, 509]];
    // The mark's outer stroke has its left point near x = 64 + 5.4 * 384 / 27 = 141.
    const { base64, pixels } = await draw('/logo/ax-mark.svg', [...corners, [141, 256]]);
    expectSquarePng(base64);
    for (let i = 0; i < 4; i += 1) near(pixels[i], WHITE, 0);
    expect(pixels[4]).not.toEqual(WHITE);
  });

  it('the AX mark as the bundle ships it, an inlined data: URI, draws the same', async () => {
    // The mark is under Vite's inline limit, so `import markLight from …svg`
    // is a `data:image/svg+xml,…` URI in the built SPA, not an HTTP URL. This
    // is the path a server with no logo and no name actually takes.
    const corners: Array<[number, number]> = [[2, 2], [509, 2], [2, 509], [509, 509]];
    const dataUri = `data:image/svg+xml,${encodeURIComponent(axMark.toString('utf8'))}`;
    const { base64, pixels } = await draw(dataUri, [...corners, [141, 256]]);
    expectSquarePng(base64);
    for (let i = 0; i < 4; i += 1) near(pixels[i], WHITE, 0);
    expect(pixels[4]).not.toEqual(WHITE);
  });

  it('a logo that 404s rejects', async () => {
    const outcome = await withPage((page) =>
      page.evaluate(async () => {
        const mod = (window as unknown as { __draw: typeof import('../lib/slack-avatar-draw') }).__draw;
        try {
          await mod.loadAvatarImage('/logo/missing.svg', 5000);
          return 'resolved';
        } catch {
          return 'rejected';
        }
      }),
    );
    expect(outcome).toBe('rejected');
  });
});
