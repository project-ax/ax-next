import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GeneratedFileChip } from '../GeneratedFileChip';
import { AgentConversation } from '../AgentConversation';
import { DOWNLOAD_STARTED_MS, DOWNLOAD_STARTED_NOTE, saveBlob, saveFromUrl } from '@/lib/file-download';
import type { ThreadMessage } from '@/lib/workspace-api';

// Only the two hand-overs are stubbed: the chip also reads the started
// window's constants from this module, and a bare factory would hand it
// `undefined` (a 0 ms window, and no note).
vi.mock('@/lib/file-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/file-download')>()),
  saveBlob: vi.fn(),
  saveFromUrl: vi.fn(),
}));
const file = { attachmentId: '0123456789abcdef0123456789abcdef', displayName: 'budget.csv', mediaType: 'text/csv', sizeBytes: 2048 };
beforeEach(() => {
  vi.mocked(saveBlob).mockClear();
  vi.mocked(saveFromUrl).mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const agentFile = { attachmentId: null, agentFilePath: 'reports/Q3 plan #1.pdf', displayName: 'Q3 plan #1.pdf', mediaType: 'application/pdf', sizeBytes: 10 };
/** `agentFile`'s two addresses in conversation `c1`: the key encoded whole, once. */
const STATUS_URL = '/api/workspace/conversations/c1/status/user-files/reports%2FQ3%20plan%20%231.pdf';
const DOWNLOAD_URL = '/api/workspace/conversations/c1/download/user-files/reports%2FQ3%20plan%20%231.pdf';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * `fetch` for an agent-file chip. Its status check gets `status()` (the file
 * is there, by default) and its download route gets `download()`. Since
 * TASK-1022 the only request a click makes there is the probe, so the default
 * is the probe's yes. Any other address is a bug in the chip, so it throws.
 */
function chipFetch(answers: { status?: () => Promise<Response>; download?: () => Promise<Response> } = {}) {
  return vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes('/status/user-files/')) return (answers.status ?? (async () => json({ available: true })))();
    if (url.includes('/download/user-files/')) return (answers.download ?? (async () => json({ downloadable: true })))();
    throw new Error(`the chip asked for ${url}`);
  });
}

/** Status answers, one per check, in order. */
function statusAnswers(...statuses: number[]): () => Promise<Response> {
  return async () => {
    const status = statuses.shift();
    if (status === undefined) throw new Error('the chip checked more often than the test expected');
    return status === 200 ? json({ available: true }) : json({ error: 'file-not-found' }, status);
  };
}

/**
 * Wait one macrotask, inside act: every promise the chip chained off an
 * answer has run by then, so a state it was going to set has been set.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** What `AgentConversation` needs to draw `thread` in conversation `c1`, and nothing more. */
function conversationProps(thread: ThreadMessage[]): ComponentProps<typeof AgentConversation> {
  return {
    agent: { id: 'a-quill', name: 'Quill' },
    thread,
    conversationId: 'c1',
    decisions: [],
    readOnly: false,
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    approvalRead: 'ok',
    onRetryApprovals: vi.fn(),
    grants: [],
    onGrantResolved: vi.fn(),
    onGranted: vi.fn(async () => true),
  };
}

