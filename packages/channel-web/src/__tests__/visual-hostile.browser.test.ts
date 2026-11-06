// @vitest-environment node
//
// The chat-visual box, tested in a real browser. A visual is untrusted HTML
// from the model; it renders in a `sandbox="allow-scripts"` srcdoc frame whose
// document opens with a no-network CSP, inside an app page whose own CSP is
// `frame-src 'none'`. This suite builds that exact arrangement in Chromium and
// throws hostile content at it: every request, navigation, storage read and
// WebRTC/child-frame trick we know of, all aimed at a canary server that
// records anything that reaches it. The canary must hear nothing.
//
// The frame document is built IN the page, by the real visual-doc.ts module
// (transpiled, not reimplemented), so its child-frame sanitizer runs on the
// browser's own DOMParser — the same parser production uses, not jsdom's.
//
// Locally this skips when Playwright's Chromium isn't installed. In CI it never
// skips: CI installs Chromium (.github/workflows/ci.yml), and if that ever
// stops working the suite fails instead of going quietly green.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import ts from 'typescript';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_VISUAL_ASSETS } from '../components/workspace/visual/visual-assets';

const PKG = resolve(__dirname, '../..');
const VISUAL_DOC_TS = resolve(PKG, 'src/components/workspace/visual/visual-doc.ts');

const IN_CI = !!process.env.CI;
const CHROMIUM_MISSING = !existsSync(chromium.executablePath());

const TOKENS: Record<string, string> = {
  '--card': '0 0% 100%',
  '--card-foreground': '240 10% 3.9%',
  '--muted-foreground': '240 3.8% 46.1%',
  '--border': '240 5.9% 90%',
  '--popover': '0 0% 100%',
  '--popover-foreground': '240 10% 3.9%',
  '--chart-1': '242.71 63.03% 58.63%',
  '--chart-2': '173 58% 39%',
  '--chart-3': '27 87% 55%',
};

// How Playwright reports a request Chromium's CSP refused before it left.
const CSP_REFUSED = new Set(['csp', 'net::ERR_BLOCKED_BY_CSP']);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Hit {
  kind: 'request' | 'upgrade' | 'connect';
  method: string | undefined;
  url: string | undefined;
}

interface Recorded {
  frame: string | null;
  data: unknown;
}

/** The app shell's CSP meta, read from the index.html the app actually ships. */
function appCspMeta(): string {
  const html = readFileSync(resolve(PKG, 'index.html'), 'utf8');
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i)?.[0];
  if (!meta || !meta.includes("frame-src 'none'")) {
    throw new Error("index.html no longer carries the frame-src 'none' CSP meta");
  }
  return meta;
}

