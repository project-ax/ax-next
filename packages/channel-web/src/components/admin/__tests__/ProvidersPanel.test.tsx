import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProvidersPanel } from '../ProvidersPanel';

describe('ProvidersPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders one row per provider in KNOWN_PROVIDERS, with status pill', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    );
    render(<ProvidersPanel />);
    expect(await screen.findByText('Anthropic')).toBeInTheDocument();
    expect(await screen.findByText('OpenRouter')).toBeInTheDocument();
    expect(await screen.findAllByRole('button', { name: /set credential/i })).toHaveLength(2);
  });

  it('the OpenRouter row targets the provider:openrouter destination', async () => {
    // The panel is a hand-kept mirror of @ax/core's PROVIDER_ENDPOINTS (no
    // kernel import in the browser bundle). This pins the slot label the
    // row advertises — the env var the runner reads the key from.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    );
    render(<ProvidersPanel />);
    expect(await screen.findByText('OPENROUTER_API_KEY')).toBeInTheDocument();
  });
});
