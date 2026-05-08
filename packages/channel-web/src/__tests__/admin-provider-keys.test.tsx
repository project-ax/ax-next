/**
 * ProviderKeysTab + ProviderKeyForm tests.
 *
 * Pinned behaviors:
 *   1. Fetches providers on mount and renders provider names.
 *   2. Unconfigured provider shows "Add key" button.
 *   3. Configured provider shows "Configured" badge and "Edit" button.
 *   4. Clicking "Add key" opens ProviderKeyForm for that row.
 *   5. Clicking "Edit" opens ProviderKeyForm for that row.
 *   6. Opening a second row closes the first.
 *   7. Save: calls validateProviderKey, on success refetches + closes row.
 *   8. Save error: shows error message in row, keeps row open.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderKeysTab } from '../components/admin/ProviderKeysTab';

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

const unconfiguredProvider = {
  id: 'openai',
  name: 'OpenAI',
  ref: 'openai',
  models: ['gpt-4o', 'gpt-4o-mini'],
  configured: false,
};

const configuredProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  ref: 'anthropic',
  models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
  configured: true,
};

describe('ProviderKeysTab', () => {
  it('fetches providers on mount and renders provider names', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [unconfiguredProvider, configuredProvider] }),
    );
    render(<ProviderKeysTab />);
    await waitFor(() => {
      expect(screen.getByText('OpenAI')).toBeTruthy();
      expect(screen.getByText('Anthropic')).toBeTruthy();
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('/admin/credentials/providers');
  });

  it('unconfigured provider shows "Add key" button (no Configured badge)', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [unconfiguredProvider] }));
    render(<ProviderKeysTab />);
    await waitFor(() => expect(screen.getByText('OpenAI')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Add key/i })).toBeTruthy();
    expect(screen.queryByText('Configured')).toBeNull();
  });

  it('configured provider shows "Configured" badge and "Edit" button', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [configuredProvider] }));
    render(<ProviderKeysTab />);
    await waitFor(() => expect(screen.getByText('Anthropic')).toBeTruthy());
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Edit key$/i })).toBeTruthy();
  });

  it('clicking "Add key" opens ProviderKeyForm for that row', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [unconfiguredProvider] }));
    render(<ProviderKeysTab />);
    await waitFor(() => screen.getByRole('button', { name: /Add key/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add key/i }));
    expect(screen.getByLabelText(/API key/i)).toBeTruthy();
  });

  it('clicking "Edit" opens ProviderKeyForm for that row', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [configuredProvider] }));
    render(<ProviderKeysTab />);
    await waitFor(() => screen.getByRole('button', { name: /^Edit key$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Edit key$/i }));
    expect(screen.getByLabelText(/API key/i)).toBeTruthy();
  });

  it('opening a second row closes the first (one row open at a time)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [unconfiguredProvider, configuredProvider] }),
    );
    render(<ProviderKeysTab />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Add key/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /^Edit key$/i })).toBeTruthy();
    });

    // Open first row (unconfigured → Add key).
    fireEvent.click(screen.getByRole('button', { name: /Add key/i }));
    // Form is open — only one API key input.
    expect(screen.getAllByLabelText(/API key/i)).toHaveLength(1);

    // Open second row (configured → Edit).
    // After the first row opens, its button is hidden; the Edit button remains for the other row.
    fireEvent.click(screen.getByRole('button', { name: /^Edit key$/i }));
    // Still only one input — first row collapsed, second row opened.
    expect(screen.getAllByLabelText(/API key/i)).toHaveLength(1);
  });

  it('save: calls validateProviderKey, on success refetches and closes row', async () => {
    // Initial list.
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [unconfiguredProvider] }));
    // validateProviderKey POST → /admin/credentials/providers/openai/validate
    fetchMock.mockResolvedValueOnce(
      jsonOk({ provider: { id: 'openai', name: 'OpenAI', ref: 'openai', configured: true } }),
    );
    // Refetch after success — now configured.
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [{ ...unconfiguredProvider, configured: true }] }),
    );

    render(<ProviderKeysTab />);
    await waitFor(() => screen.getByRole('button', { name: /Add key/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add key/i }));

    const input = screen.getByLabelText(/API key/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      // Row should be closed (no form input visible).
      expect(screen.queryByLabelText(/API key/i)).toBeNull();
    });

    // Validate endpoint was called.
    const validateCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/validate'),
    );
    expect(validateCall).toBeTruthy();
    expect(validateCall![0]).toBe('/admin/credentials/providers/openai/validate');
  });

  it('save error: shows error message in row, keeps row open', async () => {
    // Initial list.
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [unconfiguredProvider] }));
    // validateProviderKey POST → 422 with error message.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(<ProviderKeysTab />);
    await waitFor(() => screen.getByRole('button', { name: /Add key/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add key/i }));

    fireEvent.change(screen.getByLabelText(/API key/i), {
      target: { value: 'bad-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText(/Invalid API key/i)).toBeTruthy();
    });

    // Row stays open — form input is still there.
    expect(screen.getByLabelText(/API key/i)).toBeTruthy();
    // Button changes to "Retry".
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });
});
