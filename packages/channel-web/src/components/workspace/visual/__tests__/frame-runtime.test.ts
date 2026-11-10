import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FRAME_RUNTIME_SOURCE } from '../frame-runtime-source';
import { DEFAULT_VISUAL_ASSETS, VISUAL_FONT_FACE_CSS, VISUAL_LIBRARY_SOURCES } from '../visual-assets';
import { VISUAL_TOKEN_NAMES, VISUAL_TOKEN_VALUE } from '../visual-doc';

// jsdom ships no types and we don't add @types/jsdom for one test: describe
// just the slice we use.
type FrameWindow = Window &
  typeof globalThis & {
    axVisualRuntime: (win: FrameWindow, host: unknown) => void;
    eval: (code: string) => unknown;
    ax: {
      color(name: string): string;
      chartColor(name: string): () => string;
      resolve(css: string): string;
    };
    Chart?: unknown;
    htmlToImage?: unknown;
  };
interface JsdomInstance {
  window: FrameWindow;
}
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => JsdomInstance;
};

const FONTS_CSS = "@font-face{font-family:'Inter';src:url(data:font/woff;base64,AA==)}";
const PAGE =
  '<!doctype html><html data-theme="light" data-max-height="1200"><head>' +
  `<style id="ax-fonts">${FONTS_CSS}</style>` +
  '<style id="ax-theme">:root{--chart-1:242.71 63.03% 58.63%;--chart-2:173 80% 29%;--card:0 0% 100%}</style>' +
  '</head><body><p>hello</p></body></html>';

const doms: JsdomInstance[] = [];
afterEach(() => {
  for (const d of doms.splice(0)) d.window.close();
});

interface Setup {
  win: FrameWindow;
  host: FrameWindow & { postMessage: Mock };
}

function setup(before?: (win: FrameWindow) => void): Setup {
  const frame = new JSDOM(PAGE, { runScripts: 'outside-only', pretendToBeVisual: true });
  const hostDom = new JSDOM('<!doctype html>', { pretendToBeVisual: true });
  doms.push(frame, hostDom);
  const win = frame.window;
  const host = hostDom.window as Setup['host'];
  host.postMessage = vi.fn();
  before?.(win);
  win.eval(FRAME_RUNTIME_SOURCE);
  win.axVisualRuntime(win, host);
  return { win, host };
}

function posted(host: Setup['host'], type: string): unknown[] {
  return host.postMessage.mock.calls
    .filter((call) => (call[0] as { type?: string }).type === type)
    .map((call) => call[0]);
}

function readyCalls(host: Setup['host']): unknown[][] {
  return host.postMessage.mock.calls.filter(
    (call) => (call[0] as { type?: string }).type === 'ax-visual:ready',
  );
}

function sendFrom(win: FrameWindow, source: unknown, data: unknown): void {
  win.dispatchEvent(new win.MessageEvent('message', { data, source: source as Window }));
}

const frames = () => new Promise((r) => setTimeout(r, 100));

