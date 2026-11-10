import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { CHILD_FRAME_TAGS, FRAME_GUARD_SOURCE } from '../index.js';

// The guard is a browser script, so it is exercised the way a browser would:
// evaluated in a jsdom window, then poked from inside that window. Every
// `win.eval` below runs in a throwaway jsdom window (runScripts: 'outside-only')
// that this file owns and closes; nothing evaluates in the test process. The
// hostile-looking strings (iframes, document.write, innerHTML) are the inputs
// the guard exists to refuse, aimed at the guard. jsdom ships no types and we
// don't add @types/jsdom for one test file: describe just the slice we use.
interface GuardHandle {
  check(): void;
  slowTimer(): void;
  isLocked(): boolean;
  isKilled(): boolean;
}
interface GuardOpts {
  onKill?: () => void;
  onTick?: () => void;
  refusalMessage?: string;
}
interface GuardWindow {
  eval(code: string): unknown;
  close(): void;
  axFrameGuard(win: GuardWindow, opts?: GuardOpts): GuardHandle;
  setInterval: (...args: unknown[]) => unknown;
  clearInterval: (...args: unknown[]) => unknown;
  requestAnimationFrame: unknown;
}
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: GuardWindow };
  VirtualConsole: new () => { on(event: string, listener: (error: Error) => void): void };
};

const windows: GuardWindow[] = [];
/** What each window reported as an uncaught error (jsdom would print it otherwise). */
const uncaught = new WeakMap<GuardWindow, string[]>();
afterEach(() => {
  for (const w of windows.splice(0)) w.close();
});

/** A fresh window with the guard evaluated into it (not yet started). */
function windowWithGuard(before?: (win: GuardWindow) => void): GuardWindow {
  const reported: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => reported.push(error.message));
  const win = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  }).window;
  uncaught.set(win, reported);
  windows.push(win);
  before?.(win);
  win.eval(FRAME_GUARD_SOURCE);
  return win;
}

function started(opts?: GuardOpts, before?: (win: GuardWindow) => void): { win: GuardWindow; guard: GuardHandle } {
  const win = windowWithGuard(before);
  return { win, guard: win.axFrameGuard(win, opts) };
}

const microtask = () => new Promise<void>((r) => queueMicrotask(r));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * Waits for `done`, up to `ms`. For something that should happen, so a slow
 * machine costs time instead of a false failure; the assertion after it is
 * what fails. Something that should NOT happen still needs a fixed `wait`.
 */
async function until(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await wait(10);
}
const gone = (win: GuardWindow) => () => win.eval('document.documentElement') === null;

describe('FRAME_GUARD_SOURCE as a script', () => {
  it('cannot end or reshape the <script> element it is inlined into', () => {
    expect(FRAME_GUARD_SOURCE.toLowerCase()).not.toContain('</script');
    expect(FRAME_GUARD_SOURCE).not.toContain('<!--');
  });

  it('is plain script text: no imports or exports, one global', () => {
    expect(FRAME_GUARD_SOURCE).not.toMatch(/^\s*(import|export)\s/m);
    expect(FRAME_GUARD_SOURCE).toContain('window.axFrameGuard = function axFrameGuard(');
  });

  it('evaluates in jsdom, defines axFrameGuard, and touches nothing until it is called', () => {
    const win = windowWithGuard((w) => {
      w.eval('window.RTCPeerConnection = function RTCPeerConnection() {};');
    });
    expect(win.eval('typeof axFrameGuard')).toBe('function');
    expect(win.eval('typeof RTCPeerConnection')).toBe('function');
  });
});

describe('FRAME_GUARD_SOURCE as a package file', () => {
  const pkgDir = new URL('../../', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', pkgDir), 'utf8')) as {
    exports: Record<string, unknown>;
    files: string[];
  };

  it('is the file the ./frame-guard.js export serves, and package.json ships it', () => {
    const target = pkg.exports['./frame-guard.js'];
    expect(typeof target).toBe('string');
    expect(readFileSync(new URL(target as string, pkgDir), 'utf8')).toBe(FRAME_GUARD_SOURCE);
    expect(pkg.files).toContain((target as string).replace(/^\.\//, ''));
  });

  // The compiled package reads the same file: a bare `tsc --build` is all CI
  // and the image run, so there must be no copy step to forget. Needs dist/,
  // which `pnpm typecheck` (CI) and any build produce before tests run.
  const built = new URL('dist/index.js', pkgDir);
  it.skipIf(!existsSync(built))('reads that same file when run from dist/', async () => {
    const compiled = (await import(built.href)) as { FRAME_GUARD_SOURCE: string };
    expect(compiled.FRAME_GUARD_SOURCE).toBe(FRAME_GUARD_SOURCE);
  });

  it('keeps its in-page child-frame selector in step with CHILD_FRAME_TAGS (minus noscript)', () => {
    // <noscript> is a hazard for a parser that scripts off; in a live frame it
    // is raw text, so the in-page selector has no use for it.
    const listed = /var CHILD_FRAMES = '([^']*)';/.exec(FRAME_GUARD_SOURCE)?.[1];
    expect(listed).toBeDefined();
    expect(listed!.split(',').sort()).toEqual(CHILD_FRAME_TAGS.filter((t) => t !== 'noscript').sort());
  });
});

