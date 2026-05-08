/**
 * ModelConfigTab tests.
 *
 * Pinned behaviors:
 *   1. Unconfigured provider models don't appear in the combobox.
 *   2. Configured provider models appear in the combobox groups.
 *   3. Selecting a model and clicking Save calls adminCredentials.create
 *      with the correct args.
 *   4. Save error shown near button.
 *   5. Empty selection is skipped (Save button disabled until a model is
 *      selected).
 *
 * Interaction pattern for ModelCombobox (Radix Popover + cmdk):
 *   1. fireEvent.click(comboboxButton) — opens the popover.
 *   2. fireEvent.click(screen.getByText('model-name')) — selects the model.
 *      cmdk calls onSelect with the item value, which triggers onChange.
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

/** Open a combobox popover and select a model by its display text. */
async function selectModel(comboboxButton: HTMLElement, modelName: string) {
  fireEvent.click(comboboxButton);
  // After clicking the trigger, the popover content is in the DOM (portal).
  await waitFor(() => {
    expect(screen.getByText(modelName)).toBeTruthy();
  });
  fireEvent.click(screen.getByText(modelName));
}

describe('ModelConfigTab', () => {
  it('unconfigured provider models do not appear in combobox', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [unconfiguredProvider] }),
    );
    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // None of the unconfigured provider's models should be in the DOM.
    expect(screen.queryByText('gpt-4o')).toBeNull();
    expect(screen.queryByText('gpt-4o-mini')).toBeNull();
  });

  it('configured provider models appear in combobox groups', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonOk({ providers: [configuredProvider] }),
    );
    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Open the first combobox to verify models are present.
    const comboboxes = screen.getAllByRole('combobox');
    fireEvent.click(comboboxes[0]!);

    await waitFor(() => {
      expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0);
    });
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // ROLES order: fast-model (index 0), runner-model (index 1).
    const comboboxes = screen.getAllByRole('combobox');
    const runnerCombobox = comboboxes[1]!;

    // Open the runner-model combobox and select a model.
    await selectModel(runnerCombobox, 'claude-sonnet-4-6');

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
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const comboboxes = screen.getAllByRole('combobox');
    await selectModel(comboboxes[0]!, 'claude-sonnet-4-6');

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
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Only select fast-model (index 0); leave runner-model empty.
    const comboboxes = screen.getAllByRole('combobox');
    await selectModel(comboboxes[0]!, 'claude-opus-4-7');

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