describe('frame runtime', () => {
  it('posts ready once after load', async () => {
    const { win, host } = setup();
    win.dispatchEvent(new win.Event('load'));
    await frames();
    // The real load event may fire too; still exactly one ready.
    win.dispatchEvent(new win.Event('load'));
    await frames();
    expect(readyCalls(host)).toEqual([
      [
        {
          type: 'ax-visual:ready',
          height: expect.any(Number),
          rendered: expect.any(Boolean),
          locked: true,
        },
        '*',
      ],
    ]);
  });

  it('says ready even when no animation frame ever runs (offscreen or hidden)', async () => {
    const { win, host } = setup((w) => {
      // What a browser does for a frame it isn't painting: rAF never calls back.
      w.requestAnimationFrame = () => 0;
    });
    win.dispatchEvent(new win.Event('load'));
    await new Promise((r) => setTimeout(r, 400));
    expect(posted(host, 'ax-visual:ready')).toEqual([expect.objectContaining({ type: 'ax-visual:ready' })]);
  });

  describe('rendered', () => {
    // jsdom has no layout: give the page the height the body padding alone makes.
    const tall = (body: string) => (w: FrameWindow) => {
      w.document.body.innerHTML = body;
      Object.defineProperty(w.document.documentElement, 'scrollHeight', { value: 28, configurable: true });
    };

    it('is false for a body holding only scripts, styles, templates and whitespace', async () => {
      const { win, host } = setup(
        tall('\n  <script>var a = "lots of script text";</script>\n<style>p{color:red}</style><template><p>x</p></template>  '),
      );
      win.dispatchEvent(new win.Event('load'));
      await frames();
      expect(posted(host, 'ax-visual:ready')).toEqual([expect.objectContaining({ rendered: false })]);
    });

    it('is true for an element that draws, or for bare text', async () => {
      for (const body of ['<script>1</script><canvas></canvas>', '<script>1</script> hello ']) {
        const { win, host } = setup(tall(body));
        win.dispatchEvent(new win.Event('load'));
        await frames();
        expect(posted(host, 'ax-visual:ready')).toEqual([expect.objectContaining({ rendered: true })]);
      }
    });
  });

  it('says locked:false in ready when a lock could not be installed', async () => {
    const { win, host } = setup((w) => {
      Object.defineProperty(w, 'RTCPeerConnection', { value: function () {}, configurable: false });
    });
    win.dispatchEvent(new win.Event('load'));
    await frames();
    expect(posted(host, 'ax-visual:ready')).toEqual([expect.objectContaining({ locked: false })]);
  });

  it('reports an error before ready, once, without its text', () => {
    const { win, host } = setup();
    win.dispatchEvent(new win.ErrorEvent('error', { message: 'secret one' }));
    win.dispatchEvent(new win.ErrorEvent('error', { message: 'secret two' }));
    expect(posted(host, 'ax-visual:error')).toEqual([{ type: 'ax-visual:error' }]);
  });

  describe("only the visual's own errors count", () => {
    // What the browser says is running when the error is reported. jsdom runs
    // no page scripts, so the test stands it up.
    function running(win: FrameWindow, script: { src: string } | null): void {
      Object.defineProperty(win.document, 'currentScript', { configurable: true, get: () => script });
    }
    function rejection(win: FrameWindow, reason: unknown): Event {
      const event = new win.Event('unhandledrejection');
      Object.defineProperty(event, 'reason', { value: reason });
      return event;
    }

    // Noir (a Safari dark-mode extension) loads its own script into every
    // frame. A throw from it failed every visual for anyone running it. WebKit
    // reports that throw as a bare "Script error." with no filename, so the
    // running script is what tells it apart.
    it("ignores an error thrown while an extension's script (one with a src) runs", () => {
      const { win, host } = setup();
      running(win, { src: 'safari-web-extension://abc/dist/noirhelper.js' });
      win.dispatchEvent(new win.ErrorEvent('error', { message: 'Script error.' }));
      expect(posted(host, 'ax-visual:error')).toEqual([]);
      // The visual's own inline script failing still fails the card.
      running(win, { src: '' });
      win.dispatchEvent(new win.ErrorEvent('error', { message: 'Script error.' }));
      expect(posted(host, 'ax-visual:error')).toEqual([{ type: 'ax-visual:error' }]);
    });

    it("ignores an error a browser names as an extension's file, and counts one from a timer", () => {
      const { win, host } = setup();
      running(win, null);
      win.dispatchEvent(new win.ErrorEvent('error', { message: 'x', filename: 'chrome-extension://abc/content.js' }));
      win.dispatchEvent(new win.ErrorEvent('error', { message: 'x', filename: 'moz-extension://abc/content.js' }));
      expect(posted(host, 'ax-visual:error')).toEqual([]);
      // No current script and no file: what WebKit says for an agent's timer callback. Counted.
      win.dispatchEvent(new win.ErrorEvent('error', { message: 'Script error.' }));
      expect(posted(host, 'ax-visual:error')).toEqual([{ type: 'ax-visual:error' }]);
    });

    it("ignores a rejection whose stack is only an extension's, and counts the rest", () => {
      const { win, host } = setup();
      const here = win.document.URL;
      win.dispatchEvent(rejection(win, { stack: 'global code@safari-web-extension://abc/dist/x.js:1:25' }));
      expect(posted(host, 'ax-visual:error')).toEqual([]);
      // The visual's own code is on the stack: it called into the extension. Counted.
      win.dispatchEvent(
        rejection(win, { stack: `wrap@chrome-extension://abc/x.js:1:2\nrun@${here}:8:77` }),
      );
      expect(posted(host, 'ax-visual:error')).toHaveLength(1);
    });

    it('counts a rejection with no stack to go on', () => {
      const { win, host } = setup();
      win.dispatchEvent(rejection(win, 'just a string'));
      expect(posted(host, 'ax-visual:error')).toEqual([{ type: 'ax-visual:error' }]);
    });
  });

  it('ignores errors after ready', async () => {
    const { win, host } = setup();
    win.dispatchEvent(new win.Event('load'));
    await frames();
    win.dispatchEvent(new win.ErrorEvent('error', { message: 'late' }));
    expect(posted(host, 'ax-visual:error')).toEqual([]);
  });

  it('applies a theme only from the host', () => {
    const { win, host } = setup();
    const root = win.document.documentElement;
    const msg = {
      type: 'ax-visual:theme',
      mode: 'dark',
      tokens: { '--background': '226.67 15.25% 11.57%' },
    };
    const stranger = new JSDOM('<!doctype html>', {}).window;
    doms.push({ window: stranger });
    sendFrom(win, stranger, msg);
    expect(root.style.getPropertyValue('--background')).toBe('');
    expect(root.dataset.theme).toBe('light');

    const onTheme = vi.fn();
    win.addEventListener('ax:theme', onTheme);
    sendFrom(win, host, msg);
    expect(root.style.getPropertyValue('--background')).toBe('226.67 15.25% 11.57%');
    expect([root.style.colorScheme, root.dataset.theme]).toEqual(['dark', 'dark']);
    expect(onTheme).toHaveBeenCalledTimes(1);
  });

  it('drops theme tokens outside the allow-list or value pattern, and bad modes', () => {
    const { win, host } = setup();
    const root = win.document.documentElement;
    sendFrom(win, host, {
      type: 'ax-visual:theme',
      mode: 'dark',
      tokens: {
        '--evil': '1 2% 3%',
        '--card': 'red;}body{display:none',
        '--radius': '0.5rem',
      },
    });
    expect(root.style.getPropertyValue('--evil')).toBe('');
    expect(root.style.getPropertyValue('--card')).toBe('');
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');

    sendFrom(win, host, { type: 'ax-visual:theme', mode: 'neon', tokens: { '--radius': '1rem' } });
    expect(root.style.getPropertyValue('--radius')).toBe('0.5rem');
    expect(root.dataset.theme).toBe('dark');
  });

  it('accepts every app token name, so its list matches VISUAL_TOKEN_NAMES', () => {
    const { win, host } = setup();
    const tokens = Object.fromEntries(VISUAL_TOKEN_NAMES.map((n) => [n, '1 2% 3%']));
    sendFrom(win, host, { type: 'ax-visual:theme', mode: 'light', tokens });
    for (const n of VISUAL_TOKEN_NAMES) {
      expect(win.document.documentElement.style.getPropertyValue(n)).toBe('1 2% 3%');
    }
    const listed = /var TOKEN_NAMES = \[([^\]]*)\]/.exec(FRAME_RUNTIME_SOURCE)?.[1];
    expect(listed?.match(/'[^']+'/g)?.map((s) => s.slice(1, -1))).toEqual([...VISUAL_TOKEN_NAMES]);
    expect(FRAME_RUNTIME_SOURCE).toContain(`var TOKEN_VALUE = /${VISUAL_TOKEN_VALUE.source}/;`);
  });

  it('answers an export with ok:false when the image helper is missing', () => {
    const { win, host } = setup();
    sendFrom(win, host, { type: 'ax-visual:export', requestId: 'r1', format: 'png' });
    expect(posted(host, 'ax-visual:export-result')).toEqual([
      { type: 'ax-visual:export-result', requestId: 'r1', ok: false },
    ]);
  });

  it('exports the body as PNG with the frame fonts embedded', async () => {
    const blob = { size: 3 };
    const toBlob = vi.fn().mockResolvedValue(blob);
    const { win, host } = setup((w) => {
      w.htmlToImage = { toBlob };
    });
    sendFrom(win, host, { type: 'ax-visual:export', requestId: 'r2', format: 'png' });
    await frames();
    expect(toBlob).toHaveBeenCalledWith(win.document.body, {
      pixelRatio: 2,
      fontEmbedCSS: FONTS_CSS,
      backgroundColor: 'hsl(0 0% 100%)',
    });
    expect(posted(host, 'ax-visual:export-result')).toEqual([
      { type: 'ax-visual:export-result', requestId: 'r2', ok: true, blob },
    ]);
  });

  it('answers ok:false when the export fails, and ignores exports from strangers', async () => {
    const toBlob = vi.fn().mockRejectedValue(new Error('boom'));
    const { win, host } = setup((w) => {
      w.htmlToImage = { toBlob };
    });
    sendFrom(win, null, { type: 'ax-visual:export', requestId: 'x', format: 'png' });
    sendFrom(win, host, { type: 'ax-visual:export', requestId: 'r3', format: 'png' });
    await frames();
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(posted(host, 'ax-visual:export-result')).toEqual([
      { type: 'ax-visual:export-result', requestId: 'r3', ok: false },
    ]);
  });

  it('(RF1) resolves var() colors a model writes into Chart.js options', () => {
    const { win } = setup((w) => {
      w.Chart = { defaults: { font: {}, plugins: { tooltip: {} } }, register: vi.fn(), instances: {} };
    });
    const Chart = win.Chart as {
      defaults: { font: { family?: string; size?: number }; color?: string };
      register: Mock;
    };
    const plugin = Chart.register.mock.calls[0]![0];
    expect(plugin.id).toBe('axTheme');
    const data: { datasets: Record<string, unknown>[] } = {
      datasets: [{ backgroundColor: 'hsl(var(--chart-1))' }, {}],
    };
    plugin.beforeUpdate({ config: { type: 'bar' }, data });
    const bg = (i: number) => data.datasets[i]!.backgroundColor as (ctx: object) => string;
    expect(bg(0)({ datasetIndex: 0, dataIndex: 0 })).toBe('hsl(242.71 63.03% 58.63%)');
    expect(bg(1)({ datasetIndex: 1, dataIndex: 0 })).toBe('hsl(173 80% 29%)');
    expect(Chart.defaults.font.family).toMatch(/^Inter,/);
    expect(Chart.defaults.font.size).toBe(12);
  });

  it('colors pie slices by data index and re-themes live charts', () => {
    const update = vi.fn();
    const { win, host } = setup((w) => {
      w.Chart = {
        defaults: { font: {}, plugins: { tooltip: {} } },
        register: vi.fn(),
        instances: { 0: { update } },
      };
    });
    const plugin = (win.Chart as { register: Mock }).register.mock.calls[0]![0];
    const data: { datasets: Record<string, unknown>[] } = { datasets: [{}] };
    plugin.beforeUpdate({ config: { type: 'doughnut' }, data });
    const bg = data.datasets[0]!.backgroundColor as (ctx: object) => string;
    expect(bg({ datasetIndex: 0, dataIndex: 1 })).toBe('hsl(173 80% 29%)');

    sendFrom(win, host, { type: 'ax-visual:theme', mode: 'dark', tokens: { '--chart-2': '10 20% 30%' } });
    expect(update).toHaveBeenCalledWith('none');
    expect(bg({ datasetIndex: 0, dataIndex: 1 })).toBe('hsl(10 20% 30%)');
  });

  it('resolves var() in any string, keeping a fallback when the token is unset', () => {
    const { win } = setup();
    expect(win.ax.resolve('hsl(var(--chart-1) / 0.5)')).toBe('hsl(242.71 63.03% 58.63% / 0.5)');
    expect(win.ax.resolve('var(--nope, red)')).toBe('red');
    expect(win.ax.chartColor('chart-2')()).toBe('hsl(173 80% 29%)');
  });

  describe('walk fixes (VISUALS-1)', () => {
    type Ctx = { index?: number; dataIndex?: number; datasetIndex?: number };
    function withChart(instances: Record<string, unknown> = {}) {
      const { win, host } = setup((w) => {
        w.Chart = { defaults: { font: {}, plugins: { tooltip: {} } }, register: vi.fn(), instances };
      });
      const plugin = (win.Chart as { register: Mock }).register.mock.calls[0]![0] as {
        beforeUpdate(chart: unknown): void;
      };
      return { win, host, plugin };
    }

    it('(1a) resolves an array of ax.chartColor functions and var() strings per data point', () => {
      const { win, plugin } = withChart();
      const colors = [win.ax.chartColor('chart-1'), 'hsl(var(--chart-2))', 'plain-red'];
      const data: { datasets: Record<string, unknown>[] } = {
        datasets: [{ backgroundColor: colors, hoverBackgroundColor: [win.ax.chartColor('chart-2')] }],
      };
      const chart = { config: { type: 'bar' }, data };
      plugin.beforeUpdate(chart);
      const bg = data.datasets[0]!.backgroundColor as (ctx: Ctx) => string;
      expect(typeof bg).toBe('function');
      const at = (i: number) => ({ datasetIndex: 0, dataIndex: i, index: i });
      expect(bg(at(0))).toBe('hsl(242.71 63.03% 58.63%)');
      expect(bg(at(1))).toBe('hsl(173 80% 29%)');
      expect(bg(at(2))).toBe('plain-red');
      expect(bg(at(3))).toBe('hsl(242.71 63.03% 58.63%)'); // index % length, like Chart.js
      const hover = data.datasets[0]!.hoverBackgroundColor as (ctx: Ctx) => string;
      expect(hover(at(5))).toBe('hsl(173 80% 29%)');

      // Idempotent: a second update doesn't wrap the wrapper.
      plugin.beforeUpdate(chart);
      expect(data.datasets[0]!.backgroundColor).toBe(bg);
    });

    it('(1b) ax.color and ax.chartColor take an optional alpha, clamped to [0, 1]', () => {
      const { win } = setup();
      const color = win.ax.color as (name: string, alpha?: unknown) => string;
      const chartColor = win.ax.chartColor as (name: string, alpha?: unknown) => () => string;
      expect(color('chart-1', 0.5)).toBe('hsl(242.71 63.03% 58.63% / 0.5)');
      expect(color('chart-1', 2)).toBe('hsl(242.71 63.03% 58.63% / 1)');
      expect(color('chart-1', -1)).toBe('hsl(242.71 63.03% 58.63% / 0)');
      expect(color('chart-1', Number.NaN)).toBe('hsl(242.71 63.03% 58.63%)');
      expect(color('chart-1', '0.5')).toBe('hsl(242.71 63.03% 58.63%)');
      expect(chartColor('chart-2', 0.75)()).toBe('hsl(173 80% 29% / 0.75)');
    });

    it('(2) re-themes color strings the agent captured from ax.color at startup', () => {
      const update = vi.fn();
      const instance: Record<string, unknown> = { update };
      const { win, host } = withChart({ 0: instance });
      const border = win.ax.color('chart-2');
      const faint = (win.ax.color as (n: string, a: number) => string)('chart-1', 0.3);
      const options = {
        scales: { y: { grid: { color: border }, ticks: { color: faint, callback: () => 'x' } } },
        plugins: { legend: { labels: { color: 'hsl(1 2% 3%)' } } },
      };
      const datasets = [{ borderColor: border, backgroundColor: [faint, 'plain'], data: [1, 2] }];
      Object.assign(instance, { config: { options }, options, data: { datasets } });

      sendFrom(win, host, {
        type: 'ax-visual:theme',
        mode: 'dark',
        tokens: { '--chart-2': '10 20% 30%', '--chart-1': '40 50% 60%' },
      });
      expect(options.scales.y.grid.color).toBe('hsl(10 20% 30%)');
      expect(options.scales.y.ticks.color).toBe('hsl(40 50% 60% / 0.3)');
      expect(options.plugins.legend.labels.color).toBe('hsl(1 2% 3%)'); // not one of ours
      expect(datasets[0]!.borderColor).toBe('hsl(10 20% 30%)');
      expect(datasets[0]!.backgroundColor).toEqual(['hsl(40 50% 60% / 0.3)', 'plain']);
      expect(update).toHaveBeenCalledWith('none');

      // And back again: the dark strings are remembered too.
      sendFrom(win, host, {
        type: 'ax-visual:theme',
        mode: 'light',
        tokens: { '--chart-2': '173 80% 29%', '--chart-1': '242.71 63.03% 58.63%' },
      });
      expect(options.scales.y.grid.color).toBe(border);
    });

    it('(2b) re-themes hsl() strings built from an old token value, keeping alpha; leaves others alone', () => {
      const update = vi.fn();
      const instance: Record<string, unknown> = { update };
      const { win, host } = withChart({ 0: instance });
      // What an agent's own cssVar() helper builds: getComputedStyle, not ax.color.
      const raw = (name: string) => win.getComputedStyle(win.document.documentElement).getPropertyValue(name).trim();
      const grid = 'hsl(' + raw('--chart-2') + ')';
      expect(grid).toBe('hsl(173 80% 29%)');
      const options = {
        scales: {
          y: { grid: { color: grid }, ticks: { color: 'hsl(242.71, 63.03%, 58.63%)' } },
          x: { grid: { color: 'hsl(173 80% 29%/0.4)' }, ticks: { color: 'hsl( 173  80%  29% / 0.25 )' } },
        },
        plugins: { legend: { labels: { color: 'hsl(10 20% 30%)' } }, title: { color: 'red' } },
      };
      const datasets = [{ borderColor: 'hsl(173 80% 29%)', backgroundColor: ['hsl(242.71 63.03% 58.63%)', 'blue'] }];
      Object.assign(instance, { config: { options }, options, data: { datasets } });

      sendFrom(win, host, {
        type: 'ax-visual:theme',
        mode: 'dark',
        tokens: { '--chart-2': '11 22% 33%', '--chart-1': '44 55% 66%' },
      });
      expect(options.scales.y.grid.color).toBe('hsl(11 22% 33%)');
      expect(options.scales.y.ticks.color).toBe('hsl(44 55% 66%)');
      expect(options.scales.x.grid.color).toBe('hsl(11 22% 33% / 0.4)');
      expect(options.scales.x.ticks.color).toBe('hsl(11 22% 33% / 0.25)');
      expect(options.plugins.legend.labels.color).toBe('hsl(10 20% 30%)'); // a custom color, untouched
      expect(options.plugins.title.color).toBe('red');
      expect(datasets[0]!.borderColor).toBe('hsl(11 22% 33%)');
      expect(datasets[0]!.backgroundColor).toEqual(['hsl(44 55% 66%)', 'blue']);
    });

    it('(2b) breaks ties between tokens sharing an old value: shared new value, else the earliest token', () => {
      const instance: Record<string, unknown> = { update: vi.fn() };
      const { win, host } = withChart({ 0: instance });
      const options = { a: 'hsl(5 5% 5%)', b: 'hsl(7 7% 7%)' };
      Object.assign(instance, { config: { options }, options, data: { datasets: [] } });
      sendFrom(win, host, {
        type: 'ax-visual:theme',
        mode: 'light',
        tokens: {
          '--card': '5 5% 5%', '--popover': '5 5% 5%', '--muted': '5 5% 5%',
          '--accent': '7 7% 7%', '--destructive': '7 7% 7%',
        },
      });
      sendFrom(win, host, {
        type: 'ax-visual:theme',
        mode: 'dark',
        tokens: {
          // card differs; popover and muted agree, so either one gives the same answer.
          '--card': '1 1% 1%', '--popover': '2 2% 2%', '--muted': '2 2% 2%',
          // No agreement: the earlier token in the list (--accent) wins.
          '--accent': '3 3% 3%', '--destructive': '4 4% 4%',
        },
      });
      expect(options).toEqual({ a: 'hsl(2 2% 2%)', b: 'hsl(3 3% 3%)' });
    });
  });

  describe('(BUG-2) charts that measured an empty frame get resized', () => {
    // A frame isolated in its own process can parse before its size arrives,
    // so Chart.js measures 0; its own resize path needs rAF, which doesn't run
    // offscreen. jsdom has no layout: the container's width is set by hand.
    // `target` is what Chart.js's own measurement (platform.getMaximumSize)
    // says the chart should be: the container minus canvas margin, padding,
    // border and max-width. A function, so a test can change it later.
    interface StubChart {
      width: number;
      canvas: HTMLCanvasElement;
      options: { responsive?: boolean };
      platform: { getMaximumSize: Mock };
      resize: Mock;
      stop: Mock;
    }
    function chartIn(
      win: FrameWindow,
      width: number,
      target: number | (() => number),
      responsive = true,
    ): StubChart {
      const box = win.document.createElement('div');
      // The container's own width never decides anything: only Chart.js's measure.
      Object.defineProperty(box, 'clientWidth', { get: () => 999, configurable: true });
      const canvas = win.document.createElement('canvas');
      box.appendChild(canvas);
      win.document.body.appendChild(box);
      const measure = typeof target === 'function' ? target : () => target;
      return {
        width,
        canvas,
        options: { responsive },
        platform: { getMaximumSize: vi.fn(() => ({ width: measure(), height: 200 })) },
        resize: vi.fn(),
        stop: vi.fn(),
      };
    }
    function withCharts(make: (win: FrameWindow) => StubChart[]) {
      let charts: StubChart[] = [];
      const { win, host } = setup((w) => {
        charts = make(w);
        w.Chart = {
          defaults: { font: {}, plugins: { tooltip: {} } },
          register: vi.fn(),
          instances: Object.fromEntries(charts.map((c, i) => [i, c])),
        };
      });
      return { win, host, charts };
    }

    it('resizes a 0-width or wrongly sized responsive chart once ready, and leaves the rest', async () => {
      const { win, charts } = withCharts((w) => {
        const broken = chartIn(w, 0, 572);
        broken.platform.getMaximumSize.mockImplementation(() => {
          throw new Error('no measure');
        });
        return [
          chartIn(w, 0, 0), // nothing to measure yet: a resize would change nothing
          chartIn(w, 0, 572),
          chartIn(w, 300, 572),
          chartIn(w, 572, 572), // right already
          chartIn(w, 571, 572), // within a pixel
          chartIn(w, 600, 572, false), // responsive: false keeps its own size
          chartIn(w, 400, 400), // narrower than its box by Chart.js's own measure (max-width)
          broken, // measure throws: falls back to "0 wide means refit"
        ];
      });
      win.dispatchEvent(new win.Event('load'));
      await frames();
      expect(charts.map((c) => c.resize.mock.calls.length > 0)).toEqual([
        false, true, true, false, false, false, false, true,
      ]);
      // stop() only where the size will really change: it freezes animations.
      expect(charts.map((c) => c.stop.mock.calls.length > 0)).toEqual([
        false, true, true, false, false, false, false, true,
      ]);
      // A running intro animation would only queue the resize: stopped first.
      const refit = charts[1]!;
      expect(refit.stop.mock.invocationCallOrder[0]!).toBeLessThan(refit.resize.mock.invocationCallOrder[0]!);
    });

    it('keeps checking on the timer after ready, so a chart that goes wrong later is fixed', async () => {
      let container = 572;
      const { win, charts } = withCharts((w) => [chartIn(w, 572, () => container)]);
      win.dispatchEvent(new win.Event('load'));
      await frames();
      expect(charts[0]!.resize).not.toHaveBeenCalled();
      container = 400;
      await new Promise((r) => setTimeout(r, 1300));
      expect(charts[0]!.resize).toHaveBeenCalled();
    });

    it('resizes on ax-visual:visible from the host only', () => {
      const { win, host, charts } = withCharts((w) => [chartIn(w, 0, 572)]);
      const stranger = new JSDOM('<!doctype html>', {}).window;
      doms.push({ window: stranger });
      sendFrom(win, stranger, { type: 'ax-visual:visible' });
      sendFrom(win, null, { type: 'ax-visual:visible' });
      expect(charts[0]!.resize).not.toHaveBeenCalled();
      sendFrom(win, host, { type: 'ax-visual:visible' });
      expect(charts[0]!.resize).toHaveBeenCalledTimes(1);
    });

    it('a Chart.instances that throws on enumeration is survived', () => {
      const { win, host } = setup((w) => {
        w.Chart = {
          defaults: { font: {}, plugins: { tooltip: {} } },
          register: vi.fn(),
          get instances() {
            throw new Error('hostile');
          },
        };
      });
      expect(() => sendFrom(win, host, { type: 'ax-visual:visible' })).not.toThrow();
    });

    it('a chart whose resize throws does not stop the others', () => {
      const { win, host, charts } = withCharts((w) => [chartIn(w, 0, 572), chartIn(w, 0, 572)]);
      charts[0]!.resize.mockImplementation(() => {
        throw new Error('boom');
      });
      sendFrom(win, host, { type: 'ax-visual:visible' });
      expect(charts[1]!.resize).toHaveBeenCalledTimes(1);
    });
  });

  describe('(BUG-3) a visual never navigates itself', () => {
    function click(win: FrameWindow, el: Element, type = 'click'): boolean {
      const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'auxclick' ? 1 : 0 });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    }

    it('cancels clicks on links (html a, area, svg a, nested content), and nothing else', () => {
      const { win } = setup((w) => {
        w.document.body.innerHTML =
          '<a id="a" href="https://example.com/x"><span id="inner">open</span></a>' +
          '<map name="m"><area id="area" href="https://example.com/y" shape="rect" coords="0,0,1,1"></map>' +
          '<svg><a id="svga" href="https://example.com/z"><text id="svgtext">z</text></a></svg>' +
          '<a id="noref">no href</a><button id="btn">ok</button>';
      });
      const $ = (id: string) => win.document.getElementById(id)!;
      expect(click(win, $('a'))).toBe(true);
      expect(click(win, $('inner'))).toBe(true);
      expect(click(win, $('a'), 'auxclick')).toBe(true);
      expect(click(win, $('area'))).toBe(true);
      expect(click(win, $('svga'))).toBe(true);
      expect(click(win, $('svgtext'))).toBe(true);
      expect(click(win, $('noref'))).toBe(false);
      expect(click(win, $('btn'))).toBe(false);
    });

    it("can't be switched off by agent code", () => {
      const { win } = setup((w) => {
        w.document.body.innerHTML = '<a id="a" href="https://example.com/x">open</a>';
      });
      win.eval(
        // Guessed handlers can't remove a listener it never sees, and a later
        // capture listener on window runs after ours.
        'document.removeEventListener("click", function () {}, true);' +
          'window.removeEventListener("click", function () {}, true);' +
          'window.addEventListener("click", function (e) { e.stopImmediatePropagation(); }, true);' +
          'EventTarget.prototype.addEventListener = function () {};' +
          'Event.prototype.preventDefault = function () {};',
      );
      expect(click(win, win.document.getElementById('a')!)).toBe(true);
    });

    it('cancels form submits', () => {
      const { win } = setup((w) => {
        w.document.body.innerHTML = '<form id="f" action="https://example.com/f"><input name="a"></form>';
      });
      const ev = new win.Event('submit', { bubbles: true, cancelable: true });
      win.document.getElementById('f')!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });
  });

  it('removes WebRTC for good before anything else runs', () => {
    const { win } = setup((w) => {
      (w as unknown as Record<string, unknown>).RTCPeerConnection = function RTCPeerConnection() {};
    });
    expect(win.RTCPeerConnection).toBeUndefined();
    expect(win.eval('Reflect.deleteProperty(window, "RTCPeerConnection")')).toBe(false);
    for (const name of [
      'RTCPeerConnection',
      'webkitRTCPeerConnection',
      'RTCDataChannel',
      'RTCSessionDescription',
      'RTCIceCandidate',
    ]) {
      expect(Object.getOwnPropertyDescriptor(win, name)).toMatchObject({
        value: undefined,
        // Writable so an extension's wrapper doesn't throw; see frame-guard.js.
        writable: true,
        configurable: false,
      });
    }
    expect(win.RTCPeerConnection).toBeUndefined();
    expect(win.eval('typeof RTCPeerConnection')).toBe('undefined');
    expect(win.eval('typeof webkitRTCPeerConnection')).toBe('undefined');
  });
});