describe('axFrameGuard: locks', () => {
  it('pins the WebRTC constructors and XSLTProcessor to undefined, for good', () => {
    const { win, guard } = started({}, (w) => {
      w.eval(
        'window.RTCPeerConnection = function () {};' +
          'window.webkitRTCPeerConnection = function () {};' +
          'window.RTCDataChannel = function () {};' +
          'window.XSLTProcessor = function () {};',
      );
    });
    expect(guard.isLocked()).toBe(true);
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'XSLTProcessor']) {
      expect(win.eval(`typeof ${name}`), name).toBe('undefined');
      // Writable (an extension's wrapper must not throw), never configurable.
      expect(win.eval(`JSON.stringify(Object.getOwnPropertyDescriptor(window, ${JSON.stringify(name)}))`), name).toBe(
        JSON.stringify({ writable: true, enumerable: false, configurable: false }),
      );
    }
    // Agent code can't delete one or turn it into an accessor.
    expect(win.eval('Reflect.deleteProperty(window, "RTCPeerConnection")')).toBe(false);
    expect(() => win.eval('Object.defineProperty(window, "RTCPeerConnection", { get() { return 1; } })')).toThrow();
    expect(win.eval('typeof RTCPeerConnection')).toBe('undefined');
  });

  it('refuses the APIs that build shadow roots or parse markup out of the observer sight', () => {
    const { win } = started();
    expect(() => win.eval('document.body.attachShadow({ mode: "closed" })')).toThrow();
    expect(() => win.eval('document.body.setHTMLUnsafe("<p>")')).toThrow();
    expect(() => win.eval('Document.parseHTMLUnsafe("<p>")')).toThrow();
    expect(() => win.eval('document.write("<iframe></iframe>")')).toThrow();
    expect(() => win.eval('document.writeln("x")')).toThrow();
    expect(() => win.eval('document.open()')).toThrow();
    // Writing something else over a lock gets nothing back: the original is
    // gone from the realm, and what's written isn't it.
    win.eval('Element.prototype.attachShadow = HTMLElement.prototype.click;');
    expect(win.eval('document.body.attachShadow({ mode: "open" }) === undefined && document.body.shadowRoot')).toBeNull();
  });

  // Noir, a Safari dark-mode extension, loads a script into every frame that
  // wraps attachShadow like this (measured 2026-11-09: its noirhelper.js). With
  // read-only locks the redefinition threw, and that failed every chat visual
  // for anyone running it.
  it("lets an extension wrap a locked API without throwing, and the API stays refused", () => {
    const { win, guard } = started();
    expect(() =>
      win.eval(
        'var d = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");' +
          'Object.defineProperty(Element.prototype, "attachShadow", Object.assign({}, d, {' +
          '  value: function (o) { return d.value.call(this, o); },' +
          '}));' +
          'var w = Object.getOwnPropertyDescriptor(Document.prototype, "write");' +
          'Object.defineProperty(Document.prototype, "write", Object.assign({}, w, { value: function () { return w.value.apply(this, arguments); } }));' +
          'var r = Object.getOwnPropertyDescriptor(window, "RTCPeerConnection");' +
          'Object.defineProperty(window, "RTCPeerConnection", Object.assign({}, r, { value: r.value }));',
      ),
    ).not.toThrow();
    expect(() => win.eval('document.body.attachShadow({ mode: "closed" })')).toThrow('Not available in this frame.');
    expect(() => win.eval('document.write("<iframe></iframe>")')).toThrow('Not available in this frame.');
    expect(win.eval('typeof RTCPeerConnection')).toBe('undefined');
    expect(guard.isLocked()).toBe(true);
  });

  it('says what it refused with a neutral message unless the caller gives its own', () => {
    const plain = started().win;
    expect(() => plain.eval('document.body.attachShadow({ mode: "open" })')).toThrow('Not available in this frame.');
    const custom = started({ refusalMessage: 'Not available in a chat visual.' }).win;
    expect(() => custom.eval('document.body.attachShadow({ mode: "open" })')).toThrow('Not available in a chat visual.');
    // Not a string, or empty: the neutral message, not a blank one.
    const odd = started({ refusalMessage: '' }).win;
    expect(() => odd.eval('document.body.attachShadow({ mode: "open" })')).toThrow('Not available in this frame.');
  });

  it('answers null from the child-window getters (defense in depth)', () => {
    const { win } = started();
    win.eval('document.body.appendChild(document.createElement("object"))');
    expect(win.eval('document.createElement("iframe").contentWindow')).toBeNull();
    expect(win.eval('document.createElement("iframe").contentDocument')).toBeNull();
    expect(win.eval('document.createElement("object").contentWindow')).toBeNull();
    expect(win.eval('document.createElement("object").getSVGDocument()')).toBeNull();
    expect(win.eval('document.createElement("embed").getSVGDocument()')).toBeNull();
  });

  it('records a lock it could not install, instead of swallowing it', () => {
    const { guard } = started({}, (w) => {
      w.eval('Object.defineProperty(window, "RTCPeerConnection", { value: function () {}, configurable: false })');
    });
    expect(guard.isLocked()).toBe(false);
  });

  it('records it too when a primitive it needs to see children with is missing', () => {
    const { guard } = started({}, (w) => {
      w.eval('delete window.MutationObserver');
    });
    expect(guard.isLocked()).toBe(false);
  });
});

