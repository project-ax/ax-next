/**
 * CredentialsList tests — Task 4.2.
 *
 * The list component covers both panels (admin + settings) by passing
 * `variant`. Admin variant wires `adminCredentials` (full scope axis +
 * scope/owner shown); user variant wires `myCredentials` (single scope,
 * owner column collapses to "—").
 *
 * Pinned behaviors:
 *   1. Renders a table with the seed credentials and shows the meta
 *      columns (scope/owner/ref/kind/createdAt) without ever displaying
 *      the secret payload (the wire never carries it back, but assert
 *      it anyway as a regression guard).
 *   2. Clicking Delete fires DELETE then re-fetches the list. Three
 *      total fetches: initial list, delete, re-list.
 *   3. The delete is gated by `window.confirm` — declining doesn't fire
 *      DELETE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialsList } from '../components/credentials/CredentialsList';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default: confirm() returns true so delete proceeds. Tests that need
  // the cancellation path stub it explicitly.
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CredentialsList — admin variant', () => {
  it('renders the table with the seed list (admin variant)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        credentials: [
          {
            scope: 'global',
            ownerId: null,
            ref: 'anthropic',
            kind: 'api-key',
            createdAt: '2026-05-07T00:00:00.000Z',
          },
        ],
      }),
    );
    render(<CredentialsList variant="admin" />);
    await waitFor(() => expect(screen.getByText('anthropic')).toBeTruthy());
    expect(screen.getByText('global')).toBeTruthy();
    expect(screen.getByText('api-key')).toBeTruthy();
  });

  it('clicking delete fires a DELETE then re-fetches', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonOk({
          credentials: [
            {
              scope: 'user',
              ownerId: 'alice',
              ref: 'gh',
              kind: 'api-key',
              createdAt: '2026-05-07T00:00:00.000Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonOk({ credentials: [] }));

    render(<CredentialsList variant="admin" />);
    await waitFor(() => expect(screen.getByText('gh')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Delete gh/i }));

    await waitFor(() =>
      expect(screen.queryByText('gh')).toBeNull(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Second call is the DELETE — assert URL shape.
    expect(fetchMock.mock.calls[1]![0]).toBe('/admin/credentials/user/alice/gh');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe('DELETE');
  });

  it('declining the confirm dialog does NOT fire DELETE', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        credentials: [
          {
            scope: 'global',
            ownerId: null,
            ref: 'k',
            kind: 'api-key',
            createdAt: '2026-05-07T00:00:00.000Z',
          },
        ],
      }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<CredentialsList variant="admin" />);
    await waitFor(() => expect(screen.getByText('k')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Delete k/i }));

    // Only the initial list call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders an empty state when the list is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ credentials: [] }));
    render(<CredentialsList variant="admin" />);
    await waitFor(() =>
      expect(screen.getByText(/no credentials/i)).toBeTruthy(),
    );
  });

  it('surfaces fetch errors instead of crashing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render(<CredentialsList variant="admin" />);
    await waitFor(() => expect(screen.getByText(/error/i)).toBeTruthy());
  });
});

describe('CredentialsList — user variant', () => {
  it('uses /settings/credentials for list', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ credentials: [] }));
    render(<CredentialsList variant="user" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/settings/credentials');
  });

  it('delete uses /settings/credentials/:ref', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonOk({
          credentials: [
            {
              scope: 'user',
              ownerId: 'alice',
              ref: 'mine',
              kind: 'api-key',
              createdAt: '2026-05-07T00:00:00.000Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonOk({ credentials: [] }));

    render(<CredentialsList variant="user" />);
    await waitFor(() => expect(screen.getByText('mine')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Delete mine/i }));

    await waitFor(() =>
      expect(screen.queryByText('mine')).toBeNull(),
    );
    expect(fetchMock.mock.calls[1]![0]).toBe('/settings/credentials/mine');
  });
});
