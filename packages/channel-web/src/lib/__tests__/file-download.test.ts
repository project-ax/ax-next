/**
 * Getting a file OUT — the client half (TASK-355, TASK-1022).
 *
 * The thing worth testing here is not "does it fetch". It is that a download
 * which does NOT happen becomes a sentence rather than a blank tab, that the
 * name the file lands under is the one the SERVER sanitized rather than a
 * second guess made in the browser, and that the file's bytes never come into
 * the tab: the only request made from here is the probe, and the browser's own
 * download fetches the file.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  filenameFromContentDisposition,
  workspaceApi,
  WorkspaceApiError,
} from '../workspace-api';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  downloadFailureMessage,
  saveBlob,
  saveFromUrl,
  useFileDownload,
} from '../file-download';
import {
  HTTP_FAILED,
  HTTP_SERVER_ERROR,
  HttpError,
} from '../http';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('filenameFromContentDisposition', () => {
  it('reads the name the server settled on', () => {
    expect(filenameFromContentDisposition('attachment; filename="plan.md"')).toBe(
      'plan.md',
    );
    expect(
      filenameFromContentDisposition('attachment; filename="q3 report v2.pdf"'),
    ).toBe('q3 report v2.pdf');
  });

  it('returns null rather than inventing a name', () => {
    // Every one of these is "we did not get a name", and the caller's own
    // fallback is the single place that decides what to do about it.
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull();
    expect(filenameFromContentDisposition('inline; filename*=UTF-8\'\'x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
/** The probe's answer for a file that would download (TASK-1022). */
function downloadable(): Response {
  return new Response('{"downloadable":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('workspaceApi.probeFileDownload', () => {
  function stubFetch(res: Response) {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => res);
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('asks the route with ?probe=1, and hands back the route itself, the path encoded whole', async () => {
    const spy = stubFetch(downloadable());
    const url = await workspaceApi.probeFileDownload('a 1', 'notes/plan.md');
    // Slashes ENCODED — the server gets one splat segment and decodes exactly
    // once. Real slashes on the wire would let `a/../b` and `a%2F..%2Fb` reach
    // the same read down two different paths.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(
      '/api/workspace/agents/a%201/download/user-files/notes%2Fplan.md?probe=1',
    );
    // What the browser is handed: the same route, without the probe.
    expect(url).toBe(
      '/api/workspace/agents/a%201/download/user-files/notes%2Fplan.md',
    );
  });

  it('turns a refusal into an error that carries its status, never its body', async () => {
    // The status is the whole point: 413 and 404 get DIFFERENT sentences, and
    // a flattened `Error('download failed')` could not tell them apart. The
    // body is not a sentence: `{"error":"file-too-large"}` is what
    // `window.open` would have shown a person in an otherwise empty tab.
    stubFetch(new Response('{"error":"file-too-large"}', { status: 413 }));
    const err = await workspaceApi
      .probeFileDownload('a1', 'huge.csv')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect(err).toMatchObject({ name: 'WorkspaceApiError', status: 413 });
    expect((err as Error).message).not.toContain('file-too-large');
  });

  it('keeps a hostile key inside one segment of a same-origin route', async () => {
    /*
      The key is agent-authored, and the address handed back goes into an
      href. Encoded WHOLE, it cannot become a protocol-relative URL to another
      host, and it cannot add a query or a fragment: every `/`, `?` and `#`
      in it is a `%2F`, `%3F` or `%23` inside the last segment.
    */
    const spy = stubFetch(downloadable());
    const url = await workspaceApi.probeFileDownload('a1', '//evil.example/x?y#z');
    expect(url).toBe(
      '/api/workspace/agents/a1/download/user-files/%2F%2Fevil.example%2Fx%3Fy%23z',
    );
    const resolved = new URL(url, location.href);
    expect(resolved.origin).toBe(location.origin);
    expect(resolved.search).toBe('');
    expect(resolved.hash).toBe('');
    expect(spy.mock.calls[0]?.[0]).toBe(`${url}?probe=1`);
  });

  it('never reads the answer: nothing of the file comes into the tab', async () => {
    // Only the status matters. The body of a 200 is `{downloadable: true}`,
    // and the file itself is the browser's to fetch.
    const res = downloadable();
    const read = [
      vi.spyOn(res, 'blob'),
      vi.spyOn(res, 'arrayBuffer'),
      vi.spyOn(res, 'text'),
      vi.spyOn(res, 'json'),
    ];
    stubFetch(res);
    await workspaceApi.probeFileDownload('a1', 'q3.pdf');
    for (const spy of read) expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('downloadFailureMessage', () => {
  const AGENT = 'Scout';

  it('says what a size refusal actually means, and what to do about it', () => {
    const msg = downloadFailureMessage(new HttpError('/x', 413), AGENT);
    // Not "an error occurred". The person needs to know that this one is too
    // big to send, and that asking for a smaller copy is the way out.
    expect(msg).toContain('too big');
    expect(msg).toContain(AGENT);
    expect(msg).toContain('smaller copy');
  });

  it('does not claim we could only reach the beginning of a big file', () => {
    // True once, when a download was capped at the preview's megabyte. The
    // route streams whole files now and refuses only past its download limit,
    // and it sends none of a file it refuses.
    const msg = downloadFailureMessage(new HttpError('/x', 413), AGENT);
    expect(msg).not.toContain('beginning');
    expect(msg).not.toContain('part of a file');
  });

  it('does not quote a size limit it cannot verify', () => {
    /*
      The limit lives on the server (`USER_FILE_DOWNLOAD_MAX_BYTES` in
      `server/user-file-download.ts`). A sentence naming a figure would be a
      second copy of it that keeps reading correctly long after the figure
      changed, and no test could tell — so the sentence names the
      CONSEQUENCE instead. Asserted, because "helpfully" putting the number
      back is a one-line change somebody will be tempted to make.
    */
    const msg = downloadFailureMessage(new HttpError('/x', 413), AGENT);
    expect(msg).not.toMatch(/\d/);
    expect(msg).not.toContain('megabyte');
    expect(msg).not.toContain('MB');
    expect(msg).not.toContain('GB');
  });

  it('a 503 is about reaching the files, not about how the server is set up', () => {
    /*
      A download 503s when the storage would not answer the read (it failed,
      timed out, or this deployment cannot hand files over). The "this server
      keeps no files" case cannot be reached from here: the Files tab only
      offers a download on a file it listed, and the listing 503s first. So
      the sentence is the transient one, and says the file is safe.
    */
    const msg = downloadFailureMessage(new HttpError('/x', 503), AGENT);
    expect(msg).not.toContain('not set up');
    expect(msg).toContain(AGENT);
    expect(msg).toContain('try again');
    expect(msg).toContain('Nothing was lost');
  });

  it('gives each outcome its own sentence', () => {
    const byStatus = [413, 404, 409, 503, 500].map((s) =>
      downloadFailureMessage(new HttpError('/x', s), AGENT),
    );
    byStatus.push(downloadFailureMessage(new TypeError('Failed to fetch'), AGENT));
    expect(new Set(byStatus).size).toBe(6);
  });

  it('a 409 says the file changed while we were getting it, and to try again', () => {
    // TASK-1016: the route answers 409 `file-changed` when it finds the file
    // changing before it has sent a byte. Busy, not broken.
    const msg = downloadFailureMessage(new HttpError('/x', 409), AGENT);
    expect(msg).toContain('changed');
    expect(msg).toContain('Try again');
    expect(msg).not.toContain('file-changed');
  });

  it('a 400 is a file that is not there to send any more, not a connection to retry', () => {
    // The probe answers 400 `not-a-file` when the key is a folder now: gone,
    // as the chip already says for the same answer. Retrying never helps, so
    // it must not get the connection sentence (TASK-1022 review).
    const msg = downloadFailureMessage(new HttpError('/x', 400), AGENT);
    expect(msg).toBe(downloadFailureMessage(new HttpError('/x', 404), AGENT));
    expect(msg).not.toContain('connection');
  });

  it('only a probe that got NO answer blames the connection', () => {
    /*
      TASK-1022: the browser does the download now, so anything that goes
      wrong after its first byte shows in the browser's download bar, never
      here. What still lands on the fallbacks is a probe with no answer we
      have a sentence for. No answer at all (a TypeError from fetch, or an
      HttpError with no status) may be the connection. A status we have no
      words for (a 5xx) is the server's doing, and sending someone to check
      their wifi over it is the mix-up `HTTP_SERVER_ERROR` exists to avoid.
    */
    for (const e of [new TypeError('Failed to fetch'), new HttpError('/x', 0)]) {
      expect(downloadFailureMessage(e, AGENT)).toBe(
        'That download didn’t start, so nothing was saved. The connection may have dropped. Try again in a moment.',
      );
    }
    for (const e of [new HttpError('/x', 500), new HttpError('/x', 502), new URIError('URI malformed')]) {
      const msg = downloadFailureMessage(e, AGENT);
      expect(msg).toBe('That download didn’t start, so nothing was saved. Try again in a moment.');
      expect(msg).not.toContain('still there');
    }
  });

  it('has a sentence for a failure that was not an HTTP answer at all', () => {
    // A dropped connection throws a TypeError, not an HttpError. "Failed to
    // fetch" is a browser string and never reaches a screen.
    const msg = downloadFailureMessage(new TypeError('Failed to fetch'), AGENT);
    expect(msg).toContain('didn’t start');
    expect(msg).not.toContain('fetch');
  });

  it('never prints a status code or a request path at a person', () => {
    for (const status of [413, 404, 503, 500, 502]) {
      const msg = downloadFailureMessage(
        new HttpError('/api/workspace/agents/a1/download/files/x', status),
        AGENT,
      );
      expect(msg).not.toContain(String(status));
      expect(msg).not.toContain('/api/');
      // …and it is our copy, not the generic transport sentence bubbling up
      // under a new name for the two cases that have something specific to say.
      if (status === 413) expect(msg).not.toBe(HTTP_FAILED);
      if (status === 500) expect(msg).not.toBe(HTTP_SERVER_ERROR);
    }
  });
});

// ---------------------------------------------------------------------------
describe('useFileDownload', () => {
  it('starts ONE download when start() is called twice in the same frame', async () => {
    /*
      The guard has to be a REF, not a read of `busy`.

      `busy` disables the button, but only after React commits. Two clicks
      dispatched inside one frame both run the same `start` closure, which
      still sees `busy === false` — and the person gets the file saved twice,
      which is small and looks exactly like a bug.

      This has to be driven through the hook rather than through the button:
      `fireEvent.click` wraps each click in its own `act()`, so the state is
      already committed by the second one and a `busy`-based guard passes the
      test it should fail. (Measured — the component-level version of this test
      stayed green against the broken guard, which is why it is not written
      there.)
    */
    const calls: string[] = [];
    vi.spyOn(workspaceApi, 'probeFileDownload').mockImplementation(async () => {
      calls.push('one');
      return new Promise<string>(() => undefined);
    });
    const { result } = renderHook(() =>
      useFileDownload({
        agentId: 'a1',
        agentName: 'Scout',
        path: 'q3.pdf',
      }),
    );
    act(() => {
      result.current.start();
      result.current.start();
    });
    expect(calls).toHaveLength(1);
    expect(result.current.busy).toBe(true);
  });

  it('lets the next attempt through once the first one has finished', async () => {
    // The other half: a guard that never releases is a button that works once.
    vi.spyOn(workspaceApi, 'probeFileDownload').mockRejectedValue(
      new HttpError('/x', 500),
    );
    const { result } = renderHook(() =>
      useFileDownload({
        agentId: 'a1',
        agentName: 'Scout',
        path: 'q3.pdf',
      }),
    );
    await act(async () => {
      result.current.start();
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.error).not.toBeNull();
    await act(async () => {
      result.current.start();
    });
    expect(vi.mocked(workspaceApi.probeFileDownload)).toHaveBeenCalledTimes(2);
  });

  /*
    The two below run through the REAL `workspaceApi`, with only `fetch`
    stubbed, so what they see is every request the hook makes and every
    link it clicks.
  */

  /** `fetch` answering every request with `status` and a JSON `body`. */
  function stubFetch(status: number, body: unknown) {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  /** Every link the browser was asked to follow, as its attributes. */
  function clickedLinks() {
    const clicked: Array<{ href: string | null; download: string | null }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        clicked.push({
          href: this.getAttribute('href'),
          download: this.getAttribute('download'),
        });
      },
    );
    return clicked;
  }

  it('probes the route, then hands the route itself to the browser: the bytes never come into the tab', async () => {
    /*
      TASK-1022. The hook used to fetch the whole file into a Blob and then
      save the Blob, so a big file sat in the tab's memory first. Now it asks
      the route (`?probe=1`) and, on a yes, clicks a link to the route: the
      browser fetches the file itself and streams it to disk. One request from
      the page, and none of it reads a body.
    */
    const fetchSpy = stubFetch(200, { downloadable: true });
    const blob = vi.spyOn(Response.prototype, 'blob');
    const arrayBuffer = vi.spyOn(Response.prototype, 'arrayBuffer');
    const clicked = clickedLinks();
    const { result } = renderHook(() =>
      useFileDownload({
        agentId: 'a1',
        agentName: 'Scout',
        path: 'reports/q3.pdf',
      }),
    );
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.busy).toBe(false));

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspace/agents/a1/download/user-files/reports%2Fq3.pdf?probe=1',
    ]);
    // The route, without the probe, and an EMPTY `download`: the browser
    // names the file from the route's own `Content-Disposition`, which the
    // server sanitized. No second sanitizer here.
    expect(clicked).toEqual([
      {
        href: '/api/workspace/agents/a1/download/user-files/reports%2Fq3.pdf',
        download: '',
      },
    ]);
    expect(blob).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('a refused probe hands nothing to the browser', async () => {
    // The refusal is said in the page, in words, and no download starts:
    // the browser's download bar could only have said "Failed".
    const fetchSpy = stubFetch(404, { error: 'file-not-found' });
    const clicked = clickedLinks();
    const { result } = renderHook(() =>
      useFileDownload({
        agentId: 'a1',
        agentName: 'Scout',
        path: 'gone.md',
      }),
    );
    await act(async () => {
      result.current.start();
    });
    await waitFor(() => expect(result.current.busy).toBe(false));

    // What was refused was the PROBE. The download itself was never asked for.
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      '/api/workspace/agents/a1/download/user-files/gone.md?probe=1',
    ]);
    expect(result.current.error).toBe(
      'We could not find that file to send. It may have been rewritten or deleted since this list was drawn.',
    );
    expect(clicked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('saveBlob', () => {
  it('hands the blob to the browser under the server’s name, then lets it go', () => {
    vi.useFakeTimers();
    const created: string[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (_b: Blob) => {
        created.push('blob:x');
        return 'blob:x';
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    });
    const clicked: Array<{ href: string; download: string }> = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'a') {
        el.click = () => {
          const a = el as HTMLAnchorElement;
          clicked.push({ href: a.href, download: a.download });
        };
      }
      return el;
    });

    saveBlob(new Blob(['bytes']), 'plan.md');

    expect(clicked).toEqual([{ href: 'blob:x', download: 'plan.md' }]);
    expect(created).toHaveLength(1);
    // The object URL is still live at click time — revoking inside the same
    // task cancels the download in some browsers — and released one tick later
    // so a page full of downloads does not pin every blob in memory.
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(['blob:x']);
    // And the anchor does not stay in the document.
    expect(document.querySelectorAll('a')).toHaveLength(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
describe('saveFromUrl', () => {
  it('clicks one same-origin link to the route, with an empty download attribute, and leaves nothing behind', () => {
    /*
      TASK-1022: the browser's own download, for a /files route. The browser
      fetches the route and streams the file to disk, so there is no Blob and
      no object URL: no bytes are in the tab to make one from.
    */
    const RealURL = URL;
    // A spy, not a stubbed global: `saveFromUrl` constructs a `URL` to check
    // the route, so the constructor has to stay the real one.
    const createObjectURL = vi.fn((_b: Blob) => 'blob:x');
    const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
    onTestFinished(() => {
      if (original) Object.defineProperty(URL, 'createObjectURL', original);
      else delete (URL as { createObjectURL?: unknown }).createObjectURL;
    });
    const clicked: Array<{
      href: string | null;
      download: string | null;
      hasDownload: boolean;
      inDocument: boolean;
    }> = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'a') {
        el.click = () => {
          const a = el as HTMLAnchorElement;
          clicked.push({
            href: a.getAttribute('href'),
            download: a.getAttribute('download'),
            hasDownload: a.hasAttribute('download'),
            inDocument: a.isConnected,
          });
        };
      }
      return el;
    });
    const route = '/api/workspace/agents/a1/download/user-files/notes%2Fplan.md';

    saveFromUrl(route);

    // The route as given, and an EMPTY `download` that is present: the
    // browser names the file from the route's `Content-Disposition`, which
    // the server sanitized. Clicked while in the document, which some
    // browsers need before they will start a download from a click.
    expect(clicked).toEqual([
      { href: route, download: '', hasDownload: true, inDocument: true },
    ]);
    expect(new RealURL(clicked[0]!.href!, location.href).origin).toBe(
      location.origin,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
    // And the anchor does not stay in the document.
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('refuses anything that is not one of our download routes, before any click', () => {
    /*
      TASK-1022 review: `download` is ignored on a `javascript:` href, so the
      click would RUN it; an absolute or protocol-relative URL would leave our
      origin. The guard is in the function, not only in its doc comment.
    */
    const clicks = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'a') el.click = clicks;
      return el;
    });
    for (const bad of [
      'javascript:alert(1)',
      '//evil.example/api/workspace/x',
      'https://evil.example/api/workspace/x',
      '/somewhere/else',
      'data:text/html,hi',
    ]) {
      expect(() => saveFromUrl(bad)).toThrow();
    }
    expect(clicks).not.toHaveBeenCalled();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});
