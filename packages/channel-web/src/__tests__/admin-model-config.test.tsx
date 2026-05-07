/**
 * ModelConfigTab tests.
 *
 * Pinned behaviors:
 *   1. Unconfigured provider models don't appear in select.
 *   2. Configured provider models appear under provider optgroup.
 *   3. Selecting a model and clicking Save calls adminCredentials.create
 *      with the correct args.
 *   4. Save error shown near button.
 *   5. Empty selection is skipped (Save button disabled until a model is
 *      selected).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelConfigTab } from '../components/admin/ModelConfigTab';

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

const configuredProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  ref: 'anthropic',
  models: ['claude-sonnet-4-6', 'claude-opus-4-7'],
  configured: true,
};

const unconfiguredProvider = {
  id: 'openai',
  name: 'OpenAI',
  ref: 'openai',
  models: ['gpt-4o', 'gpt-4o-mini'],
  configured: false,
};

describe('ModelConfigTab', () => {
  it('unconfigured provider models do not appear in select', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [unconfiguredProvider] }),
    );
    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // None of the unconfigured provider's models should be in the DOM.
    expect(screen.queryByText('gpt-4o')).toBeNull();
    expect(screen.queryByText('gpt-4o-mini')).toBeNull();
  });

  it('configured provider models appear under provider optgroup', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [configuredProvider] }),
    );
    render(<ModelConfigTab />);
    await waitFor(() => {
      expect(screen.getAllByText('claude-sonnet-4-6')).toBeTruthy();
    });
    // Both models from the configured provider should be present.
    // (getAllByText returns at least one element each for the two selects.)
    expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude-opus-4-7').length).toBeGreaterThan(0);
  });

  it('selecting a model and clicking Save calls adminCredentials.create with correct args', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [configuredProvider] }),
    );
    // adminCredentials.create → POST /admin/credentials
    fetchMock.mockResolvedValueOnce(
      jsonOk({ credential: { scope: 'global', ref: 'setting.runner-model', kind: 'setting' } }, 201),
    );

    render(<ModelConfigTab />);
    await waitFor(() => expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0));

    // Select the runner-model picker (second role) and choose a model.
    const selects = screen.getAllByRole('combobox');
    // ROLES order: fast-model (index 0), runner-model (index 1).
    const runnerSelect = selects[1]!;
    fireEvent.change(runnerSelect, { target: { value: 'claude-sonnet-4-6' } });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/admin/credentials' &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCalls.length).toBeGreaterThan(0);

      const body = JSON.parse((postCalls[0]![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.scope).toBe('global');
      expect(body.ownerId).toBeNull();
      expect(body.ref).toBe('setting.runner-model');
      expect(body.kind).toBe('setting');
      // payload is base64-encoded by adminCredentials.create.
      expect(body.payload).toBe(Buffer.from('claude-sonnet-4-6').toString('base64'));
    });
  });

  it('save error is shown near the button', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [configuredProvider] }),
    );
    // POST fails.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<ModelConfigTab />);
    await waitFor(() => expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0));

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'claude-sonnet-4-6' } });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  });

  it('Save button is disabled when no model is selected', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [configuredProvider] }),
    );
    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const saveBtn = screen.getByRole('button', { name: /Save changes/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('empty selection roles are skipped — only selected roles are POSTed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [configuredProvider] }),
    );
    // Only one POST (for the one role selected).
    fetchMock.mockResolvedValueOnce(
      jsonOk({ credential: { scope: 'global', ref: 'setting.fast-model', kind: 'setting' } }, 201),
    );

    render(<ModelConfigTab />);
    await waitFor(() => expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0));

    // Only select fast-model (index 0); leave runner-model empty.
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'claude-opus-4-7' } });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/admin/credentials' &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      // Only one POST — runner-model was empty and was skipped.
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse((postCalls[0]![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      expect(body.ref).toBe('setting.fast-model');
    });
  });
});
