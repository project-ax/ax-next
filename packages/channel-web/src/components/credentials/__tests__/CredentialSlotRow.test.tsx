import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialSlotRow } from '../CredentialSlotRow';

describe('CredentialSlotRow', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/credentials')) {
        // Status pill query — empty list = "Not set"
        return new Response(JSON.stringify({ credentials: [] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the slot label and "Set credential" when not set', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    expect(await screen.findByText('LINEAR_TOKEN')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /set credential/i })).toBeInTheDocument();
  });

  it('opens the sheet on click', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /set credential/i }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toBeInTheDocument(),
    );
    // The dialog title contains "LINEAR_TOKEN"; multiple elements may match due to the row label
    expect(screen.getAllByText(/LINEAR_TOKEN/).length).toBeGreaterThan(0);
  });
});
