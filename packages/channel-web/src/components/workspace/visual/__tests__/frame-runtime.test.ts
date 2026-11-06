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

  it('removes WebRTC for good before anything else runs', () => {
    const { win } = setup((w) => {
      (w as unknown as Record<string, unknown>).RTCPeerConnection = function RTCPeerConnection() {};
    });
    expect(win.RTCPeerConnection).toBeUndefined();
    win.eval('window.RTCPeerConnection = function () {}; delete window.RTCPeerConnection;');
    expect(() => win.eval('"use strict"; window.RTCPeerConnection = function () {};')).toThrow();
    for (const name of [
      'RTCPeerConnection',
      'webkitRTCPeerConnection',
      'RTCDataChannel',
      'RTCSessionDescription',
      'RTCIceCandidate',
    ]) {
      expect(Object.getOwnPropertyDescriptor(win, name)).toMatchObject({
        value: undefined,
        writable: false,
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
    win.eval('try { Element.prototype.attachShadow = HTMLElement.prototype.click; } catch {}');
    expect(() => div.attachShadow({ mode: 'closed' })).toThrow();
    expect(Object.getOwnPropertyDescriptor(win.Element.prototype, 'attachShadow')).toMatchObject({
      writable: false,
      configurable: false,
    });
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
