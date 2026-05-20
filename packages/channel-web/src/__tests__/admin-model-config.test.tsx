/**
 * ModelConfigTab tests.
 *
 * Pinned behaviors:
 *   1. Unconfigured provider models don't appear in the combobox.
 *   2. Configured provider models appear in the combobox groups.
 *   3. Selecting a model and clicking Save calls PUT /admin/settings/fast-model
 *      with `{value: "<providerId>/<modelId>"}`.
 *   4. Save error shown near button.
 *   5. Save is disabled when no model is selected.
 *   6. The existing setting (GET /admin/settings/fast-model) preselects the
 *      combobox so the operator sees what's currently in effect.
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

/**
 * Default fetch script: providers list + an empty setting (no current
 * selection). Override before render() when a test wants other shapes.
 */
function defaultFetchScript(providers: typeof configuredProvider[]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/admin/credentials/providers') {
      return jsonOk({ providers });
    }
    if (url === '/admin/settings/fast-model') {
      return jsonOk({ value: null });
    }
    return new Response(null, { status: 404 });
  });
}

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
    defaultFetchScript([unconfiguredProvider]);
    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText('gpt-4o')).toBeNull();
    expect(screen.queryByText('gpt-4o-mini')).toBeNull();
  });

  it('configured provider models appear in combobox groups', async () => {
    defaultFetchScript([configuredProvider]);
    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const combobox = screen.getByRole('combobox');
    fireEvent.click(combobox);

    await waitFor(() => {
      expect(screen.getAllByText('claude-sonnet-4-6').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('claude-opus-4-7').length).toBeGreaterThan(0);
  });

  it('selecting a model and clicking Save PUTs /admin/settings/fast-model with the canonical provider/model ref', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/credentials/providers' && (init?.method ?? 'GET') === 'GET') {
        return jsonOk({ providers: [configuredProvider] });
      }
      if (url === '/admin/settings/fast-model' && (init?.method ?? 'GET') === 'GET') {
        return jsonOk({ value: null });
      }
      if (url === '/admin/settings/fast-model' && init?.method === 'PUT') {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });

    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const combobox = screen.getByRole('combobox');
    await selectModel(combobox, 'claude-sonnet-4-6');

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        ([url, opts]) =>
          url === '/admin/settings/fast-model' &&
          (opts as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCalls).toHaveLength(1);

      const body = JSON.parse((putCalls[0]![1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      // Canonical `provider/model-id` ref. Provider chosen by which
      // configured-providers group claims the model id.
      expect(body.value).toBe('anthropic/claude-sonnet-4-6');
    });
  });

  it('preselects the model id from an existing /admin/settings/fast-model value', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/credentials/providers') {
        return jsonOk({ providers: [configuredProvider] });
      }
      if (url === '/admin/settings/fast-model') {
        // GET returns a stored ref — the tab should preselect 'claude-opus-4-7'.
        return jsonOk({ value: 'anthropic/claude-opus-4-7' });
      }
      return new Response(null, { status: 404 });
    });

    render(<ModelConfigTab />);

    // The "Currently · <model>" caption renders the parsed model id; the
    // combobox button also shows it. Multiple matches are fine — what we
    // care about is that the storage value flowed into state.
    await waitFor(() => {
      expect(screen.getAllByText('claude-opus-4-7').length).toBeGreaterThan(0);
    });
  });

  it('save error is shown near the button', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/admin/credentials/providers') {
        return jsonOk({ providers: [configuredProvider] });
      }
      if (url === '/admin/settings/fast-model' && (init?.method ?? 'GET') === 'GET') {
        return jsonOk({ value: null });
      }
      if (url === '/admin/settings/fast-model' && init?.method === 'PUT') {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    });

    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const combobox = screen.getByRole('combobox');
    await selectModel(combobox, 'claude-sonnet-4-6');

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  });

  it('Save button is disabled when no model is selected', async () => {
    defaultFetchScript([configuredProvider]);
    render(<ModelConfigTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const saveBtn = screen.getByRole('button', { name: /Save changes/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });
});