/** visual-doc.ts as a browser module. It must stay import-free to load this way. */
function visualDocModule(): string {
  const source = readFileSync(VISUAL_DOC_TS, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  if (/^\s*import\s/m.test(out)) throw new Error('visual-doc.ts grew an import; load it differently');
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

const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The app page: the shipped CSP meta, then a module script that builds each
 * visual with buildVisualDocument and mounts it the way VisualFrame does.
 * Every message any frame posts to this window lands in window.__results.
 */
function appPage(visuals: Record<string, string>, spacerPx = 0): string {
  return `<!doctype html><html lang="en"><head>${appCspMeta()}<meta charset="utf-8"><title>visual box probe</title></head><body>
<script type="module">
import { buildVisualDocument, VISUAL_IFRAME_SANDBOX } from '/visual-doc.js';
const assets = ${json(DEFAULT_VISUAL_ASSETS)};
const tokens = ${json(TOKENS)};
const visuals = ${json(visuals)};
const frames = new Map();
window.__results = [];
window.addEventListener('message', (e) => {
  let frame = null;
  for (const [name, f] of frames) if (f.contentWindow === e.source) frame = name;
  const d = e.data;
  const data = d && typeof d === 'object' && d.blob instanceof Blob ? { ...d, blob: '[blob]' } : d;
  window.__results.push({ frame, data });
});
window.__exportPng = (name) => new Promise((done) => {
  const f = frames.get(name);
  const onMessage = async (e) => {
    const d = e.data;
    if (e.source !== f.contentWindow || !d || d.type !== 'ax-visual:export-result' || d.requestId !== 'r1') return;
    window.removeEventListener('message', onMessage);
    if (!(d.blob instanceof Blob)) return done({ ok: d.ok, head: null });
    const bytes = new Uint8Array(await d.blob.arrayBuffer());
    done({ ok: d.ok, type: d.blob.type, head: Array.from(bytes.slice(0, 8)) });
  };
  window.addEventListener('message', onMessage);
  f.contentWindow.postMessage({ type: 'ax-visual:export', requestId: 'r1', format: 'png' }, '*');
});
if (${spacerPx} > 0) {
  // Pushes every visual below the fold, where the browser doesn't paint it.
  const spacer = document.createElement('div');
  spacer.style.height = '${spacerPx}px';
  document.body.appendChild(spacer);
}
for (const [name, html] of Object.entries(visuals)) {
  const f = document.createElement('iframe');
  // Every load the iframe element sees: VisualFrame treats any after the first as a navigation.
  window.__loads = window.__loads || {};
  window.__loads[name] = 0;
  f.addEventListener('load', () => { window.__loads[name] += 1; });
  f.setAttribute('sandbox', VISUAL_IFRAME_SANDBOX);
  f.style.width = '640px';
  f.style.height = '400px';
  f.srcdoc = buildVisualDocument({ html, mode: 'light', tokens }, assets);
  frames.set(name, f);
  document.body.appendChild(f);
}
window.__mounted = Object.keys(visuals).length;
</script></body></html>`;
}

describe.skipIf(CHROMIUM_MISSING && !IN_CI)('chat visual box in Chromium (hostile content)', () => {
  let browser: Browser;
  let canary: Server;
  let app: Server;
  let canaryPort: number;
  let appPort: number;
  let canaryUrl: string;
  const canaryHits: Hit[] = [];
  let tcpConnections = 0;
  const pages = new Map<string, string>();
  let visualDocJs: string;

  beforeAll(async () => {
    if (CHROMIUM_MISSING) {
      // Only reachable in CI: locally a missing browser skips the suite above.
      throw new Error(
        `Playwright Chromium is not installed at ${chromium.executablePath()}. CI must run this suite, not skip it: ` +
          'check the "Install Playwright Chromium" step in .github/workflows/ci.yml.',
      );
    }
    visualDocJs = visualDocModule();

    canary = createServer((req: IncomingMessage, res) => {
      canaryHits.push({ kind: 'request', method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('canary');
    });
    // A WebSocket handshake arrives as 'upgrade' (not 'request'), CONNECT as 'connect'.
    canary.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      canaryHits.push({ kind: 'upgrade', method: req.method, url: req.url });
      socket.destroy();
    });
    canary.on('connect', (req: IncomingMessage, socket: Socket) => {
      canaryHits.push({ kind: 'connect', method: req.method, url: req.url });
      socket.destroy();
    });
    canary.on('connection', () => {
      tcpConnections += 1;
    });
    canaryPort = await listen(canary);
    canaryUrl = `http://127.0.0.1:${canaryPort}`;

    app = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/visual-doc.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(visualDocJs);
        return;
      }
      const page = pages.get(url);
      if (page === undefined) {
        res.writeHead(404).end();
        return;
      }
      // The app's session cookie: a visual must never be able to read it.
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'ax_probe=secret; Path=/' });
      res.end(page);
    });
    appPort = await listen(app);

    browser = await chromium.launch();
  });

  // Chrome isolates a sandboxed frame in its own renderer process
  // (IsolateSandboxedIframes), but Playwright's --disable-field-trial-config
  // leaves that off. With it on, a frame can start parsing before its size
  // arrives: a second browser for the tests that need the real arrangement.
  let isolatedBrowser: Browser | undefined;
  async function isolated(): Promise<Browser> {
    isolatedBrowser ??= await chromium.launch({ args: ['--site-per-process', '--enable-features=IsolateSandboxedIframes'] });
    return isolatedBrowser;
  }

  afterAll(async () => {
    await isolatedBrowser?.close();
    await browser?.close();
    await close(canary);
    await close(app);
  });

  interface Run {
    page: Page;
    appUrl: string;
    results: Recorded[];
    /** Every request the browser started, with how it ended. */
    requests: Map<string, string>;
    consoleErrors: string[];
    /** Every URL any frame (top included) committed, in order. */
    navigations: string[];
    /** What reached the canary during this run (so one leak can't fail every later test). */
    hits: Hit[];
  }

  /**
   * Loads the app page with these visuals, waits for the `settle` ones to say
   * ready or error, then ~3 s more. A visual left out of `settle` may never
   * say anything (it navigates away first), so only the wait covers it.
   */
  async function run(
    path: string,
    visuals: Record<string, string>,
    settle: string[] = Object.keys(visuals),
    settleMs = 3000,
    {
      spacerPx = 0,
      settleTimeoutMs = 20_000,
      isolate = false,
    }: { spacerPx?: number; settleTimeoutMs?: number; isolate?: boolean } = {},
  ): Promise<Run> {
    pages.set(path, appPage(visuals, spacerPx));
    const hitsBefore = canaryHits.length;
    const connectionsBefore = tcpConnections;
    const page = await (isolate ? await isolated() : browser).newPage();
    // Chromium reports a request the CSP refused as started-then-failed
    // (Playwright says `csp`), so "started" alone isn't a leak; what it
    // ended as is the evidence, alongside the canary's own log.
    const requests = new Map<string, string>();
    const consoleErrors: string[] = [];
    page.on('request', (r) => requests.set(r.url(), 'pending'));
    page.on('requestfailed', (r) => requests.set(r.url(), r.failure()?.errorText ?? 'failed'));
    page.on('response', (r) => requests.set(r.url(), `response ${r.status()}`));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`${e.name}: ${e.message}`));
    const navigations: string[] = [];
    page.on('framenavigated', (f) => navigations.push(f.url()));
    const appUrl = `http://127.0.0.1:${appPort}${path}`;
    await page.goto(appUrl);
    await page.waitForFunction((n) => (window as unknown as { __mounted?: number }).__mounted === n, Object.keys(visuals).length);
    // Settled = the frame said ready or error. A frame that says neither fails the wait.
    await page.waitForFunction(
      (names) => {
        const results = (window as unknown as { __results: Recorded[] }).__results;
        return names.every((name) =>
          results.some((r) => {
            const t = (r.data as { type?: string } | null)?.type;
            return r.frame === name && (t === 'ax-visual:ready' || t === 'ax-visual:error');
          }),
        );
      },
      settle,
      { timeout: settleTimeoutMs },
    );
    await page.waitForTimeout(settleMs);
    const results = await page.evaluate(() => (window as unknown as { __results: Recorded[] }).__results);
    const hits = canaryHits.slice(hitsBefore);
    // A TCP connection with no request behind it is a resource hint
    // (<link rel=preconnect>) opening a socket: the known residual. No bytes
    // of the visual's data go out on it, so it's reported, not failed.
    console.info(
      `[visual-hostile] ${path}: canary saw ${tcpConnections - connectionsBefore} TCP connection(s) and ${hits.length} request(s)`,
    );
    return { page, appUrl, results, requests, consoleErrors, navigations, hits };
  }

  function from(results: Recorded[], frame: string): Record<string, unknown>[] {
    return results.filter((r) => r.frame === frame).map((r) => r.data as Record<string, unknown>);
  }

  /** Canary-bound requests the browser started and did NOT refuse. */
  function canaryLeaks(requests: Map<string, string>): string[] {
    return [...requests]
      .filter(([url, end]) => url.includes(`:${canaryPort}`) && !CSP_REFUSED.has(end))
      .map(([url, end]) => `${url} -> ${end}`);
  }

  it('(RF2) a benign whole-document chart with a CDN script renders under both CSPs, and exports a PNG', async () => {
    const html =
      `<!doctype html><html><head><script src="${canaryUrl}/chart.js"></script></head><body><canvas id="c"></canvas>` +
      '<script>new Chart(c,{type:"bar",data:{labels:["a","b"],datasets:[{data:[3,5]}]}})</script></body></html>';
    const { page, results, requests, consoleErrors, hits } = await run('/rf2', { chart: html });
    try {
      const messages = from(results, 'chart');
      expect(messages).toContainEqual({
        type: 'ax-visual:ready',
        height: expect.any(Number),
        rendered: true,
        locked: true,
      });
      expect(messages.some((m) => m.type === 'ax-visual:error')).toBe(false);

      const exported = await page.evaluate(() =>
        (window as unknown as { __exportPng: (n: string) => Promise<{ ok: boolean; type?: string; head: number[] | null }> }).__exportPng('chart'),
      );
      expect(exported).toEqual({ ok: true, type: 'image/png', head: PNG_MAGIC });

      // The CDN script was refused (the library is inlined instead), and the
      // inlining (`<!--` → `<\!--`, `</script` → `<\/script`) didn't break the
      // library source: no SyntaxError anywhere.
      expect(hits).toEqual([]);
      expect(canaryLeaks(requests)).toEqual([]);
      expect(consoleErrors.filter((e) => /SyntaxError/.test(e))).toEqual([]);
    } finally {
      await page.close();
    }
  });

  // VISUALS-1 (kind walk): the real Chart.js, not a stub. A per-bar color
  // array of ax.chartColor(...) functions painted every bar black, and a
  // color the agent read once from ax.color() stayed light in dark mode.
  const WALK_CHART = `<canvas id="c" width="600" height="300"></canvas>
<script>
window.__grid = ax.color('border');
window.__chart = new Chart(document.getElementById('c'), {
  type: 'bar',
  data: { labels: ['a', 'b', 'c'], datasets: [{
    data: [5, 5, 5],
    barPercentage: 0.5,
    backgroundColor: [ax.chartColor('chart-1'), ax.chartColor('chart-2', 0.5), 'hsl(var(--chart-3))'],
  }] },
  options: {
    animation: false, responsive: false, devicePixelRatio: 1,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { grid: { display: false } },
      y: { min: 0, max: 10, ticks: { stepSize: 2 }, grid: { color: window.__grid, lineWidth: 3 } },
    },
  },
});
</script>`;
  const DARK_BORDER = '226.67 12% 22%';

  type FramePixels = { rgba: number[]; expect: number[] };
  /** Runs in the visual frame: a bar's center pixel, and its token color drawn on a scratch canvas. */
  function sampleBars(): FramePixels[] {
    const w = window as unknown as {
      __chart: { getDatasetMeta(i: number): { data: { x: number; y: number; base: number }[] }; ctx: CanvasRenderingContext2D };
      ax: { color(n: string, a?: number): string };
    };
    const swatch = (css: string) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const g = c.getContext('2d')!;
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      return Array.from(g.getImageData(0, 0, 1, 1).data);
    };
    const want = [w.ax.color('chart-1'), w.ax.color('chart-2', 0.5), w.ax.color('chart-3')];
    return w.__chart.getDatasetMeta(0).data.map((bar, i) => ({
      rgba: Array.from(w.__chart.ctx.getImageData(Math.round(bar.x), Math.round((bar.y + bar.base) / 2), 1, 1).data),
      expect: swatch(want[i]!),
    }));
  }
  function sampleGrid(): FramePixels {
    const w = window as unknown as {
      __chart: { scales: { y: { getPixelForValue(v: number): number } }; chartArea: { left: number; right: number }; ctx: CanvasRenderingContext2D };
      ax: { color(n: string): string };
    };
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d')!;
    g.fillStyle = w.ax.color('border');
    g.fillRect(0, 0, 1, 1);
    const y = Math.round(w.__chart.scales.y.getPixelForValue(8));
    const x = Math.round((w.__chart.chartArea.left + w.__chart.chartArea.right) / 2);
    return { rgba: Array.from(w.__chart.ctx.getImageData(x, y, 1, 1).data), expect: Array.from(g.getImageData(0, 0, 1, 1).data) };
  }
  const near = (a: number[], b: number[], tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

  it('(VISUALS-1) a per-bar array of ax.chartColor / var() colors paints the palette, not black', async () => {
    const { page, results } = await run('/walk-bars', { chart: WALK_CHART }, ['chart'], 0);
    try {
      expect(from(results, 'chart').some((m) => m.type === 'ax-visual:error')).toBe(false);
      const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
      const bars = await frame.evaluate(sampleBars);
      expect(bars).toHaveLength(3);
      for (const bar of bars) {
        expect(bar.rgba[3], `bar ${JSON.stringify(bar)}`).toBeGreaterThan(0);
        expect(bar.rgba.slice(0, 3), `bar ${JSON.stringify(bar)}`).not.toEqual([0, 0, 0]);
        expect(near(bar.rgba, bar.expect), `bar ${JSON.stringify(bar)}`).toBe(true);
      }
      expect(bars[1]!.rgba[3]).toBeGreaterThan(110); // the 0.5 alpha was honored
      expect(bars[1]!.rgba[3]).toBeLessThan(145);
    } finally {
      await page.close();
    }
  });

  it('(VISUALS-1) a gridline color captured from ax.color at startup follows the theme', async () => {
    const { page } = await run('/walk-grid', { chart: WALK_CHART }, ['chart'], 0);
    try {
      const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
      const light = await frame.evaluate(sampleGrid);
      expect(near(light.rgba, light.expect), JSON.stringify(light)).toBe(true);
      await page.evaluate((border) => {
        document.querySelector('iframe')!.contentWindow!.postMessage(
          { type: 'ax-visual:theme', mode: 'dark', tokens: { '--border': border, '--card': '226.67 15.25% 11.57%' } },
          '*',
        );
      }, DARK_BORDER);
      await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.waitForTimeout(200);
      const dark = await frame.evaluate(sampleGrid);
      expect(near(dark.expect, light.expect)).toBe(false); // the token really changed
      expect(near(dark.rgba, dark.expect), JSON.stringify(dark)).toBe(true);
    } finally {
      await page.close();
    }
  });

  // What the walk agent's own cssVar() helper did: read the token with
  // getComputedStyle and wrap it in hsl(). The plain form happens to equal a
  // string the runtime's own defaults got from ax.color('border'); the comma
  // form never comes from ax.color, so only the token-triplet match heals it.
  it.each([
    ['plain', "'hsl(' + v + ')'"],
    ['comma', "'hsl(' + v.split(/\\s+/).join(', ') + ')'"],
  ])('(VISUALS-1) a gridline color the agent built from getComputedStyle (%s) follows the theme', async (form, expr) => {
    const chart = WALK_CHART.replace(
      "window.__grid = ax.color('border');",
      "var v = getComputedStyle(document.documentElement).getPropertyValue('--border').trim(); window.__grid = " + expr + ';',
    );
    expect(chart).not.toBe(WALK_CHART);
    const { page } = await run(`/walk-grid-css-${form}`, { chart }, ['chart'], 0);
    try {
      const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
      const grid = await frame.evaluate(() => (window as unknown as { __grid: string }).__grid);
      expect(grid).toMatch(form === 'comma' ? /^hsl\(240, 5\.9%, 90%\)$/ : /^hsl\(240 5\.9% 90%\)$/);
      const light = await frame.evaluate(sampleGrid);
      expect(near(light.rgba, light.expect), JSON.stringify(light)).toBe(true);
      await page.evaluate((border) => {
        document.querySelector('iframe')!.contentWindow!.postMessage(
          { type: 'ax-visual:theme', mode: 'dark', tokens: { '--border': border, '--card': '226.67 15.25% 11.57%' } },
          '*',
        );
      }, DARK_BORDER);
      await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.waitForTimeout(200);
      const dark = await frame.evaluate(sampleGrid);
      expect(near(dark.expect, light.expect)).toBe(false);
      expect(near(dark.rgba, dark.expect), JSON.stringify(dark)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('(BUG-2) an offscreen chart in an isolated frame ends up sized to its container', async () => {
    // A responsive chart built at parse time, like the walk agent's. Before
    // the fix about 6 in 10 measured a 0-wide frame and stayed 0 offscreen.
    const chart = `<div style="position:relative;height:200px" id="box"><canvas id="c"></canvas></div>
<script>
window.__chart = new Chart(document.getElementById('c'), {
  type: 'bar',
  data: { labels: ['a', 'b', 'c'], datasets: [{ data: [1, 2, 3] }] },
  options: { responsive: true, maintainAspectRatio: false },
});
</script>`;
    // One frame per page: frames on one page share the isolated process, so
    // only the first pays the race. Six pages, each a fresh process.
    const ok = (s: { chart: number; height: number; box: number }) =>
      s.box > 0 && s.chart > 0 && s.height > 0 && Math.abs(s.chart - s.box) <= 1;
    const offscreen: unknown[] = [];
    const onscreen: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const { page } = await run(`/bug2-${i}`, { chart }, ['chart'], 0, { spacerPx: 5000, isolate: true });
      try {
        const frame = page.frames()[1]!;
        const size = () =>
          frame.evaluate(() => {
            const w = window as unknown as { __chart: { width: number; height: number } };
            return { chart: w.__chart.width, height: w.__chart.height, box: document.getElementById('box')!.clientWidth };
          });
        // Never scrolled into view: ready, then a timer tick.
        await page.waitForTimeout(1500);
        offscreen.push(await size());
        await page.evaluate(() => document.querySelector('iframe')!.scrollIntoView());
        await page.waitForTimeout(500);
        onscreen.push(await size());
      } finally {
        await page.close();
      }
    }
    expect(offscreen.every((s) => ok(s as Parameters<typeof ok>[0])), JSON.stringify(offscreen)).toBe(true);
    expect(onscreen.every((s) => ok(s as Parameters<typeof ok>[0])), JSON.stringify(onscreen)).toBe(true);
  });

  it('(BUG-2 review) a chart Chart.js keeps narrower than its box (max-width) still animates to its target', async () => {
    // Chart.js sizes a canvas to less than its container's content width when
    // the canvas has max-width, margin, padding or border. The refit must
    // measure the way Chart.js does, or it stops the chart's animation on
    // every tick and freezes the bars partway.
    const chart = `<div style="position:relative;height:200px;width:600px"><canvas id="c" style="max-width:400px"></canvas></div>
<script>
window.__chart = new Chart(document.getElementById('c'), {
  type: 'bar',
  data: { labels: ['a', 'b', 'c'], datasets: [{ data: [1, 2, 3] }] },
  options: { responsive: true, maintainAspectRatio: false, animation: { duration: 1500 } },
});
</script>`;
    const { page } = await run('/bug2-maxwidth', { chart }, ['chart'], 0);
    try {
      const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
      await page.waitForTimeout(3000);
      const r = await frame.evaluate(() => {
        const c = (window as unknown as {
          __chart: {
            width: number;
            getDatasetMeta(i: number): { data: { y: number }[] };
            scales: { y: { getPixelForValue(v: number): number } };
          };
        }).__chart;
        return { w: c.width, barY: c.getDatasetMeta(0).data[2]!.y, target: c.scales.y.getPixelForValue(3) };
      });
      expect(r.w, JSON.stringify(r)).toBe(400);
      expect(Math.abs(r.barY - r.target), JSON.stringify(r)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it('(BUG-3) clicking an ordinary link in a visual goes nowhere: the visual stays up', async () => {
    const C = canaryUrl;
    const visual = `<p>links</p><a id="l" href="${C}/link-click" style="display:block;padding:20px">Open in Linear</a>
<svg width="120" height="40"><a id="s" href="${C}/svg-link-click"><rect width="120" height="40"></rect></a></svg>`;
    const { page, results, requests, hits } = await run('/bug3-link', { links: visual }, ['links'], 0);
    try {
      const frame = page.frames().find((f) => f.url() === 'about:srcdoc')!;
      const settled = async () => {
        await page.waitForTimeout(1000);
        const loads = await page.evaluate(() => (window as unknown as { __loads: Record<string, number> }).__loads);
        expect({ loads: loads.links, urls: page.frames().slice(1).map((f) => f.url()) }).toEqual({
          loads: 1,
          urls: ['about:srcdoc'],
        });
      };
      await frame.click('#l', { timeout: 3000 });
      await settled();
      await frame.click('#s', { timeout: 3000 });
      await settled();
      expect(await frame.evaluate(() => document.getElementById('l')?.textContent)).toBe('Open in Linear');
      const after = await page.evaluate(() => (window as unknown as { __results: Recorded[] }).__results);
      expect(from(after, 'links').some((m) => m.type === 'ax-visual:error')).toBe(false);
      expect(from(results, 'links')).toContainEqual(expect.objectContaining({ type: 'ax-visual:ready', rendered: true }));
      expect(hits).toEqual([]);
      expect(canaryHits.filter((h) => h.url?.includes('link-click'))).toEqual([]);
      expect(canaryLeaks(requests)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('(BUG-3) a visual that navigates itself fires a second load on the iframe (the parent fails it), and sends nothing', async () => {
    const C = canaryUrl;
    const visual = `<p>nav</p><script>setTimeout(function () { location.href = '${C}/self-nav-bug3'; }, 300);</script>`;
    const { page, requests } = await run('/bug3-nav', { nav: visual }, ['nav'], 0);
    try {
      await page.waitForFunction(
        () => ((window as unknown as { __loads: Record<string, number> }).__loads.nav ?? 0) >= 2,
        undefined,
        { timeout: 5000 },
      );
      expect(canaryHits.filter((h) => h.url?.includes('self-nav-bug3'))).toEqual([]);
      expect(canaryLeaks(requests)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('a visual below the fold says ready without being scrolled into view', async () => {
    // Chromium runs no animation frames for an offscreen cross-origin frame;
    // a ready that waits on rAF alone would never come. The parent's 8 s
    // budget doesn't run while the card is off screen, but the frame must
    // still say ready on its own, well inside that.
    const { page, results } = await run(
      '/offscreen',
      { below: '<div style="height:120px">hello chart</div>' },
      ['below'],
      0,
      { spacerPx: 5000, settleTimeoutMs: 4000 },
    );
    try {
      const inView = await page.evaluate(() => {
        const f = document.querySelector('iframe')!;
        return f.getBoundingClientRect().top < window.innerHeight;
      });
      expect(inView).toBe(false);
      expect(from(results, 'below')).toContainEqual({
        type: 'ax-visual:ready',
        height: expect.any(Number),
        rendered: true,
        locked: true,
      });
      const ready = from(results, 'below').find((m) => m.type === 'ax-visual:ready')!;
      expect(ready.height as number).toBeGreaterThanOrEqual(120);
    } finally {
      await page.close();
    }
  });

  it('a visual whose body is only a script says it rendered nothing', async () => {
    const { page, results } = await run('/script-only', { empty: '<script>var a = "only script text here";</script>' }, ['empty'], 0);
    try {
      expect(from(results, 'empty')).toContainEqual(expect.objectContaining({ type: 'ax-visual:ready', rendered: false }));
    } finally {
      await page.close();
    }
  });

  it('a hostile visual reaches nothing: no request leaves the frame', async () => {
    const C = canaryUrl;
    const ws = C.replace('http://', 'ws://');
    // Every probe reports {probe, outcome}. The outcome is informational except
    // where asserted below; what matters is that the canary hears nothing.
    const hostile = `
<img src="${C}/img-static">
<link rel="stylesheet" href="${C}/link-stylesheet">
<link rel="prefetch" href="${C}/link-prefetch">
<link rel="preconnect" href="${C}">
<link rel="dns-prefetch" href="${C}">
<script src="${C}/script-src"></script>
<style>@import url("${C}/css-import"); body { background-image: url("${C}/css-url"); }</style>
<video src="${C}/video"></video>
<form id="f" action="${C}/form" method="post"><input name="a" value="b"></form>
<p>hostile</p>
<script>
function rep(probe, outcome) { parent.postMessage({ probe: probe, outcome: String(outcome) }, '*'); }
function attempt(name, fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') {
      r.then(function () { rep(name, 'resolved'); }, function (e) { rep(name, 'rejected:' + e.name); });
    } else {
      rep(name, r === undefined ? 'ran' : r === null ? 'null' : 'returned');
    }
  } catch (e) {
    rep(name, 'threw');
  }
}
attempt('fetch', function () { return fetch('${C}/fetch'); });
attempt('image', function () { var i = new Image(); i.src = '${C}/image'; });
attempt('sendBeacon', function () { return navigator.sendBeacon('${C}/beacon', 'x') ? 'sent' : 'refused'; });
attempt('websocket', function () { new WebSocket('${ws}/ws'); });
attempt('xhr', function () { var x = new XMLHttpRequest(); x.open('GET', '${C}/xhr'); x.send(); });
attempt('eventsource', function () { new EventSource('${C}/eventsource'); });
attempt('worker', function () { new Worker('data:text/javascript,fetch(%22${C}/worker%22)'); });
attempt('window.open', function () { return window.open('${C}/open'); });
attempt('form.submit', function () { document.getElementById('f').submit(); });
attempt('cookie', function () { return document.cookie; });
attempt('localStorage', function () { return window.localStorage; });
attempt('parent.document', function () { return parent.document; });
attempt('top.location', function () { top.location = '${C}/top-nav'; });
// Last: navigate this frame itself. The frame's own CSP can't govern this;
// the app's frame-src 'none' does.
window.addEventListener('load', function () {
  setTimeout(function () { attempt('location.href', function () { location.href = '${C}/self-nav'; }); }, 500);
});
</script>`;
    const refresh = `<p>refresh</p><meta http-equiv="refresh" content="0;url=${C}/meta-refresh">`;
    // The refresh visual can navigate before it says ready, so only `hostile` must settle.
    const { page, appUrl, results, requests, navigations, hits } = await run('/hostile', { hostile, refresh }, ['hostile']);
    try {
      const probes = from(results, 'hostile').filter((m) => typeof m.probe === 'string');
      const outcome = (name: string) => probes.find((m) => m.probe === name)?.outcome;

      expect(hits).toEqual([]);
      expect(canaryLeaks(requests)).toEqual([]);
      expect(outcome('cookie')).toBe('threw');
      expect(outcome('localStorage')).toBe('threw');
      expect(outcome('parent.document')).toBe('threw');
      expect(outcome('window.open')).toBe('null');
      // Every probe actually ran (a probe that never reported proves nothing).
      expect(probes.map((m) => m.probe).sort()).toEqual(
        [
          'cookie', 'eventsource', 'fetch', 'form.submit', 'image', 'localStorage', 'location.href',
          'parent.document', 'sendBeacon', 'top.location', 'websocket', 'window.open', 'worker', 'xhr',
        ].sort(),
      );
      expect(page.url()).toBe(appUrl); // top never navigated
      // Neither frame ever committed the canary. Chromium answers a navigation
      // the app's frame-src refused by committing its own error page in the
      // frame (the visual is gone, nothing was sent), so a frame may end on
      // chrome-error rather than about:srcdoc.
      expect(navigations.filter((u) => u.includes(`:${canaryPort}`))).toEqual([]);
      for (const url of page.frames().slice(1).map((f) => f.url())) {
        expect(['about:srcdoc', 'chrome-error://chromewebdata/']).toContain(url);
      }
      expect(page.frames()).toHaveLength(3); // top + the two visuals, no children
    } finally {
      await page.close();
    }
  });

  it('WebRTC is gone from the frame, and no child frame ever gets to run', async () => {
    // A child frame (even srcdoc) would get fresh WebRTC constructors, so each
    // vector tries to make one whose script reports to the top window.
    const child = (n: string) =>
      `<script>top.postMessage({ leak: '${n}', rtc: typeof RTCPeerConnection }, '*')</script>`;
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const js = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');
    const iframe = (n: string) => `<iframe srcdoc="${attr(child(n))}"></iframe>`;
    const dsd = (n: string) => `<div><template shadowrootmode="open">${iframe(n)}</template></div>`;

    const webrtc = `<p>webrtc</p>
${iframe('static-srcdoc')}
<div id="host1"></div><div id="host2"></div><div id="host3"></div>
<script>
function rep(probe, outcome) { parent.postMessage({ probe: probe, outcome: String(outcome) }, '*'); }
function attempt(name, fn) { try { rep(name, fn()); } catch (e) { rep(name, 'threw'); } }
rep('typeof RTCPeerConnection', typeof RTCPeerConnection);
rep('typeof webkitRTCPeerConnection', typeof webkitRTCPeerConnection);
attempt('new RTCPeerConnection', function () { new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${canaryPort}' }] }); return 'constructed'; });
attempt('restore RTCPeerConnection', function () { delete window.RTCPeerConnection; return typeof window.RTCPeerConnection; });
attempt('script iframe', function () {
  var f = document.createElement('iframe');
  f.srcdoc = ${js(child('script-srcdoc'))};
  document.body.appendChild(f);
  return 'appended';
});
attempt('setHTMLUnsafe', function () { document.getElementById('host1').setHTMLUnsafe(${js(dsd('setHTMLUnsafe'))}); return 'set'; });
attempt('setHTML', function () { document.getElementById('host2').setHTML(${js(dsd('setHTML'))}, { sanitizer: { removeElements: ['script'] } }); return 'set'; });
attempt('parseHTMLUnsafe', function () { document.body.appendChild(Document.parseHTMLUnsafe(${js(dsd('parseHTMLUnsafe'))}).body.firstChild); return 'parsed'; });
attempt('attachShadow', function () {
  var root = document.getElementById('host3').attachShadow({ mode: 'closed' });
  root.innerHTML = ${js(iframe('attachShadow'))};
  return 'attached';
});
</script>`;
    const { page, results, requests, hits } = await run('/webrtc', { webrtc });
    try {
      const messages = from(results, 'webrtc');
      const probes = messages.filter((m) => typeof m.probe === 'string');
      const outcome = (name: string) => probes.find((m) => m.probe === name)?.outcome;

      // No child frame ever ran a line, and none exists now.
      expect(results.filter((r) => (r.data as { leak?: unknown } | null)?.leak !== undefined)).toEqual([]);
      expect(page.frames().slice(1).map((f) => f.url())).toEqual(['about:srcdoc']);
      expect(messages).toContainEqual(expect.objectContaining({ type: 'ax-visual:ready', locked: true }));
      expect(messages.some((m) => m.type === 'ax-visual:error')).toBe(false);
      expect(outcome('typeof RTCPeerConnection')).toBe('undefined');
      expect(outcome('typeof webkitRTCPeerConnection')).toBe('undefined');
      expect(outcome('new RTCPeerConnection')).toBe('threw');
      expect(outcome('restore RTCPeerConnection')).toBe('undefined');
      // The runtime pins these to a throwing stub whether or not this
      // Chromium ships them yet.
      for (const api of ['setHTMLUnsafe', 'setHTML', 'parseHTMLUnsafe', 'attachShadow']) {
        expect(outcome(api), api).toBe('threw');
      }
      expect(hits).toEqual([]);
      expect(canaryLeaks(requests)).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