describe('GeneratedFileChip', () => {
  it('downloads through the conversation scope, uses the server filename, and works after remount', async () => {
    const fetch = vi.fn(async () => new Response('csv', { headers: { 'content-disposition': 'attachment; filename="safe.csv"' } }));
    vi.stubGlobal('fetch', fetch);
    for (let reload = 0; reload < 2; reload++) {
      const view = render(<GeneratedFileChip file={file} conversationId="c & 1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Download budget.csv' }));
      await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(reload + 1));
      expect(saveBlob).toHaveBeenLastCalledWith(expect.any(Blob), 'safe.csv');
      view.unmount();
    }
    // Addressed by the artifact's id within its conversation, never by a path.
    expect(fetch).toHaveBeenCalledWith('/api/files?conversationId=c%20%26%201&id=0123456789abcdef0123456789abcdef', { credentials: 'include' });
  });

  it('asks for nothing while the file has no id to download by', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<GeneratedFileChip file={{ ...file, attachmentId: null }} conversationId="c1" />);
    const button = screen.getByRole('button', { name: 'Download budget.csv' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prevents overlapping downloads and gives a failed download a retry', async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
    vi.stubGlobal('fetch', fetch);
    render(<GeneratedFileChip file={file} conversationId="c1" />);
    const button = screen.getByRole('button', { name: 'Download budget.csv' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(screen.getByText('Downloading…')).toBeVisible();
    resolve(new Response('{}', { status: 404 }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This file is no longer available'));
    expect(saveBlob).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(2);
    resolve(new Response('data'));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledOnce());
    // The attachment's hand-over starts the same window as an agent file's.
    expect(await screen.findByText(DOWNLOAD_STARTED_NOTE)).toBeVisible();
    expect(button).toBeDisabled();
  });

  describe('agent-file chips (TASK-1012)', () => {
    it('downloads live through the conversation route: it asks first, the browser saves it, and nothing touches /api/files', async () => {
      // TASK-1022: the click probes the route, then hands the route itself to
      // the browser, which streams the file to disk. The probe's answer is
      // never read, so none of the file comes into the tab.
      const probe = json({ downloadable: true });
      const read = [
        vi.spyOn(probe, 'blob'),
        vi.spyOn(probe, 'arrayBuffer'),
        vi.spyOn(probe, 'text'),
        vi.spyOn(probe, 'json'),
      ];
      // The yes's body is cancelled: a host too old to know `?probe` would
      // otherwise stream the whole file into a body nobody reads.
      const cancel = vi.spyOn(probe.body!, 'cancel');
      const fetch = chipFetch({ download: async () => probe });
      vi.stubGlobal('fetch', fetch);
      render(<GeneratedFileChip file={agentFile} conversationId="c & 1" />);
      const button = screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(saveFromUrl).toHaveBeenCalledOnce());
      expect(saveFromUrl).toHaveBeenCalledWith('/api/workspace/conversations/c%20%26%201/download/user-files/reports%2FQ3%20plan%20%231.pdf');
      expect(saveBlob).not.toHaveBeenCalled();
      for (const spy of read) expect(spy).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      // One check that the file is there (on mount, TASK-1017), then the
      // probe the click asked for. Neither goes anywhere near /api/files.
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/workspace/conversations/c%20%26%201/status/user-files/reports%2FQ3%20plan%20%231.pdf',
        '/api/workspace/conversations/c%20%26%201/download/user-files/reports%2FQ3%20plan%20%231.pdf?probe=1',
      ]);
      expect(fetch).toHaveBeenLastCalledWith('/api/workspace/conversations/c%20%26%201/download/user-files/reports%2FQ3%20plan%20%231.pdf?probe=1', { credentials: 'include' });
    });

    it('after the browser has it, the chip says so and ignores clicks for a moment', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const fetch = chipFetch();
      vi.stubGlobal('fetch', fetch);
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      const button = screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' });
      fireEvent.click(button);
      await waitFor(() => expect(saveFromUrl).toHaveBeenCalledOnce());
      expect(await screen.findByText(DOWNLOAD_STARTED_NOTE)).toBeVisible();
      expect(button).toBeDisabled();

      // Right after the note appears, a click does nothing: no second probe.
      fireEvent.click(button);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([STATUS_URL, `${DOWNLOAD_URL}?probe=1`]);
      expect(saveFromUrl).toHaveBeenCalledOnce();

      act(() => { vi.advanceTimersByTime(DOWNLOAD_STARTED_MS); });
      expect(button).toBeEnabled();
      expect(screen.getByText('10 B · Download')).toBeVisible();
      expect(screen.queryByText(DOWNLOAD_STARTED_NOTE)).toBeNull();
      fireEvent.click(button);
      await waitFor(() => expect(saveFromUrl).toHaveBeenCalledTimes(2));
    });

    it('leaving during the window leaves no timer behind', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.stubGlobal('fetch', chipFetch());
      const view = render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' }));
      expect(await screen.findByText(DOWNLOAD_STARTED_NOTE)).toBeVisible();
      expect(vi.getTimerCount()).toBe(1);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaving while the probe is still out starts no window afterwards', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let answer!: (r: Response) => void;
      vi.stubGlobal('fetch', chipFetch({ download: () => new Promise<Response>((r) => { answer = r; }) }));
      const view = render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' }));
      await waitFor(() => expect(answer).toBeDefined());
      view.unmount();
      answer(json({ downloadable: true }));
      await waitFor(() => expect(saveFromUrl).toHaveBeenCalledOnce());
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([404, 400])('says the file is gone on a %i', async (status) => {
      // The check on mount found the file; it was gone by the click. What
      // refused was the click's probe, so the browser is handed nothing.
      const fetch = chipFetch({ download: async () => new Response('{}', { status }) });
      vi.stubGlobal('fetch', fetch);
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This file is no longer available to download.'));
      expect(fetch).toHaveBeenLastCalledWith(`${DOWNLOAD_URL}?probe=1`, { credentials: 'include' });
      expect(saveFromUrl).not.toHaveBeenCalled();
      expect(saveBlob).not.toHaveBeenCalled();
    });

    it('keeps the generic retry copy on a 400 for an attachment-id chip', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
      render(<GeneratedFileChip file={file} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not download this file just now. Try again.'));
    });

    it('says the file is too big on a 413', async () => {
      // The reader gets copy; the console gets the status (TASK-1022 review).
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      onTestFinished(() => warn.mockRestore());
      vi.stubGlobal('fetch', chipFetch({ download: async () => new Response('{}', { status: 413 }) }));
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
        'This file is too big for us to download. Ask the agent for a smaller copy, or to split it up.'));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[file chip download\] .*413/));
    });

    it('shows the generic error, not a crash, when the key cannot be put in a URL', async () => {
      // A lone surrogate makes encodeURIComponent throw. It must not take the
      // render down, and it must not reach the network: not for the click, and
      // not for the check on mount either, which counts it as "we can't tell".
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      render(<GeneratedFileChip file={{ ...agentFile, agentFilePath: 'bad\ud800.pdf' }} conversationId="c1" />);
      const button = screen.getByRole('button');
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not download this file just now. Try again.'));
      expect(fetch).not.toHaveBeenCalled();
      expect(button).toBeEnabled();
    });

    it('keeps the generic copy on a 503', async () => {
      vi.stubGlobal('fetch', chipFetch({ download: async () => new Response('{}', { status: 503 }) }));
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not download this file just now. Try again.'));
      // A refusal hands the browser nothing, so it starts no window.
      expect(screen.getByRole('button')).toBeEnabled();
      expect(screen.queryByText(DOWNLOAD_STARTED_NOTE)).toBeNull();
    });
  });

  describe('knowing a file is gone before anyone clicks (TASK-1017)', () => {
    it.each([404, 400])('an agent file that is gone says so before any click (a %i)', async (status) => {
      const fetch = chipFetch({ status: statusAnswers(status) });
      vi.stubGlobal('fetch', fetch);
      render(<GeneratedFileChip file={agentFile} conversationId="c & 1" />);

      const button = await screen.findByRole('button', { name: 'Q3 plan #1.pdf is no longer available' });
      expect(button).toBeDisabled();
      expect(screen.getByText('No longer available')).toBeVisible();
      expect(screen.queryByText('10 B · Download')).toBeNull();
      // Asked once, with no click, through the conversation's own status
      // route, both parts encoded whole, once.
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        '/api/workspace/conversations/c%20%26%201/status/user-files/reports%2FQ3%20plan%20%231.pdf',
        expect.objectContaining({ credentials: 'include' }),
      );
      // There is nothing to download, and the button says so by doing nothing.
      fireEvent.click(button);
      await settle();
      expect(fetch).toHaveBeenCalledOnce();
      expect(saveBlob).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'a 503', answer: async () => json({ error: 'file-read-failed' }, 503) },
      { label: 'a 500', answer: async () => json({}, 500) },
      { label: 'a 403', answer: async () => json({}, 403) },
      { label: 'a 401', answer: async () => json({ error: 'unauthenticated' }, 401) },
      { label: 'a rejected fetch', answer: async (): Promise<Response> => { throw new TypeError('Failed to fetch'); } },
    ])('a status that is not 404 or 400 leaves the chip downloadable ($label)', async ({ answer }) => {
      const fetch = chipFetch({ status: answer });
      vi.stubGlobal('fetch', fetch);
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(fetch).toHaveBeenCalledWith(STATUS_URL, expect.anything());
      await settle();

      // "We could not tell" is never "it is gone".
      const button = screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' });
      expect(button).toBeEnabled();
      expect(screen.getByText('10 B · Download')).toBeVisible();
      fireEvent.click(button);
      await waitFor(() => expect(saveFromUrl).toHaveBeenCalledOnce());
      expect(saveFromUrl).toHaveBeenCalledWith(DOWNLOAD_URL);
      expect(fetch).toHaveBeenLastCalledWith(`${DOWNLOAD_URL}?probe=1`, { credentials: 'include' });
    });

    it('rechecks when a new turn lands, and not on a re-render that brings none', async () => {
      const fetch = chipFetch({ status: statusAnswers(200, 404) });
      vi.stubGlobal('fetch', fetch);
      const view = render(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={1} />);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await settle();
      expect(screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' })).toBeEnabled();

      view.rerender(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={1} />);
      await settle();
      expect(fetch).toHaveBeenCalledOnce();

      // The next turn, in which the agent deleted the file.
      view.rerender(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={2} />);
      expect(await screen.findByRole('button', { name: 'Q3 plan #1.pdf is no longer available' })).toBeDisabled();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith(STATUS_URL, expect.anything());
    });

    it('a file that is back at its key is downloadable again', async () => {
      // The chip names a key, live: once a file is there again, a download
      // would serve it, so the chip must not go on saying it is gone.
      vi.stubGlobal('fetch', chipFetch({ status: statusAnswers(404, 200) }));
      const view = render(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={1} />);
      expect(await screen.findByRole('button', { name: 'Q3 plan #1.pdf is no longer available' })).toBeDisabled();
      view.rerender(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={2} />);
      expect(await screen.findByRole('button', { name: 'Download Q3 plan #1.pdf' })).toBeEnabled();
      expect(screen.getByText('10 B · Download')).toBeVisible();
    });

    it('drops a click’s "try again" once the file turns out to be gone', async () => {
      vi.stubGlobal('fetch', chipFetch({
        status: statusAnswers(200, 404),
        download: async () => new Response('{}', { status: 503 }),
      }));
      const view = render(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={1} />);
      fireEvent.click(screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not download this file just now. Try again.'));
      view.rerender(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={2} />);
      expect(await screen.findByRole('button', { name: 'Q3 plan #1.pdf is no longer available' })).toBeDisabled();
      // "Try again" next to a button that can't be pressed is a dead end.
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('cancels a check it no longer needs, and ignores what that check answers late', async () => {
      const asked: Array<{ answer: (r: Response) => void; signal: AbortSignal | undefined }> = [];
      // A fetch that answers even after it was cancelled: an answer can race
      // the cancel, and only the newest check may decide.
      vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((answer) => { asked.push({ answer, signal: init?.signal ?? undefined }); })));
      const view = render(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={1} />);
      await waitFor(() => expect(asked).toHaveLength(1));
      view.rerender(<GeneratedFileChip file={agentFile} conversationId="c1" recheckKey={2} />);
      await waitFor(() => expect(asked).toHaveLength(2));
      expect(asked[0]!.signal?.aborted).toBe(true);
      expect(asked[1]!.signal?.aborted).toBe(false);

      asked[1]!.answer(json({ available: true }));
      asked[0]!.answer(json({ error: 'file-not-found' }, 404));
      await settle();
      expect(screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' })).toBeEnabled();

      // Leaving the page cancels whatever is still being asked.
      view.unmount();
      expect(asked[1]!.signal?.aborted).toBe(true);
    });

    it('an attachment chip never checks', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const view = render(<GeneratedFileChip file={file} conversationId="c1" recheckKey={1} />);
      view.rerender(<GeneratedFileChip file={file} conversationId="c1" recheckKey={2} />);
      await settle();
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Download budget.csv' })).toBeEnabled();
    });

    it('inside a conversation, a chip checks again when the thread grows', async () => {
      // The walk's case: the agent deleted the file in a LATER turn while the
      // chip stayed on screen. With no `fileRecheckKey`, `AgentConversation`
      // hands the chip the thread's own length (`AgentView` passes the durable
      // read's, so live frames do not move it: see AgentView.test.tsx).
      const fetch = chipFetch({ status: statusAnswers(200, 404) });
      vi.stubGlobal('fetch', fetch);
      const reply: ThreadMessage = {
        kind: 'agent', id: 't1', text: 'Here is the plan.', at: '2026-11-01T09:00:00.000Z', attachments: [agentFile],
      };
      const view = render(<AgentConversation {...conversationProps([reply])} />);
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await settle();
      view.rerender(<AgentConversation {...conversationProps([reply])} />);
      await settle();
      expect(fetch).toHaveBeenCalledOnce();

      view.rerender(<AgentConversation {...conversationProps([reply, { kind: 'user', id: 'u2', text: 'Delete it.' }])} />);
      expect(await screen.findByRole('button', { name: 'Q3 plan #1.pdf is no longer available' })).toBeDisabled();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith(STATUS_URL, expect.anything());
    });
  });

  it('renders hostile filenames as bounded plain text with no image or external URL', () => {
    const view = render(<GeneratedFileChip file={{ ...file, displayName: '<img src=x onerror=alert(1)>' + 'a'.repeat(400), mediaType: 'image/png' }} conversationId="c1" />);
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')!.length).toBeLessThan(200);
    expect(view.container.textContent).toContain('<img');
  });
});
