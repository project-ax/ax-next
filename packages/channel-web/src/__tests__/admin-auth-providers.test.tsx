/**
 * AuthProvidersTab + AddProviderForm tests.
 *
 * Pinned behaviors:
 *   1. Fetches providers on mount; shows kind labels.
 *   2. Empty state when zero providers configured.
 *   3. "Add provider" reveals the AddProviderForm.
 *   4. Submit POSTs the right body shape (incl. CSRF header) and refetches.
 *   5. discoveryUrl field appears only when kind === 'oidc'.
 *   6. Toggle calls PATCH and refetches.
 *   7. Delete is gated by window.confirm; declining cancels the call.
 *   8. Save error renders inline; the form stays open.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthProvidersTab } from '../components/admin/AuthProvidersTab';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const googleEntry = {
  kind: 'google' as const,
  clientId: '123.apps.googleusercontent.com',
  discoveryUrl: null,
  allowedDomains: null,
  enabled: true,
  createdAt: '2026-05-08T00:00:00Z',
  updatedAt: '2026-05-08T00:00:00Z',
};

describe('AuthProvidersTab', () => {
  it('fetches on mount and renders provider rows by kind label', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));
    render(<AuthProvidersTab />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    expect(fetchMock.mock.calls[0]![0]).toBe('/admin/auth/providers');
    expect(screen.getByText('123.apps.googleusercontent.com')).toBeTruthy();
  });

  it('shows the empty state when no providers are configured', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    render(<AuthProvidersTab />);
    await waitFor(() =>
      expect(screen.getByText(/No identity providers configured/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /Add provider/i })).toBeTruthy();
  });

  it('clicking "Add provider" reveals the AddProviderForm', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    render(<AuthProvidersTab />);
    await waitFor(() =>
      screen.getByRole('button', { name: /Add provider/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Add provider/i }));
    expect(screen.getByLabelText('Provider')).toBeTruthy();
    expect(screen.getByLabelText('Client ID')).toBeTruthy();
    expect(screen.getByLabelText('Client secret')).toBeTruthy();
  });

  it('discoveryUrl is hidden by default and shown when kind=oidc', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    render(<AuthProvidersTab />);
    await waitFor(() =>
      screen.getByRole('button', { name: /Add provider/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Add provider/i }));
    // Default kind=google → no discovery URL field.
    expect(screen.queryByLabelText(/Discovery URL/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'oidc' } });
    expect(screen.getByLabelText(/Discovery URL/i)).toBeTruthy();
  });

  it('submit POSTs the upsert with CSRF header and refetches on 201', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] })); // initial list
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true }, 201)); // POST upsert
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] })); // refetch

    render(<AuthProvidersTab />);
    await waitFor(() =>
      screen.getByRole('button', { name: /Add provider/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Add provider/i }));

    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'cid' },
    });
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'csecret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());

    const upsertCall = fetchMock.mock.calls[1]!;
    expect(upsertCall[0]).toBe('/admin/auth/providers');
    expect(upsertCall[1].method).toBe('POST');
    expect(upsertCall[1].headers['x-requested-with']).toBe('ax-admin');
    expect(JSON.parse(upsertCall[1].body)).toEqual({
      kind: 'google',
      clientId: 'cid',
      clientSecret: 'csecret',
    });
  });

  it('toggle PATCHes the new enabled state and refetches', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true })); // PATCH
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [{ ...googleEntry, enabled: false }] }),
    );

    render(<AuthProvidersTab />);
    await waitFor(() => screen.getByRole('switch', { name: /Disable Google/i }));
    fireEvent.click(screen.getByRole('switch', { name: /Disable Google/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: /Enable Google/i }),
      ).toBeTruthy(),
    );
    const patchCall = fetchMock.mock.calls[1]!;
    expect(patchCall[0]).toBe('/admin/auth/providers/google');
    expect(patchCall[1].method).toBe('PATCH');
    expect(JSON.parse(patchCall[1].body)).toEqual({ enabled: false });
  });

  it('delete is gated by window.confirm; declining cancels the request', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);

    render(<AuthProvidersTab />);
    await waitFor(() => screen.getByRole('button', { name: /Remove Google/i }));
    fireEvent.click(screen.getByRole('button', { name: /Remove Google/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Only the initial list call — DELETE was not issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('delete calls DELETE on confirm and refetches', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    render(<AuthProvidersTab />);
    await waitFor(() => screen.getByRole('button', { name: /Remove Google/i }));
    fireEvent.click(screen.getByRole('button', { name: /Remove Google/i }));

    await waitFor(() =>
      expect(screen.getByText(/No identity providers configured/i)).toBeTruthy(),
    );
    const deleteCall = fetchMock.mock.calls[1]!;
    expect(deleteCall[0]).toBe('/admin/auth/providers/google');
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[1].headers['x-requested-with']).toBe('ax-admin');
    confirmSpy.mockRestore();
  });

  it('save error renders inline; form stays open', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(
      new Response('client_id required', { status: 400 }),
    );

    render(<AuthProvidersTab />);
    await waitFor(() => screen.getByRole('button', { name: /Add provider/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add provider/i }));

    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'cid' },
    });
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'csecret' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() =>
      expect(screen.getByText(/client_id required/)).toBeTruthy(),
    );
    // Form still open — Retry button visible.
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });
});
