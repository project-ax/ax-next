import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CatalogProvider } from '@/lib/models-admin';
import { filterProviders, removeModel, setDefault, toggleModel, addModels, type Draft } from '@/lib/models-picker';
import { ModelCatalogPane } from '../ModelCatalogPane';
import { SelectedModelsPane } from '../SelectedModelsPane';

const OPUS = 'anthropic/claude-opus-4-7';
const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const GROK = 'openrouter/x-ai/grok-4.6';

const PROVIDERS: CatalogProvider[] = [
  { id: 'anthropic', name: 'Anthropic', status: 'live', models: [{ ref: OPUS, label: 'Claude Opus 4.7' }, { ref: SONNET, label: 'Claude Sonnet 4.6' }] },
  { id: 'openrouter', name: 'OpenRouter', status: 'live', models: [{ ref: KIMI, label: 'Kimi K3' }, { ref: GROK, label: 'xAI: Grok 4.6' }] },
];

/** A tiny host so the panes behave as they do inside ModelsTab. */
function Harness(props: { providers?: CatalogProvider[]; initial?: Draft; onOpenKeys?: () => void; onRetry?: () => void }) {
  const providers = props.providers ?? PROVIDERS;
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>(props.initial ?? { allowed: [SONNET], default: SONNET });
  const shown = filterProviders(providers, query);
  return (
    <>
      <ModelCatalogPane
        providers={providers}
        shown={shown}
        selected={new Set(draft.allowed)}
        query={query}
        onQueryChange={setQuery}
        onToggle={(ref) => setDraft((d) => toggleModel(d, ref))}
        onSelectAllShown={(refs) => setDraft((d) => addModels(d, refs))}
        onRetry={props.onRetry ?? (() => {})}
        retrying={false}
        {...(props.onOpenKeys !== undefined ? { onOpenKeys: props.onOpenKeys } : {})}
        nowMs={Date.parse('2026-09-30T12:10:00Z')}
      />
      <SelectedModelsPane
        draft={draft}
        providers={providers}
        onSetDefault={(ref) => setDraft((d) => setDefault(d, ref))}
        onRemove={(ref) => setDraft((d) => removeModel(d, ref))}
      />
    </>
  );
}

