import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpFetch } from '@/lib/http';
import { VISUAL_FETCH_TIMEOUT_MS, loadVisualHtml } from '../visual-source';

vi.mock('@/lib/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http')>()),
  httpFetch: vi.fn(),
}));

const fetchMock = vi.mocked(httpFetch);

/** A fetch that never answers, but does honor its abort signal like the real one. */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('loadVisualHtml', () => {
  it('gives up on a hung fetch after the timeout and forgets it, so the next load retries', async () => {
    fetchMock.mockImplementation(hangingFetch);
    const first = loadVisualHtml('c-hang', 'art-hang');
    const settled = first.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(VISUAL_FETCH_TIMEOUT_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toBe('rejected');

    fetchMock.mockResolvedValue(new Response('<p>chart</p>', { status: 200 }));
    await expect(loadVisualHtml('c-hang', 'art-hang')).resolves.toBe('<p>chart</p>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes an abort signal to the fetch and caches a success', async () => {
    fetchMock.mockResolvedValue(new Response('<p>ok</p>', { status: 200 }));
    await expect(loadVisualHtml('c-ok', 'art-ok')).resolves.toBe('<p>ok</p>');
    await expect(loadVisualHtml('c-ok', 'art-ok')).resolves.toBe('<p>ok</p>');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/files?conversationId=c-ok&id=art-ok', {
      signal: expect.any(AbortSignal),
    });
  });
});
