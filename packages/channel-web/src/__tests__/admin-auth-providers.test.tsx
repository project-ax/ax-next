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
 *   7. Delete is gated by a styled confirm dialog; Cancel cancels the call.
 *   8. Save error renders inline; the form stays open.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
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

  // A second enabled provider, so turning Google off is NOT the lockout case.
  // (TASK-342/D5 added a confirmation for the last enabled one; this test is
  // about the ordinary path, which must stay a single unceremonious click.)
  const githubEntry = {
    ...googleEntry,
    kind: 'github' as const,
    clientId: 'gh-client-id',
  };

  it('toggle PATCHes the new enabled state and refetches', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [googleEntry, githubEntry] }),
    );
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true })); // PATCH
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [{ ...googleEntry, enabled: false }, githubEntry] }),
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

  /**
   * TASK-342 / audit D5 — turning off the LAST enabled sign-in method locks
   * every user out of the deployment, the admin doing it included, with no way
   * back through the UI. It used to be one unremarkable click on a toggle that
   * looked exactly like the others.
   */
  describe('the last enabled sign-in method asks first', () => {
    it('does not PATCH until the admin confirms', async () => {
      fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));

      render(<AuthProvidersTab />);
      await waitFor(() => screen.getByRole('switch', { name: /Disable Google/i }));
      fireEvent.click(screen.getByRole('switch', { name: /Disable Google/i }));

      expect(
        await screen.findByText(/turn off the only way to sign in\?/i),
      ).toBeTruthy();
      expect(screen.getByText(/lock everyone out/i)).toBeTruthy();
      // Still exactly one call: the initial list. Nothing has been changed.
      expect(fetchMock.mock.calls).toHaveLength(1);
    });

    it('changes nothing when the admin backs out', async () => {
      fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));

      render(<AuthProvidersTab />);
      await waitFor(() => screen.getByRole('switch', { name: /Disable Google/i }));
      fireEvent.click(screen.getByRole('switch', { name: /Disable Google/i }));
      fireEvent.click(await screen.findByRole('button', { name: /keep it on/i }));

      await waitFor(() =>
        expect(screen.queryByText(/turn off the only way to sign in\?/i)).toBeNull(),
      );
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(screen.getByRole('switch', { name: /Disable Google/i })).toBeTruthy();
    });

    it('goes through when the admin means it', async () => {
      // We warn; we do not refuse. An operator who has decided to take the
      // deployment offline is allowed to.
      fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));
      fetchMock.mockResolvedValueOnce(jsonOk({ ok: true })); // PATCH
      fetchMock.mockResolvedValueOnce(
        jsonOk({ providers: [{ ...googleEntry, enabled: false }] }),
      );

      render(<AuthProvidersTab />);
      await waitFor(() => screen.getByRole('switch', { name: /Disable Google/i }));
      fireEvent.click(screen.getByRole('switch', { name: /Disable Google/i }));
      fireEvent.click(
        await screen.findByRole('button', { name: /turn it off anyway/i }),
      );

      await waitFor(() => expect(fetchMock.mock.calls).toHaveLength(3));
      const patchCall = fetchMock.mock.calls[1]!;
      expect(patchCall[0]).toBe('/admin/auth/providers/google');
      expect(JSON.parse(patchCall[1].body)).toEqual({ enabled: false });
    });

    it('asks nothing when turning one back ON', async () => {
      // The guard is about REMOVING the last way in, not about adding one.
      fetchMock.mockResolvedValueOnce(
        jsonOk({ providers: [{ ...googleEntry, enabled: false }] }),
      );
      fetchMock.mockResolvedValueOnce(jsonOk({ ok: true }));
      fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));

      render(<AuthProvidersTab />);
      await waitFor(() => screen.getByRole('switch', { name: /Enable Google/i }));
      fireEvent.click(screen.getByRole('switch', { name: /Enable Google/i }));

      await waitFor(() => expect(fetchMock.mock.calls).toHaveLength(3));
      expect(screen.queryByText(/turn off the only way to sign in\?/i)).toBeNull();
    });
  });

  it('delete is gated by a styled dialog; Cancel cancels the request', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));
    const confirmSpy = vi.spyOn(window, 'confirm');

    render(<AuthProvidersTab />);
    await waitFor(() => screen.getByRole('button', { name: /Remove Google/i }));
    fireEvent.click(screen.getByRole('button', { name: /Remove Google/i }));

    // A styled dialog appears (no OS confirm).
    await waitFor(() => expect(screen.getByText('Remove provider?')).toBeTruthy());
    expect(confirmSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByText('Remove provider?')).toBeNull(),
    );
    // Only the initial list call — DELETE was not issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('delete calls DELETE after confirming in the dialog and refetches', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [googleEntry] }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));

    render(<AuthProvidersTab />);
    await waitFor(() => screen.getByRole('button', { name: /Remove Google/i }));
    fireEvent.click(screen.getByRole('button', { name: /Remove Google/i }));

    // Confirm in the dialog — its action button is "Remove".
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Remove$/i }));

    await waitFor(() =>
      expect(screen.getByText(/No identity providers configured/i)).toBeTruthy(),
    );
    const deleteCall = fetchMock.mock.calls[1]!;
    expect(deleteCall[0]).toBe('/admin/auth/providers/google');
    expect(deleteCall[1].method).toBe('DELETE');
    expect(deleteCall[1].headers['x-requested-with']).toBe('ax-admin');
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

  /**
   * TASK-342 / audit D4 — this form asked a non-technical admin for a Client
   * ID, a Client secret and a Discovery URL, and explained none of them. None
   * of the three is guessable if you have never registered an OAuth app.
   */
  describe('every provider field explains itself', () => {
    const openForm = async () => {
      fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
      render(<AuthProvidersTab />);
      fireEvent.click(await screen.findByRole('button', { name: /add provider/i }));
    };

    /** A field's help must be REACHABLE, not merely nearby — so check the wiring. */
    const hintFor = (label: string | RegExp): string => {
      const control = screen.getByLabelText(label);
      const id = control.getAttribute('aria-describedby');
      expect(id).not.toBeNull();
      return document.getElementById(id!)?.textContent ?? '';
    };

    it('explains what each OAuth value is and where it comes from', async () => {
      await openForm();
      expect(hintFor('Provider')).toMatch(/sign in/i);
      expect(hintFor('Client ID')).toMatch(/register ax as an application/i);
      expect(hintFor('Client secret')).toMatch(/like a password/i);
    });

    it('glosses Discovery URL by the names a provider’s docs actually use', async () => {
      await openForm();
      fireEvent.change(screen.getByLabelText('Provider'), {
        target: { value: 'oidc' },
      });
      expect(hintFor('Discovery URL')).toMatch(/well-known configuration/i);
    });

    it('says what leaving the domain allow-list blank actually means', async () => {
      // The security-relevant default: blank means anyone at that provider.
      await openForm();
      expect(hintFor(/Allowed email domains/)).toMatch(/anyone with an account/i);
    });
  });
});