describe('frame runtime: no child frames', () => {
  const microtask = () => new Promise<void>((r) => queueMicrotask(r));

  it('removes frame-making elements a script inserts, before the next task', async () => {
    const { win } = setup();
    const doc = win.document;
    const iframe = doc.createElement('iframe');
    iframe.srcdoc = '<script>top.postMessage(1, "*")</script>';
    doc.body.appendChild(iframe);
    const wrap = doc.createElement('div');
    wrap.innerHTML = '<span><object data="data:text/html,x"></object><embed src="data:text/html,x"><frame></span>';
    doc.body.appendChild(wrap);
    doc.body.insertAdjacentHTML('beforeend', '<iframe src="javascript:1"></iframe>');
    await microtask();
    expect(doc.querySelectorAll('iframe,object,embed,frame')).toHaveLength(0);
    expect(wrap.querySelector('span')).not.toBeNull();
  });

  it("can't be blinded by patching Element.prototype.remove or NodeList", async () => {
    const { win } = setup();
    win.eval(
      'Element.prototype.remove = function () {};' +
        'Object.defineProperty(NodeList.prototype, "length", { get() { return 0; } });' +
        'document.body.appendChild(document.createElement("iframe"));',
    );
    await microtask();
    expect(win.document.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('makes attachShadow, setHTMLUnsafe and document.write throw, for good', () => {
    const { win } = setup();
    const div = win.document.createElement('div');
    expect(() => div.attachShadow({ mode: 'open' })).toThrow();
    expect(() => win.eval('document.body.setHTMLUnsafe("<p>")')).toThrow();
    expect(() => win.eval('Document.parseHTMLUnsafe("<p>")')).toThrow();
    expect(() => win.document.write('<iframe></iframe>')).toThrow();
    expect(() => win.eval('Document.prototype.writeln.call(document, "x")')).toThrow();
    expect(Object.getOwnPropertyDescriptor(win.Element.prototype, 'attachShadow')).toMatchObject({
      writable: true,
      configurable: false,
    });
    // Writing over it gets nothing back: the original is gone from the realm.
    win.eval('Element.prototype.attachShadow = HTMLElement.prototype.click;');
    div.attachShadow({ mode: 'closed' });
    expect(div.shadowRoot).toBeNull();
    expect(() => win.eval('Element.prototype.attachShadow = undefined; document.body.attachShadow({ mode: "open" })')).toThrow();
  });
});

describe('frame runtime: shadow roots, child windows, kill switch', () => {
  const microtask = () => new Promise<void>((r) => queueMicrotask(r));
  type Loose = FrameWindow & Record<string, unknown>;

  it('removes any inserted element that hosts an open shadow root, nested or not', async () => {
    const { win } = setup((w) => {
      // Made before the runtime locks attachShadow, as another API could.
      const a = w.document.createElement('div');
      a.attachShadow({ mode: 'open' });
      const b = w.document.createElement('span');
      b.attachShadow({ mode: 'open' });
      const wrap = w.document.createElement('section');
      wrap.appendChild(b);
      Object.assign(w, { __a: a, __wrap: wrap, __b: b });
    });
    const loose = win as Loose;
    win.document.body.append(loose.__a as Node, loose.__wrap as Node);
    await microtask();
    expect((loose.__a as Node).isConnected).toBe(false);
    expect((loose.__b as Node).isConnected).toBe(false);
    expect((loose.__wrap as Node).isConnected).toBe(true);
  });

  it('locks setHTML, parseHTML and XSLTProcessor', () => {
    const { win } = setup();
    expect(() => win.eval('document.body.setHTML("<p>")')).toThrow();
    expect(() => win.eval('Document.parseHTML("<p>")')).toThrow();
    expect(win.eval('typeof XSLTProcessor')).toBe('undefined');
  });

  it("answers null from the child-window getters (defense in depth)", () => {
    const { win } = setup((w) => {
      w.document.body.appendChild(w.document.createElement('iframe'));
    });
    const iframe = win.document.querySelector('iframe')!;
    expect(iframe.contentWindow).toBeNull();
    expect(iframe.contentDocument).toBeNull();
    const objectEl = win.document.createElement('object');
    expect(objectEl.contentWindow).toBeNull();
    expect(objectEl.getSVGDocument()).toBeNull();
    expect((win.document.createElement('embed') as unknown as { getSVGDocument(): unknown }).getSVGDocument()).toBeNull();
  });

  it('kills the document on the next frame when a child frame exists anyway', async () => {
    const { win, host } = setup((w) => {
      // Present before the observer, like one hidden in a closed shadow root.
      w.document.body.appendChild(w.document.createElement('iframe'));
    });
    expect(win.length).toBe(1);
    await frames();
    expect(win.document.documentElement).toBeNull();
    expect(win.length).toBe(0);
    expect(posted(host, 'ax-visual:error')).toEqual([{ type: 'ax-visual:error' }]);
    win.dispatchEvent(new win.Event('load'));
    await frames();
    expect(posted(host, 'ax-visual:ready')).toEqual([]);
  });

  it('keeps guarding after a kill: purges new frames and removes a new root', async () => {
    const { win, host } = setup((w) => {
      w.document.body.appendChild(w.document.createElement('iframe'));
    });
    await frames();
    expect(win.document.documentElement).toBeNull();

    const html = win.document.createElement('html');
    const iframe = win.document.createElement('iframe');
    html.appendChild(iframe);
    win.document.appendChild(html);
    await microtask();
    expect(iframe.isConnected).toBe(false);
    expect(win.document.documentElement).toBeNull();

    // A root that arrives with no frame in it goes too, on the next check.
    win.document.appendChild(win.document.createElement('html'));
    await frames();
    expect(win.document.documentElement).toBeNull();
    // Reporting stopped after the one error.
    expect(posted(host, 'ax-visual:error')).toHaveLength(1);
    sendFrom(win, host, { type: 'ax-visual:export', requestId: 'late', format: 'png' });
    expect(posted(host, 'ax-visual:export-result')).toEqual([]);
  });

  it('checks the child count right after each purge, with the original getter', async () => {
    let children = 0;
    const { win, host } = setup((w) => {
      Object.defineProperty(w, 'length', { get: () => children, configurable: true });
    });
    // Agent code shadowing window.length can't hide a child.
    win.eval('try { Object.defineProperty(window, "length", { get: () => 0 }) } catch {}');
    children = 1;
    win.document.body.appendChild(win.document.createElement('div'));
    await microtask();
    expect(win.document.documentElement).toBeNull();
    expect(posted(host, 'ax-visual:error')).toEqual([{ type: 'ax-visual:error' }]);
  });
});

describe('DEFAULT_VISUAL_ASSETS', () => {
  it('bundles the fonts, libraries and runtime', () => {
    expect(DEFAULT_VISUAL_ASSETS).toEqual({
      fontFaceCss: VISUAL_FONT_FACE_CSS,
      librarySources: VISUAL_LIBRARY_SOURCES,
      runtimeSource: FRAME_RUNTIME_SOURCE,
    });
    expect(FRAME_RUNTIME_SOURCE).toContain('window.axVisualRuntime = function axVisualRuntime(');
  });
});
