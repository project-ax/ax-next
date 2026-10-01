/** Helper model choices follow the saved enabled-model policy and shared catalog. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelConfigTab } from '../components/admin/ModelConfigTab';

const fetchMock = vi.fn();
const SONNET = 'anthropic/claude-sonnet-4-6';
const GROK = 'openrouter/x-ai/grok-4.6';
const DISABLED = 'openrouter/google/gemini-3.7-flash';
const catalog = [
  { id: 'anthropic', name: 'Anthropic', status: 'live', models: [{ ref: SONNET, label: 'Claude Sonnet 4.6' }] },
  { id: 'openrouter', name: 'OpenRouter', status: 'live', models: [
    { ref: GROK, label: 'Grok 4.6' }, { ref: DISABLED, label: 'Gemini 3.7 Flash' },
  ] },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function script(opts: { allowed?: string[]; current?: string | null; providers?: typeof catalog; policyStatus?: number; catalogStatus?: number; settingStatus?: number; saveStatus?: number } = {}) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/admin/models/policy') return json({ source: 'admin', version: 1, allowed: opts.allowed ?? [SONNET, GROK], default: SONNET }, opts.policyStatus ?? 200);
    if (url === '/admin/models/catalog') return json({ providers: opts.providers ?? catalog }, opts.catalogStatus ?? 200);
    if (url === '/admin/settings/fast-model') {
      if (init?.method === 'PUT') return new Response(null, { status: opts.saveStatus ?? 204 });
      return json({ value: opts.current ?? null }, opts.settingStatus ?? 200);
    }
    // Keep the obsolete seed endpoint available: it must not control choices.
    if (url === '/admin/credentials/providers') return json({ providers: [{ id: 'anthropic', name: 'Anthropic', models: ['old-seed-model'], configured: true }] });
    return new Response(null, { status: 404 });
  });
}
const puts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
async function openPicker() {
  const trigger = await screen.findByRole('combobox', { name: 'Helper model' });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
}
async function choose(label: string) {
  await openPicker();
  fireEvent.click(screen.getByRole('option', { name: label }));
}

describe('ModelConfigTab enabled models', () => {
  it('offers only enabled models with the same labels as Settings → Models', async () => {
    script(); render(<ModelConfigTab />); await openPicker();
    expect(screen.getByRole('option', { name: 'Claude Sonnet 4.6' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Grok 4.6' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Gemini 3.7 Flash' })).toBeNull();
    expect(screen.queryByText('old-seed-model')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === '/admin/models/policy')).toBe(true);
  });

  it('saves the exact canonical ref, including an OpenRouter vendor segment', async () => {
    script(); render(<ModelConfigTab />); await choose('Grok 4.6');
    expect(puts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]![1].body).value).toBe(GROK);
    expect(puts()[0]![1]).toMatchObject({ credentials: 'include', headers: { 'x-requested-with': 'ax-admin' } });
  });

  it('preselects the saved canonical ref and displays its catalog label', async () => {
    script({ current: GROK }); render(<ModelConfigTab />);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('Grok 4.6'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]![1].body).value).toBe(GROK);
  });

  it('keeps provider identity when two providers offer the same model id and label', async () => {
    const first = 'anthropic/shared-model'; const second = 'openrouter/shared-model';
    script({ allowed: [first, second], providers: [
      { id: 'anthropic', name: 'Anthropic', status: 'live', models: [{ ref: first, label: 'Shared model' }] },
      { id: 'openrouter', name: 'OpenRouter', status: 'live', models: [{ ref: second, label: 'Shared model' }] },
    ] });
    render(<ModelConfigTab />); await openPicker();
    fireEvent.click(screen.getAllByRole('option', { name: 'Shared model' })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0]![1].body).value).toBe(second);
  });

  it('shows a removed saved model without silently changing it or letting it be saved again', async () => {
    script({ current: DISABLED }); render(<ModelConfigTab />);
    expect(await screen.findByText(/saved helper model.*isn.t enabled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(puts()).toHaveLength(0);
    await choose('Grok 4.6');
    expect(screen.queryByText(/saved helper model.*isn.t enabled/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save changes' })).not.toBeDisabled();
  });

  it('retains enabled refs even if catalog labels cannot be fetched', async () => {
    script({ catalogStatus: 500 }); render(<ModelConfigTab />); await openPicker();
    expect(screen.getByRole('option', { name: SONNET })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: GROK })).toBeInTheDocument();
    expect(screen.queryByText(DISABLED)).toBeNull();
  });

  it.each(['policyStatus', 'settingStatus'] as const)('shows a retryable error when %s fails', async (key) => {
    script({ [key]: 500 }); render(<ModelConfigTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load/i);
    script(); fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
  });

  it('disables selection when no models are enabled', async () => {
    script({ allowed: [] }); render(<ModelConfigTab />);
    expect(await screen.findByText(/enable a model in Settings.*Models/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('shows a save error without losing the selected model', async () => {
    script({ saveStatus: 500 }); render(<ModelConfigTab />); await choose('Grok 4.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t save/i);
    expect(screen.getByRole('combobox')).toHaveTextContent('Grok 4.6');
  });

  it('keeps Save disabled until an enabled model is selected', async () => {
    script(); render(<ModelConfigTab />);
    await screen.findByRole('button', { name: 'Save changes' });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});