describe('axFrameGuard: child frames', () => {
  it('removes frame-making elements a script inserts, before the next task', async () => {
    const { win } = started();
    win.eval(
      'var f = document.createElement("iframe"); f.srcdoc = "<p>x</p>"; document.body.appendChild(f);' +
        'var w = document.createElement("div"); w.innerHTML = "<span><object></object><embed><frame></span>"; document.body.appendChild(w);' +
        'document.body.insertAdjacentHTML("beforeend", "<iframe src=\\"javascript:1\\"></iframe>");',
    );
    await microtask();
    expect(win.eval('document.querySelectorAll("iframe,object,embed,frame").length')).toBe(0);
    expect(win.eval('document.querySelectorAll("span").length')).toBe(1);
  });

  it("can't be blinded by patching the primitives it uses", async () => {
    const { win } = started();
    win.eval(
      'Element.prototype.remove = function () {};' +
        'Element.prototype.matches = function () { return false; };' +
        'Object.defineProperty(NodeList.prototype, "length", { get() { return 0; } });' +
        'document.body.appendChild(document.createElement("iframe"));',
    );
    await microtask();
    expect(win.eval('document.querySelectorAll("iframe").length')).toBe(0);
  });

  it('removes an element hosting an open shadow root made before the lock', async () => {
    const { win } = started({}, (w) => {
      w.eval('window.__host = document.createElement("div"); window.__host.attachShadow({ mode: "open" });');
    });
    win.eval('document.body.appendChild(window.__host)');
    await microtask();
    expect(win.eval('window.__host.isConnected')).toBe(false);
  });

  it('kills the document and calls onKill once when a child frame exists anyway', async () => {
    const kills: string[] = [];
    const { win, guard } = started({ onKill: () => kills.push('kill') }, (w) => {
      // Present before the observer, like one hidden in a closed shadow root.
      w.eval('document.body.appendChild(document.createElement("iframe"))');
    });
    expect(win.eval('window.length')).toBe(1);
    expect(guard.isKilled()).toBe(false);
    await until(() => guard.isKilled());
    expect(win.eval('document.documentElement')).toBeNull();
    expect(win.eval('window.length')).toBe(0);
    expect(guard.isKilled()).toBe(true);
    expect(kills).toEqual(['kill']);
  });

  it('keeps guarding after a kill: a new root goes too, and onKill is not called again', async () => {
    const kills: string[] = [];
    const { win } = started({ onKill: () => kills.push('kill') }, (w) => {
      w.eval('document.body.appendChild(document.createElement("iframe"))');
    });
    await until(gone(win));
    expect(win.eval('document.documentElement')).toBeNull();

    win.eval('document.appendChild(document.createElement("html"))');
    await until(() => win.eval('document.documentElement') === null);
    // A few more frames, to be sure nothing calls onKill a second time.
    await wait(100);
    expect(win.eval('document.documentElement')).toBeNull();
    expect(kills).toEqual(['kill']);
  });

  it('survives an onKill that throws: the per-frame check keeps being scheduled', async () => {
    let frames = 0;
    const { win, guard } = started(
      {
        onKill() {
          throw new Error('consumer bug');
        },
      },
      (w) => {
        const realFrame = (w.requestAnimationFrame as (cb: () => void) => unknown).bind(w);
        w.requestAnimationFrame = (cb: () => void) => {
          frames += 1;
          return realFrame(cb);
        };
        w.eval('document.body.appendChild(document.createElement("iframe"))');
      },
    );
    await until(() => guard.isKilled());
    expect(guard.isKilled()).toBe(true);
    // The first frame found the child and onKill threw. Had that escaped, the
    // loop would have stopped there instead of asking for the next frame.
    await until(() => frames > 3);
    expect(frames).toBeGreaterThan(3);
    // The throw was the guard's to swallow: nothing reached the page as uncaught.
    expect(uncaught.get(win)).toEqual([]);
    // And the checks still tear down a root that shows up later.
    win.eval('document.appendChild(document.createElement("html"))');
    await until(gone(win));
    expect(win.eval('document.documentElement')).toBeNull();
  });

  it('counts children with the original window.length getter', async () => {
    const { win, guard } = started({}, (w) => {
      w.eval('document.body.appendChild(document.createElement("iframe"))');
    });
    win.eval('try { Object.defineProperty(window, "length", { get: () => 0 }); } catch {}');
    await until(() => guard.isKilled());
    expect(guard.isKilled()).toBe(true);
  });

  it('works with no options at all', async () => {
    const { win, guard } = started(undefined, (w) => {
      w.eval('document.body.appendChild(document.createElement("iframe"))');
    });
    await until(() => guard.isKilled());
    expect(guard.isKilled()).toBe(true);
    expect(win.eval('document.documentElement')).toBeNull();
    expect(() => guard.check()).not.toThrow();
  });

  it('check() runs the child check now', () => {
    const { win, guard } = started({}, (w) => {
      w.eval('document.body.appendChild(document.createElement("iframe"))');
    });
    guard.check();
    expect(guard.isKilled()).toBe(true);
    expect(win.eval('document.documentElement')).toBeNull();
  });
});

