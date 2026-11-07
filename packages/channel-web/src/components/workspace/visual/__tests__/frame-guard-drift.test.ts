// @vitest-environment node
//
// Node, not jsdom: @ax/frame-guard's main entry reads the guard file with
// fs at import time, which a web-mode transform can't do. Nothing here needs
// the outer DOM; the tests that do build their own JSDOM windows.
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { CHILD_FRAME_TAGS, DSD_ATTRS, FRAME_GUARD_SOURCE } from '@ax/frame-guard';
import { FRAME_RUNTIME_SOURCE } from '../frame-runtime-source';
import { CHILD_FRAME_SELECTOR, DSD_ATTRIBUTES } from '../visual-doc';

// The chat visual shares its in-page guard with the artifact content origin
// through @ax/frame-guard, but its markup sanitizer (visual-doc.ts) can't
// import the package's lists: visual-hostile.browser.test.ts loads that file
// raw in a browser. So it restates them, and these tests are what keep the
// restatement honest.

const sorted = (list: readonly string[]) => [...list].sort();

describe('visual-doc restates what @ax/frame-guard says can open a child frame', () => {
  it('strips exactly the package child-frame tags', () => {
    expect(sorted(CHILD_FRAME_SELECTOR.split(','))).toEqual(sorted(CHILD_FRAME_TAGS));
  });

  it('drops exactly the package declarative-shadow-root attributes', () => {
    expect(sorted(DSD_ATTRIBUTES)).toEqual(sorted(DSD_ATTRS));
  });
});

// jsdom ships no types and we don't add @types/jsdom for one test: describe
// just the slice we use.
type FrameWindow = {
  eval: (code: string) => unknown;
  axVisualRuntime: (win: FrameWindow, host: unknown) => void;
  close: () => void;
};
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: Record<string, unknown>) => { window: FrameWindow };
};

describe('the frame runtime is the shared guard plus the visual runtime', () => {
  const windows: FrameWindow[] = [];
  afterEach(() => {
    for (const w of windows.splice(0)) w.close();
  });

  function started(): FrameWindow {
    const win = new JSDOM('<!doctype html><html data-theme="light"><head></head><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    }).window;
    windows.push(win);
    win.eval(FRAME_RUNTIME_SOURCE);
    win.axVisualRuntime(win, { postMessage() {} });
    return win;
  }

  it('is the package guard source, then the visual runtime, in one script', () => {
    expect(FRAME_RUNTIME_SOURCE.startsWith(`${FRAME_GUARD_SOURCE}\n`)).toBe(true);
    const visual = FRAME_RUNTIME_SOURCE.slice(FRAME_GUARD_SOURCE.length + 1);
    expect(visual).toContain('window.axVisualRuntime = function axVisualRuntime(');
    expect(visual).not.toContain('window.axFrameGuard =');
    // Neither half can end the <script> element it is inlined into.
    expect(FRAME_RUNTIME_SOURCE.toLowerCase()).not.toContain('</script');
    expect(FRAME_RUNTIME_SOURCE).not.toContain('<!--');
  });

  it('starts the guard when it starts, with the text visuals have always thrown', () => {
    const win = started();
    expect(() => win.eval('document.body.attachShadow({ mode: "open" })')).toThrow('Not available in a chat visual.');
    expect(win.eval('typeof RTCPeerConnection')).toBe('undefined');
  });

  it('leaves no axFrameGuard global for agent code to find', () => {
    const win = started();
    expect(win.eval('typeof axFrameGuard')).toBe('undefined');
    // The visual runtime's own entry stays, as it always has.
    expect(win.eval('typeof axVisualRuntime')).toBe('function');
  });
});