function openDetails(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Details for ${label}` }));
}
function removeSelectedModel(label: string) {
  openDetails(label);
  fireEvent.click(screen.getByRole('button', { name: `Remove ${label}` }));
}

describe('ModelCatalogPane', () => {
  it('lists every model grouped by provider, with a live count', () => {
    render(<Harness />);
    expect(screen.getByText('4 models')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenRouter/ })).toBeInTheDocument();
  });

  it('filters on every keystroke (no waiting), narrows as words are typed, and widens when they are deleted', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox', { name: 'Search models' });
    // One keystroke is enough to filter: "k" appears in Kimi K3 and Grok only.
    fireEvent.change(box, { target: { value: 'k' } });
    expect(screen.getByText('2 of 4 models')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Claude/ })).toBeNull();
    fireEvent.change(box, { target: { value: 'claude' } });
    expect(screen.getByText('2 of 4 models')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'claude opus' } });
    expect(screen.getByText('1 of 4 models')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Sonnet/ })).toBeNull();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByText('4 models')).toBeInTheDocument();
  });

  it('says so plainly when nothing matches', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'zzz' } });
    expect(screen.getByText('0 of 4 models')).toBeInTheDocument();
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it('ticking a model selects it and the right pane shows it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Kimi K3/ }));
    expect(screen.getByRole('heading', { name: 'Available to users (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details for Kimi K3' })).toBeInTheDocument();
  });

  it('offers "Select all N shown" only while searching, and it selects every match', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /Select all/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'openrouter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }));
    expect(screen.getByRole('heading', { name: 'Available to users (3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details for Kimi K3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details for xAI: Grok 4.6' })).toBeInTheDocument();
  });

  it('opens a matching provider group while searching even if the admin collapsed it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /OpenRouter/ })); // collapse
    expect(screen.queryByRole('checkbox', { name: /Kimi K3/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'kimi' } });
    expect(screen.getByRole('checkbox', { name: /Kimi K3/ })).toBeInTheDocument();
  });

  it('a provider we could not reach shows a plain message and a working Try again', () => {
    const onRetry = vi.fn();
    const providers = PROVIDERS.map((p) => (p.id === 'openrouter' ? { ...p, status: 'fallback' as const } : p));
    render(<Harness providers={providers} onRetry={onRetry} />);
    expect(screen.getByText("We couldn't reach OpenRouter just now, so we're showing a shorter list.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('a cached list says how old it is', () => {
    const providers = PROVIDERS.map((p) => (p.id === 'openrouter' ? { ...p, status: 'cached' as const, fetchedAt: '2026-09-30T12:00:00Z' } : p));
    render(<Harness providers={providers} />);
    expect(screen.getByText('Showing models from 10 minutes ago.')).toBeInTheDocument();
  });

  it('a provider with no key says what to do, and the link opens the keys tab', () => {
    const onOpenKeys = vi.fn();
    const providers = PROVIDERS.map((p) => (p.id === 'openrouter' ? { ...p, status: 'no-key' as const, models: [] } : p));
    render(<Harness providers={providers} onOpenKeys={onOpenKeys} />);
    expect(screen.getByText(/Add an API key to see OpenRouter's models\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open AI model keys' }));
    expect(onOpenKeys).toHaveBeenCalledOnce();
  });
});

describe('SelectedModelsPane', () => {
  it('opens model actions on demand and restores the row without changing the selection', async () => {
    render(<Harness initial={{ allowed: [SONNET, KIMI], default: SONNET }} />);
    expect(screen.queryByRole('button', { name: 'Remove Kimi K3' })).toBeNull();
    const row = screen.getByRole('button', { name: 'Details for Kimi K3' });
    row.focus();
    openDetails('Kimi K3');
    const dialog = screen.getByRole('dialog', { name: 'Kimi K3' });
    expect(within(dialog).getByText(KIMI)).toBeVisible();
    expect(within(dialog).getByText(/The Default is what new agents start with/)).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(row).toHaveFocus());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Details for Claude Sonnet 4.6' })).toHaveTextContent('Default');
    expect(row).toHaveTextContent('Enabled');
  });

  it('explains the Default and shows the empty state when nothing is selected', () => {
    render(<Harness initial={{ allowed: [], default: '' }} />);
    expect(screen.getByRole('heading', { name: 'Available to users (0)' })).toBeInTheDocument();
    expect(screen.getByText('No models yet')).toBeInTheDocument();
    expect(screen.getByText('Pick at least one model in Catalog so people can create agents.')).toBeInTheDocument();
  });

  it('marks the Default and lets the admin move it', () => {
    render(<Harness initial={{ allowed: [SONNET, KIMI], default: SONNET }} />);
    expect(screen.getByRole('button', { name: 'Details for Claude Sonnet 4.6' })).toHaveTextContent('Default');
    expect(screen.getByText('Default')).toBeInTheDocument();
    openDetails('Kimi K3');
    fireEvent.click(screen.getByRole('button', { name: 'Make Kimi K3 the Default' }));
    expect(screen.getByRole('button', { name: 'Make Kimi K3 the Default' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Details for Kimi K3' })).toHaveTextContent('Default');
  });

  it('removing the Default promotes the first remaining model, visibly', () => {
    render(<Harness initial={{ allowed: [SONNET, KIMI], default: SONNET }} />);
    removeSelectedModel('Claude Sonnet 4.6');
    expect(screen.getByRole('button', { name: 'Details for Kimi K3' })).toHaveTextContent('Default');
  });

  it('shows when a model is no longer listed or its provider has no key', () => {
    const providers = PROVIDERS.map((p) => (p.id === 'anthropic' ? { ...p, status: 'no-key' as const, models: [] } : p));
    render(<Harness providers={providers} initial={{ allowed: [SONNET, 'openrouter/gone/model'], default: SONNET }} />);
    expect(screen.getByRole('button', { name: `Details for ${SONNET}` })).toHaveTextContent('Needs an API key');
    expect(screen.getByRole('button', { name: 'Details for openrouter/gone/model' })).toHaveTextContent('No longer listed');
  });

  it('moves focus to the next row after a remove, and to the list when none remain', async () => {
    render(<Harness initial={{ allowed: [SONNET, KIMI], default: SONNET }} />);
    removeSelectedModel('Claude Sonnet 4.6');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Details for Kimi K3' })).toHaveFocus());
    removeSelectedModel('Kimi K3');
    expect(screen.getByText('No models yet')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });
});
