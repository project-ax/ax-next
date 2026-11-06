import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { httpFetch } from '@/lib/http';
import { saveBlob } from '@/lib/file-download';
import { setTheme } from '@/lib/theme';
import { VisualFrame } from '../VisualFrame';
import { VISUAL_FRAME_CSP } from '../visual-doc';

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  httpFetch: vi.fn(),
}));
vi.mock('@/lib/file-download', () => ({ saveBlob: vi.fn() }));
vi.mock('../visual-assets', () => ({
  DEFAULT_VISUAL_ASSETS: {
    fontFaceCss: '',
    librarySources: [],
    runtimeSource: 'function axVisualRuntime() {}',
  },
}));

const fetchMock = vi.mocked(httpFetch);
const saveMock = vi.mocked(saveBlob);
const FAILED = "This visual couldn't be displayed.";
const NO_PICTURE = "We couldn't make a picture of this visual. The HTML download still works.";

// The html and height caches are module-level: every case gets its own artifact.
let seq = 0;
function nextArtifactId(): string {
  seq += 1;
  return seq.toString(16).padStart(32, '0');
}

function htmlResponse(body = '<p>chart</p>', init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' }, ...init });
}

function mount(artifactId = nextArtifactId()) {
  const visual = { artifactId, title: 'Issues per cycle', summary: 'Down 12%.' };
  const view = render(<VisualFrame conversationId="c1" visual={visual} />);
  return { ...view, artifactId };
}

async function frameWindow(): Promise<{ iframe: HTMLIFrameElement; win: Window }> {
  const iframe = (await screen.findByTitle('Issues per cycle')) as HTMLIFrameElement;
  return { iframe, win: iframe.contentWindow! };
}

function fromFrame(win: Window | null, data: unknown, origin = 'null'): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: win, origin }));
  });
}

