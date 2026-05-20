import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CredentialSlotForm } from '../CredentialSlotForm';

describe('CredentialSlotForm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('POSTs base64-encoded payload to the right route for skill-slot', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const onSaved = vi.fn();
    render(
      <CredentialSlotForm
        destination={{ kind: 'skill-slot', skillId: 'linear-tracker', slot: 'LINEAR_TOKEN' }}
        slot={{ label: 'LINEAR_TOKEN', kind: 'api-key' }}
        scope={{ scope: 'agent', ownerId: 'agt-1' }}
        current={{ set: false }}
        onSaved={onSaved}
        onCleared={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test-123' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/destinations/skill-slot/credential',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining(
          // base64('sk-test-123') === 'c2stdGVzdC0xMjM='
          '"payloadB64":"c2stdGVzdC0xMjM="',
        ),
      }),
    );
  });

  it('routes user-scope to /settings/destinations/...', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    render(
      <CredentialSlotForm
        destination={{ kind: 'provider', provider: 'anthropic' }}
        slot={{ label: 'ANTHROPIC_API_KEY', kind: 'api-key' }}
        scope={{ scope: 'user', ownerId: 'alice' }}
        current={{ set: false }}
        onSaved={() => {}}
        onCleared={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/settings/destinations/provider/credential');
  });
});
