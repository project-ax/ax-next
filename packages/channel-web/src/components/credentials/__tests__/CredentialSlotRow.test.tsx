import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialSlotRow } from '../CredentialSlotRow';

describe('CredentialSlotRow', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/credentials')) {
        // Status pill query — empty list = "Not set"
        return new Response(JSON.stringify({ credentials: [] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('preserves non-routine key entry while the admin status list is pending', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => {}));
    render(<CredentialSlotRow destination={{ kind: 'provider', provider: 'openrouter' }} slot={{ label: 'OPENROUTER_API_KEY', kind: 'api-key' }} scope={{ scope: 'global', ownerId: null }} />);
    expect(screen.getByRole('button', { name: 'Add key' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('renders a humanized slot label and an Add key button when not set', async () => {
    render(
      <CredentialSlotRow
        destination={{
          kind: 'skill-slot',
          skillId: 'linear-tracker',
          slot: 'LINEAR_TOKEN',
        }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    expect(await screen.findByText('Linear token')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /add key/i }),
    ).toBeInTheDocument();
  });

  it('opens the sheet on click', async () => {
    render(
      <CredentialSlotRow
        destination={{
          kind: 'skill-slot',
          skillId: 'linear-tracker',
          slot: 'LINEAR_TOKEN',
        }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /add key/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // The dialog title carries the humanized label; multiple elements may match due to the row label
    expect(screen.getAllByText(/Linear token/i).length).toBeGreaterThan(0);
  });

  it('labels opaque routine destinations from an authorized lookup and sends its revision', async () => {
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockImplementation(async (input) => {
      if (String(input).includes('/settings/routines/'))
        return new Response(
          JSON.stringify({
            routine: {
              name: 'Daily digest',
              revision: 'rev7',
              permissions: { manageSecret: true },
            },
          }),
          { status: 200 },
        );
      if (String(input).includes('/settings/destinations/routine-hmac/credential'))
        return new Response(JSON.stringify({ configured: false }), {
          status: 200,
        });
      return new Response(null, { status: 204 });
    });
    render(
      <CredentialSlotRow
        destination={{
          kind: 'routine-hmac',
          agentId: 'a',
          routineId: 'rtn_opaque',
        }}
        slot={{ label: 'HMAC secret', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'a' }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /add key/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /add key/i }));
    expect((await screen.findByRole('dialog')).textContent).toContain(
      'the Daily digest routine',
    );
    expect(screen.getByRole('dialog').textContent).not.toContain('rtn_opaque');
    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/destinations/routine-hmac/') &&
            String(init?.body).includes('rev7'),
        ),
      ).toBe(true),
    );
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
        destination={{
          kind: 'skill-slot',
          skillId: 'linear-tracker',
          slot: 'LINEAR_TOKEN',
        }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /add key/i }));
    const sheet = await screen.findByRole('dialog');

    expect(sheet.textContent).toContain('Used by the Linear tracker skill.');
  });
});
