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

  /**
   * A browser walk opened the OpenRouter key sheet and read:
   *
   *     Add your OpenRouter API key
   *     Used by OpenRouter.
   *
   * For a `provider` (and `account`) destination `humanDestination` returns the
   * bare service name, and `humanizeSlotLabel` has already folded that same name
   * into the title — so the description repeats the line above it and tells the
   * reader nothing, at the moment they are deciding whether to hand over a
   * secret.
   */
  it('drops the "Used by" line when the title already names the service', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'provider', provider: 'openrouter' }}
        slot={{ label: 'OPENROUTER_API_KEY', kind: 'api-key' }}
        scope={{ scope: 'global', ownerId: null }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /add key/i }));
    const sheet = await screen.findByRole('dialog');

    expect(sheet.textContent).toContain('OpenRouter API key');
    expect(sheet.textContent).not.toContain('Used by');
  });

  /**
   * The counterpart, so the fix above cannot become "never show it". For a
   * skill the description adds a noun the title does not have — "the Linear
   * SKILL" — which is the disambiguation it was written for.
   */
  it('keeps the "Used by" line when it names something the title does not', async () => {
    render(
      <CredentialSlotRow
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /add key/i }));
    const sheet = await screen.findByRole('dialog');

    expect(sheet.textContent).toContain('Used by the Linear tracker skill.');
  });
});
