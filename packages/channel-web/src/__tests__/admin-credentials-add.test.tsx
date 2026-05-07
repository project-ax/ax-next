/**
 * ApiKeyForm + OAuthFlowForm + CredentialAddMenu tests — Task 4.3.
 *
 * Pinned behaviors:
 *
 *   - ApiKeyForm: shows scope picker IFF variant='admin'; submit POSTs
 *     with base64-encoded payload; success calls `onAdded` then resets
 *     state. Settings variant omits scope/ownerId from the body.
 *   - OAuthFlowForm: clicking "Open" calls `oauthStart`, opens a window
 *     with `noopener,noreferrer`, stashes pendingId in component state.
 *     Submitting the code calls `oauthFinish` with the stashed pendingId.
 *   - CredentialAddMenu: opens a kind-picker (api-key, anthropic-oauth,
 *     etc.); selecting api-key renders ApiKeyForm; selecting an oauth
 *     kind renders OAuthFlowForm.
 *
 * The wire-client surface is mocked via global fetch — we don't bring up
 * a real bus here. The handlers under test in @ax/credentials-admin-routes
 * cover the server side.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { ApiKeyForm } from '../components/credentials/ApiKeyForm';
import { OAuthFlowForm } from '../components/credentials/OAuthFlowForm';
import { CredentialAddMenu } from '../components/credentials/CredentialAddMenu';

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

describe('ApiKeyForm', () => {
  it('admin variant shows scope picker; settings variant does not', () => {
    const onAdded = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ApiKeyForm variant="admin" onAdded={onAdded} onCancel={onCancel} />,
    );
    expect(screen.getByLabelText(/scope/i)).toBeTruthy();
    rerender(
      <ApiKeyForm variant="user" onAdded={onAdded} onCancel={onCancel} />,
    );
    expect(screen.queryByLabelText(/scope/i)).toBeNull();
  });

  it('admin POSTs with scope/ownerId + base64 payload, then calls onAdded', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ credential: { scope: 'global', ref: 'k', kind: 'api-key' } }, 201),
    );
    const onAdded = vi.fn();
    render(
      <ApiKeyForm variant="admin" onAdded={onAdded} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/^ref$/i), {
      target: { value: 'anthropic' },
    });
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: 'sk-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/admin/credentials');
    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      scope: 'global',
      ownerId: null,
      ref: 'anthropic',
      kind: 'api-key',
    });
    // base64 of 'sk-test'
    expect(body.payload).toBe(Buffer.from('sk-test').toString('base64'));
    // Plaintext doesn't traverse the wire:
    expect(JSON.stringify(body)).not.toContain('sk-test');
  });

  it('settings variant POSTs to /settings/credentials without scope/ownerId', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ credential: {} }, 201));
    const onAdded = vi.fn();
    render(
      <ApiKeyForm variant="user" onAdded={onAdded} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/^ref$/i), {
      target: { value: 'mine' },
    });
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: 'sk-x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('/settings/credentials');
    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('scope');
    expect(body).not.toHaveProperty('ownerId');
    expect(body.ref).toBe('mine');
  });

  it('non-2xx response surfaces an error and does NOT call onAdded', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
    const onAdded = vi.fn();
    render(
      <ApiKeyForm variant="user" onAdded={onAdded} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(/^ref$/i), {
      target: { value: 'r' },
    });
    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe('OAuthFlowForm', () => {
  it('clicking Open POSTs oauth/start, opens window with noopener+noreferrer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        pendingId: 'pend-12345678901234567890',
        authorizeUrl: 'https://provider/authorize?x=1',
        instructions: 'paste',
      }),
    );
    const openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);

    render(
      <OAuthFlowForm
        variant="admin"
        kind="anthropic-oauth"
        onAdded={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^ref$/i), {
      target: { value: 'a' },
    });
    fireEvent.click(screen.getByRole('button', { name: /open/i }));

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/admin/credentials/oauth/start');
    // window.open args: url, target, features
    expect(openSpy.mock.calls[0]![0]).toBe('https://provider/authorize?x=1');
    expect(openSpy.mock.calls[0]![2]).toMatch(/noopener/);
    expect(openSpy.mock.calls[0]![2]).toMatch(/noreferrer/);
  });

  it('submitting the code POSTs oauth/finish with the stashed pendingId', async () => {
    // Step 1: start.
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        pendingId: 'pend-12345678901234567890',
        authorizeUrl: 'https://provider/authorize',
        instructions: 'paste',
      }),
    );
    // Step 2: finish.
    fetchMock.mockResolvedValueOnce(
      jsonOk({ credential: { ref: 'a', kind: 'anthropic-oauth' } }, 201),
    );
    vi.spyOn(window, 'open').mockImplementation(() => null);

    const onAdded = vi.fn();
    render(
      <OAuthFlowForm
        variant="admin"
        kind="anthropic-oauth"
        onAdded={onAdded}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^ref$/i), {
      target: { value: 'a' },
    });
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    // After start resolves, code field appears.
    await waitFor(() => expect(screen.getByLabelText(/code/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/code/i), {
      target: { value: 'auth-code-xyz' },
    });
    fireEvent.click(screen.getByRole('button', { name: /finish/i }));

    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const finishCall = fetchMock.mock.calls[1]!;
    expect(finishCall[0]).toBe('/admin/credentials/oauth/finish');
    const body = JSON.parse(
      (finishCall[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      pendingId: 'pend-12345678901234567890',
      code: 'auth-code-xyz',
    });
  });
});

describe('CredentialAddMenu', () => {
  it('opens with kind options after listKinds resolves', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        kinds: [
          { kind: 'api-key', flow: 'paste' },
          { kind: 'anthropic-oauth', flow: 'oauth' },
        ],
      }),
    );
    render(
      <CredentialAddMenu variant="admin" onAdded={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^api-key$/i })).toBeTruthy(),
    );
    expect(
      screen.getByRole('button', { name: /^anthropic-oauth$/i }),
    ).toBeTruthy();
  });

  it('selecting api-key opens the ApiKeyForm', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        kinds: [
          { kind: 'api-key', flow: 'paste' },
          { kind: 'anthropic-oauth', flow: 'oauth' },
        ],
      }),
    );
    render(<CredentialAddMenu variant="admin" onAdded={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^api-key$/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^api-key$/i }));
    // The api-key form's distinctive field:
    expect(screen.getByLabelText(/api key/i)).toBeTruthy();
  });

  it('selecting an oauth kind opens the OAuthFlowForm', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        kinds: [
          { kind: 'api-key', flow: 'paste' },
          { kind: 'anthropic-oauth', flow: 'oauth' },
        ],
      }),
    );
    render(<CredentialAddMenu variant="admin" onAdded={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /add credential/i }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^anthropic-oauth$/i }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /^anthropic-oauth$/i }),
    );
    // The oauth form's distinctive button:
    expect(screen.getByRole('button', { name: /open/i })).toBeTruthy();
  });
});