describe('axFrameGuard: the timer', () => {
  it('runs onTick on the timer, after the child check, on the one interval', async () => {
    const calls: string[] = [];
    const intervals: unknown[] = [];
    const cleared: unknown[] = [];
    const { guard } = started(
      {
        onKill: () => calls.push('kill'),
        onTick: () => calls.push('tick'),
      },
      (w) => {
        // No per-frame loop, so only the timer can find the child.
        w.requestAnimationFrame = undefined;
        const realSet = w.setInterval.bind(w);
        const realClear = w.clearInterval.bind(w);
        w.setInterval = (fn: unknown, ms: unknown) => {
          intervals.push(ms);
          return realSet(fn, ms);
        };
        w.clearInterval = (id: unknown) => {
          cleared.push(id);
          return realClear(id);
        };
        w.eval('document.body.appendChild(document.createElement("iframe"))');
      },
    );
    expect(intervals).toEqual([250]);
    await until(() => calls.length >= 2);
    expect(calls.slice(0, 2)).toEqual(['kill', 'tick']);

    guard.slowTimer();
    expect(intervals).toEqual([250, 1000]);
    expect(cleared).toHaveLength(1);
  });

  it('does not let a throwing onTick take the check down with it, and lets the page see the error', async () => {
    let ticks = 0;
    const { win } = started(
      {
        onTick() {
          ticks += 1;
          throw new Error('consumer bug');
        },
      },
      (w) => {
        w.requestAnimationFrame = undefined;
        w.eval('document.body.appendChild(document.createElement("iframe"))');
      },
    );
    await until(() => ticks > 1);
    // The child check ran before the throw, and the interval kept firing.
    expect(win.eval('document.documentElement')).toBeNull();
    expect(ticks).toBeGreaterThan(1);
    // Unlike onKill, a throw from onTick is the consumer's to see: it is an
    // ordinary uncaught error in the page (the chat visual's window error
    // handler reports one before ready).
    expect(uncaught.get(win)).toContain('Uncaught [Error: consumer bug]');
  });
});
