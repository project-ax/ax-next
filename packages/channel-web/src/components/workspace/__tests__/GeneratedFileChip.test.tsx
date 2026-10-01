import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GeneratedFileChip } from '../GeneratedFileChip';
import { saveBlob } from '@/lib/file-download';

vi.mock('@/lib/file-download', () => ({ saveBlob: vi.fn() }));
const file = { path: 'reports/a & b.csv', displayName: 'budget.csv', mediaType: 'text/csv', sizeBytes: 2048 };
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
    expect(fetch).toHaveBeenCalledWith('/api/files?path=reports%2Fa%20%26%20b.csv&conversationId=c%20%26%201', { credentials: 'include' });
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

  it('renders hostile filenames as bounded plain text with no image or external URL', () => {
    const view = render(<GeneratedFileChip file={{ ...file, displayName: '<img src=x onerror=alert(1)>' + 'a'.repeat(400), mediaType: 'image/png' }} conversationId="c1" />);
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')!.length).toBeLessThan(200);
    expect(view.container.textContent).toContain('<img');
  });
});
