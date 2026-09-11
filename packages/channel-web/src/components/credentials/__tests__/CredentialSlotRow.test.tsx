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

  it('renders a humanized slot label and an Add key button when not set', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    expect(await screen.findByText('Linear token')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /add key/i })).toBeInTheDocument();
  });

  it('opens the sheet on click', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /add key/i }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toBeInTheDocument(),
    );
    // The dialog title carries the humanized label; multiple elements may match due to the row label
    expect(screen.getAllByText(/Linear token/i).length).toBeGreaterThan(0);
  });
});
