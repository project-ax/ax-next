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

  it('addresses the agent\u2019s files, with the path encoded whole', async () => {
    const spy = stubFetch(
      new Response('hi', {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="plan.md"' },
      }),
    );
    const got = await workspaceApi.downloadFile('a 1', 'notes/plan.md');
    // Slashes ENCODED — the server gets one splat segment and decodes exactly
    // once. Real slashes on the wire would let `a/../b` and `a%2F..%2Fb` reach
    // the same read down two different paths.
    expect(spy.mock.calls[0]?.[0]).toBe(
      '/api/workspace/agents/a%201/download/user-files/notes%2Fplan.md',
    );
    expect(got.filename).toBe('plan.md');
    // The BYTES, not a decoded string: this route serves PDFs and zips, and
    // `res.text()` anywhere on this path would mangle them. (jsdom's Blob has
    // no `.text()`, so the size is what we can check here; the server tests
    // assert the bytes themselves byte for byte.)
    expect(got.blob.size).toBe(2);
  });

  it('has no tier argument and no git download route to address', async () => {
    // The git-backed `/download/files/*` route was removed in TASK-995, so
    // there is exactly one route and the path is the only thing that varies.
    const spy = stubFetch(new Response('hi', { status: 200 }));
    await workspaceApi.downloadFile('a1', 'reports/summary.md');
    expect(spy.mock.calls[0]?.[0]).toBe(
      '/api/workspace/agents/a1/download/user-files/reports%2Fsummary.md',
    );
    expect(spy.mock.calls[0]?.[0]).not.toContain('/download/files/');
  });

  it('falls back to a plain name when the server sent no filename', async () => {
    stubFetch(new Response('hi', { status: 200 }));
    const got = await workspaceApi.downloadFile('a1', 'x.md');
    expect(got.filename).toBe(FALLBACK_SAVED_FILENAME);
  });

  it('turns a non-ok answer into an error that still carries its status', async () => {
    // The status is the whole point: 413 and 404 get DIFFERENT sentences, and
    // a flattened `Error('download failed')` could not tell them apart.
    stubFetch(new Response('{"error":"file-too-large"}', { status: 413 }));
    await expect(
      workspaceApi.downloadFile('a1', 'huge.csv'),
    ).rejects.toMatchObject({ name: 'WorkspaceApiError', status: 413 });
  });

  it('does not put the response body on screen', async () => {
    // `{"error":"file-not-found"}` is not a sentence, and it is what
    // `window.open` would have shown a person in an otherwise empty tab.
    stubFetch(new Response('{"error":"file-not-found"}', { status: 404 }));
    const err = await workspaceApi
      .downloadFile('a1', 'gone.md')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as Error).message).toBe(HTTP_NOT_FOUND);
    expect((err as Error).message).not.toContain('file-not-found');
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
    expect(new Set(byStatus).size).toBe(5);
  });

  it('a 409 says the file changed while we were getting it, and to try again', () => {
    // TASK-1016: the route answers 409 `file-changed` when it finds the file
    // changing before it has sent a byte. Busy, not broken.
    const msg = downloadFailureMessage(new HttpError('/x', 409), AGENT);
    expect(msg).toContain('changed');
    expect(msg).toContain('Try again');
    expect(msg).not.toContain('file-changed');
  });

  it('the fallback never claims the file is still there: after a mid-download deletion it is not', () => {
    /*
      A download torn after its head (the file deleted or rewritten partway,
      or the connection dropped) reaches the browser as a failed fetch, and
      the client cannot tell which. So the sentence says what it knows — the
      download did not finish and nothing was saved — and names the causes,
      deletion included. It used to say "the file is still there", which is
      false exactly when the file was deleted mid-download.
    */
    for (const e of [new TypeError('network error'), new HttpError('/x', 500)]) {
      const msg = downloadFailureMessage(e, AGENT);
      expect(msg).not.toContain('still there');
      expect(msg).toContain('deleted');
      expect(msg).toContain('nothing was saved');
    }
  });

  it('has a sentence for a failure that was not an HTTP answer at all', () => {
    // A dropped connection throws a TypeError, not an HttpError. "Failed to
    // fetch" is a browser string and never reaches a screen.
    const msg = downloadFailureMessage(new TypeError('Failed to fetch'), AGENT);
    expect(msg).toContain("didn't finish");
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
