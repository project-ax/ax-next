/**
 * Getting a file OUT — the client half (TASK-355).
 *
 * The thing worth testing here is not "does it fetch". It is that a download
 * which does NOT happen becomes a sentence rather than a blank tab, and that
 * the name the file lands under is the one the SERVER sanitized rather than a
 * second guess made in the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_SAVED_FILENAME,
  filenameFromContentDisposition,
  workspaceApi,
  WorkspaceApiError,
} from '../workspace-api';
import { act, renderHook } from '@testing-library/react';
import { downloadFailureMessage, saveBlob, useFileDownload } from '../file-download';
import {
  HTTP_FAILED,
  HTTP_NOT_FOUND,
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
describe('workspaceApi.downloadFile', () => {
  function stubFetch(res: Response): ReturnType<typeof vi.fn> {
    const spy = vi.fn(async () => res);
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('addresses the GOVERNED tier, with the path encoded whole', async () => {
    const spy = stubFetch(
      new Response('hi', {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="plan.md"' },
      }),
    );
    const got = await workspaceApi.downloadFile('a 1', 'workspace', 'notes/plan.md');
    // Slashes ENCODED — the server gets one splat segment and decodes exactly
    // once. Real slashes on the wire would let `a/../b` and `a%2F..%2Fb` reach
    // the same read down two different paths.
    expect(spy.mock.calls[0]?.[0]).toBe(
      '/api/workspace/agents/a%201/download/files/notes%2Fplan.md',
    );
    expect(got.filename).toBe('plan.md');
    // The BYTES, not a decoded string: this route serves PDFs and zips, and
    // `res.text()` anywhere on this path would mangle them. (jsdom's Blob has
    // no `.text()`, so the size is what we can check here; the server tests
    // assert the bytes themselves byte for byte.)
    expect(got.blob.size).toBe(2);
  });

  it('addresses the DURABLE tier on its own route, not a query parameter', async () => {
    const spy = stubFetch(new Response('hi', { status: 200 }));
    await workspaceApi.downloadFile('a1', 'user-files', 'reports/summary.md');
    expect(spy.mock.calls[0]?.[0]).toBe(
      '/api/workspace/agents/a1/download/user-files/reports%2Fsummary.md',
    );
  });

  it('falls back to a plain name when the server sent no filename', async () => {
    stubFetch(new Response('hi', { status: 200 }));
    const got = await workspaceApi.downloadFile('a1', 'workspace', 'x.md');
    expect(got.filename).toBe(FALLBACK_SAVED_FILENAME);
  });

  it('turns a non-ok answer into an error that still carries its status', async () => {
    // The status is the whole point: 413 and 404 get DIFFERENT sentences, and
    // a flattened `Error('download failed')` could not tell them apart.
    stubFetch(new Response('{"error":"file-too-large"}', { status: 413 }));
    await expect(
      workspaceApi.downloadFile('a1', 'user-files', 'huge.csv'),
    ).rejects.toMatchObject({ name: 'WorkspaceApiError', status: 413 });
  });

  it('does not put the response body on screen', async () => {
    // `{"error":"file-not-found"}` is not a sentence, and it is what
    // `window.open` would have shown a person in an otherwise empty tab.
    stubFetch(new Response('{"error":"file-not-found"}', { status: 404 }));
    const err = await workspaceApi
      .downloadFile('a1', 'workspace', 'gone.md')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as Error).message).toBe(HTTP_NOT_FOUND);
    expect((err as Error).message).not.toContain('file-not-found');
  });
});

// ---------------------------------------------------------------------------
describe('downloadFailureMessage', () => {
  const AGENT = 'Scout';

  it('says what a size refusal actually means, naming the limit', () => {
    const msg = downloadFailureMessage(new HttpError('/x', 413), AGENT);
    // Not "an error occurred". The person needs to know that we CAN'T send
    // this one whole and that a fragment would be useless — that is the only
    // thing that tells them to go ask for a smaller copy.
    expect(msg).toContain('too big');
    expect(msg).toContain('part of a file is worse than none');
    expect(msg).toContain(AGENT);
  });

  it('does not quote a size limit it cannot verify', () => {
    /*
      The cap lives in the sandbox provider, two packages away and deliberately
      not importable from here. A sentence naming a figure would keep reading
      correctly long after the figure changed, and no test could tell — so the
      sentence names the CONSEQUENCE instead. Asserted, because "helpfully"
      putting the number back is a one-line change somebody will be tempted to
      make.
    */
    const msg = downloadFailureMessage(new HttpError('/x', 413), AGENT);
    expect(msg).not.toMatch(/\d/);
    expect(msg).not.toContain('megabyte');
    expect(msg).not.toContain('MB');
  });

  it('gives each outcome its own sentence', () => {
    const byStatus = [413, 404, 503, 500].map((s) =>
      downloadFailureMessage(new HttpError('/x', s), AGENT),
    );
    expect(new Set(byStatus).size).toBe(4);
  });

  it('has a sentence for a failure that was not an HTTP answer at all', () => {
    // A dropped connection throws a TypeError, not an HttpError. "Failed to
    // fetch" is a browser string and never reaches a screen.
    const msg = downloadFailureMessage(new TypeError('Failed to fetch'), AGENT);
    expect(msg).toContain('could not download');
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
    vi.spyOn(workspaceApi, 'downloadFile').mockImplementation(async () => {
      calls.push('one');
      return new Promise(() => undefined);
    });
    const { result } = renderHook(() =>
      useFileDownload({
        agentId: 'a1',
        agentName: 'Scout',
        tier: 'workspace',
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
    vi.spyOn(workspaceApi, 'downloadFile').mockRejectedValue(
      new HttpError('/x', 500),
    );
    const { result } = renderHook(() =>
      useFileDownload({
        agentId: 'a1',
        agentName: 'Scout',
        tier: 'workspace',
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
    expect(vi.mocked(workspaceApi.downloadFile)).toHaveBeenCalledTimes(2);
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