async function openMenu(): Promise<void> {
  const trigger = screen.getByRole('button', { name: 'Download visual' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await screen.findByRole('menuitem', { name: 'Download as HTML' });
}

// jsdom's Blob has no text().
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const READY = { type: 'ax-visual:ready', height: 300, rendered: true, locked: true };

beforeEach(() => {
  fetchMock.mockReset();
  saveMock.mockReset();
  fetchMock.mockImplementation(async () => htmlResponse());
  localStorage.clear();
  setTheme('light');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setTheme('auto');
  localStorage.clear();
});

describe('VisualFrame', () => {
  it('renders a frame sandboxed with exactly allow-scripts, titled and described', async () => {
    mount('0123456789abcdef0123456789abcdef');
    const f = await screen.findByTitle('Issues per cycle');
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('srcdoc')).toContain('<p>chart</p>');
    expect(document.getElementById(f.getAttribute('aria-describedby')!)?.textContent).toBe('Down 12%.');
    expect(httpFetch).toHaveBeenCalledWith('/api/files?conversationId=c1&id=0123456789abcdef0123456789abcdef', {
      signal: expect.any(AbortSignal),
    });
    expect(f.className).toContain('opacity-0');
  });

  it('grows to the size its own frame reports and ignores other windows', async () => {
    mount();
    const { iframe, win } = await frameWindow();
    expect(iframe.style.height).toBe('280px');
    fromFrame(window, { type: 'ax-visual:size', height: 900 });
    fromFrame(win, { type: 'ax-visual:size', height: 900 }, window.location.origin);
    expect(iframe.style.height).toBe('280px');
    fromFrame(win, { type: 'ax-visual:size', height: 400 });
    expect(iframe.style.height).toBe('400px');
  });

  it('fades in on ready, and a ready with locked false is not a failure', async () => {
    mount();
    const { iframe, win } = await frameWindow();
    fromFrame(win, { ...READY, locked: false });
    expect(iframe.className).toContain('opacity-100');
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('shows the quiet failure with the summary on an error before ready, and on a 404', async () => {
    mount();
    const { win } = await frameWindow();
    fromFrame(win, { type: 'ax-visual:error' });
    expect(screen.getByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByTitle('Issues per cycle')).toBeNull();
    cleanup();

    fetchMock.mockImplementation(async () => new Response('{"error":"not-found"}', { status: 404 }));
    mount();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.getAllByText('Down 12%.').length).toBeGreaterThan(0);
  });

  it('unmounts the frame on an error after ready', async () => {
    mount();
    const { iframe, win } = await frameWindow();
    fromFrame(win, READY);
    fromFrame(win, { type: 'ax-visual:error' });
    expect(iframe.isConnected).toBe(false);
    expect(screen.getByText(FAILED)).toBeInTheDocument();
    expect(screen.getAllByText('Down 12%.').length).toBeGreaterThan(0);
  });

  it('fails when the frame reports it rendered nothing', async () => {
    mount();
    const { win } = await frameWindow();
    fromFrame(win, { ...READY, rendered: false });
    expect(screen.getByText(FAILED)).toBeInTheDocument();
  });

  it('fails when no ready arrives within 8 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await frameWindow();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByText(FAILED)).toBeInTheDocument();
  });

  describe('the ready timeout only runs while the card could be seen', () => {
    // A hand-cranked IntersectionObserver: `scroll(true|false)` says whether
    // the card is on screen.
    let observed: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    const scroll = (isIntersecting: boolean) =>
      act(() => {
        for (const cb of observed) cb([{ isIntersecting }]);
      });
    let visibility: DocumentVisibilityState = 'visible';
    const setVisibility = (next: DocumentVisibilityState) =>
      act(() => {
        visibility = next;
        document.dispatchEvent(new Event('visibilitychange'));
      });

    beforeEach(() => {
      observed = [];
      visibility = 'visible';
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
            observed.push(cb);
          }
          observe() {}
          disconnect() {}
        },
      );
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('does not fail a card that is off screen, however long it waits', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mount();
      await frameWindow();
      scroll(false);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.queryByText(FAILED)).toBeNull();
      // Once it's on screen, it gets the full 8 s, and then fails.
      scroll(true);
      act(() => {
        vi.advanceTimersByTime(7_900);
      });
      expect(screen.queryByText(FAILED)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText(FAILED)).toBeInTheDocument();
    });

    it('does not fail a card in a hidden tab, and pauses rather than restarts the budget', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mount();
      await frameWindow();
      scroll(true);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      setVisibility('hidden');
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.queryByText(FAILED)).toBeNull();
      setVisibility('visible');
      act(() => {
        vi.advanceTimersByTime(2_900);
      });
      expect(screen.queryByText(FAILED)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByText(FAILED)).toBeInTheDocument();
    });

    it('(BUG-2) tells a ready frame each time its card comes on screen', async () => {
      mount();
      const { win } = await frameWindow();
      const postSpy = vi.spyOn(win, 'postMessage');
      const visibleCalls = () =>
        postSpy.mock.calls.filter(([m]) => (m as { type?: string }).type === 'ax-visual:visible');
      scroll(false);
      fromFrame(win, READY);
      expect(visibleCalls()).toEqual([]);
      scroll(true);
      expect(visibleCalls()).toEqual([[{ type: 'ax-visual:visible' }, '*']]);
      scroll(false);
      scroll(true);
      expect(visibleCalls()).toHaveLength(2);
    });

    it('(BUG-2) a frame that says ready while on screen hears visible at once', async () => {
      mount();
      const { win } = await frameWindow();
      const postSpy = vi.spyOn(win, 'postMessage');
      scroll(true);
      expect(postSpy).not.toHaveBeenCalledWith({ type: 'ax-visual:visible' }, '*'); // not ready yet
      fromFrame(win, READY);
      expect(postSpy).toHaveBeenCalledWith({ type: 'ax-visual:visible' }, '*');
    });

    it('a card that comes on screen and says ready in time is shown', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mount();
      const { iframe, win } = await frameWindow();
      scroll(false);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      scroll(true);
      fromFrame(win, READY);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.queryByText(FAILED)).toBeNull();
      expect(iframe.className).toContain('opacity-100');
    });
  });

  it('(RF5) never reads an oversized artifact', async () => {
    const res = htmlResponse('<p>chart</p>', { headers: { 'content-length': '50000000' } });
    const textSpy = vi.spyOn(res, 'text');
    fetchMock.mockImplementation(async () => res);
    mount();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('refuses a body over the limit even without a content-length', async () => {
    fetchMock.mockImplementation(async () => htmlResponse('x'.repeat(256 * 1024 + 1)));
    mount();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
  });

  it('posts a theme change to the frame without rebuilding it', async () => {
    mount();
    const { iframe, win } = await frameWindow();
    const postSpy = vi.spyOn(win, 'postMessage');
    fromFrame(win, READY);
    const before = iframe.getAttribute('srcdoc');
    expect(before).toContain('data-theme="light"');
    act(() => setTheme('dark'));
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'ax-visual:theme', mode: 'dark' }), '*');
    expect(iframe.getAttribute('srcdoc')).toBe(before);
  });

  it('(RF3) a theme toggled while loading reaches the frame on ready', async () => {
    mount();
    const { win } = await frameWindow();
    const postSpy = vi.spyOn(win, 'postMessage');
    act(() => setTheme('dark'));
    expect(postSpy).not.toHaveBeenCalled();
    fromFrame(win, READY);
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'ax-visual:theme', mode: 'dark' }), '*');
  });

  it('(RF4) a remount reuses the html and the last height', async () => {
    const { unmount, artifactId } = mount();
    const { win } = await frameWindow();
    fromFrame(win, { type: 'ax-visual:size', height: 400 });
    unmount();
    mount(artifactId);
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect((await screen.findByTitle('Issues per cycle')).style.height).toBe('400px');
  });

  it('downloads HTML: a standalone document with the CSP and the agent markup', async () => {
    mount();
    await frameWindow();
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download as HTML' }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    const [blob, name] = saveMock.mock.calls[0]!;
    expect(name).toBe('Issues per cycle.html');
    expect(blob.type).toBe('text/html');
    const text = await readText(blob);
    expect(text).toContain(VISUAL_FRAME_CSP);
    expect(text).toContain('sandbox="allow-scripts"');
    expect(text).toContain('&lt;p&gt;chart&lt;/p&gt;');
  });

  it('keeps PNG disabled until ready', async () => {
    mount();
    await frameWindow();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'Download as PNG' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('downloads PNG only when the frame answers with a real png', async () => {
    mount();
    const { win } = await frameWindow();
    const postSpy = vi.spyOn(win, 'postMessage');
    fromFrame(win, READY);

    const requestPng = async (): Promise<string> => {
      postSpy.mockClear();
      await openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download as PNG' }));
      const call = postSpy.mock.calls.find(([m]) => (m as { type?: string }).type === 'ax-visual:export');
      expect(call).toBeDefined();
      expect(call![1]).toBe('*');
      const msg = call![0] as { requestId: string; format: string };
      expect(msg.format).toBe('png');
      return msg.requestId;
    };

    // Forged: claims image/png, isn't one.
    const forgedId = await requestPng();
    fromFrame(win, {
      type: 'ax-visual:export-result',
      requestId: forgedId,
      ok: true,
      blob: new Blob(['GIF89a'], { type: 'image/png' }),
    });
    expect(await screen.findByText(NO_PICTURE)).toBeInTheDocument();
    expect(saveMock).not.toHaveBeenCalled();

    const realId = await requestPng();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    fromFrame(win, { type: 'ax-visual:export-result', requestId: realId, ok: true, blob: new Blob([png], { type: 'image/png' }) });
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const [blob, name] = saveMock.mock.calls[0]!;
    expect(name).toBe('Issues per cycle.png');
    expect(blob.type).toBe('image/png');

    // The same id again is no longer pending.
    fromFrame(win, { type: 'ax-visual:export-result', requestId: realId, ok: true, blob: new Blob([png], { type: 'image/png' }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(saveMock).toHaveBeenCalledTimes(1);
  });
});
