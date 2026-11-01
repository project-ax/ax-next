import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GeneratedFileChip } from '../GeneratedFileChip';
import { saveBlob } from '@/lib/file-download';

vi.mock('@/lib/file-download', () => ({ saveBlob: vi.fn() }));
const file = { attachmentId: '0123456789abcdef0123456789abcdef', displayName: 'budget.csv', mediaType: 'text/csv', sizeBytes: 2048 };
beforeEach(() => { vi.mocked(saveBlob).mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

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
  });

  describe('agent-file chips (TASK-1012)', () => {
    const agentFile = { attachmentId: null, agentFilePath: 'reports/Q3 plan #1.pdf', displayName: 'Q3 plan #1.pdf', mediaType: 'application/pdf', sizeBytes: 10 };

    it('downloads live through the conversation route and never touches /api/files', async () => {
      const fetch = vi.fn(async () => new Response('pdf', { headers: { 'content-disposition': 'attachment; filename="Q3 plan #1.pdf"' } }));
      vi.stubGlobal('fetch', fetch);
      render(<GeneratedFileChip file={agentFile} conversationId="c & 1" />);
      const button = screen.getByRole('button', { name: 'Download Q3 plan #1.pdf' });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(saveBlob).toHaveBeenCalledOnce());
      expect(saveBlob).toHaveBeenLastCalledWith(expect.any(Blob), 'Q3 plan #1.pdf');
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith('/api/workspace/conversations/c%20%26%201/download/user-files/reports%2FQ3%20plan%20%231.pdf', { credentials: 'include' });
    });

    it.each([404, 400])('says the file is gone on a %i', async (status) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This file is no longer available to download.'));
      expect(saveBlob).not.toHaveBeenCalled();
    });

    it('keeps the generic retry copy on a 400 for an attachment-id chip', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
      render(<GeneratedFileChip file={file} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not download this file just now. Try again.'));
    });

    it('says the file is too big on a 413', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 413 })));
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
        'This file is too big for us to download. Ask the agent for a smaller copy, or to split it up.'));
    });

    it('shows the generic error, not a crash, when the key cannot be put in a URL', async () => {
      // A lone surrogate makes encodeURIComponent throw. It must not take the
      // render down, and it must not reach the network.
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
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
      render(<GeneratedFileChip file={agentFile} conversationId="c1" />);
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We could not download this file just now. Try again.'));
    });
  });

  it('renders hostile filenames as bounded plain text with no image or external URL', () => {
    const view = render(<GeneratedFileChip file={{ ...file, displayName: '<img src=x onerror=alert(1)>' + 'a'.repeat(400), mediaType: 'image/png' }} conversationId="c1" />);
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')!.length).toBeLessThan(200);
    expect(view.container.textContent).toContain('<img');
  });
});
