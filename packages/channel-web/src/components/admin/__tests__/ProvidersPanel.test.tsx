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
    expect(await screen.findAllByRole('button', { name: /set credential/i })).toHaveLength(1);
  });
});
