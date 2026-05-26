import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionCard } from '../components/PermissionCard';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';

const linear = {
  skillId: 'linear',
  description: 'Read your Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' as const }],
};

describe('PermissionCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    permissionCardActions.reset();
  });

  it('renders nothing when no card is pending', () => {
    const { container } = render(<PermissionCard />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the hosts + a key field, and Connect posts the key to the user-scoped store then dismisses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<PermissionCard />);
    permissionCardActions.show(linear); // re-renders the subscribed component

    expect(await screen.findByText('api.linear.app')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('api_key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/settings/destinations/skill-slot/credential',
      expect.objectContaining({
        method: 'POST',
        // base64('lin_test_123') === 'bGluX3Rlc3RfMTIz'
        body: expect.stringContaining('"payloadB64":"bGluX3Rlc3RfMTIz"'),
      }),
    );
    // The POST routed to the USER scope (/settings, not /admin).
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/settings/destinations/skill-slot/credential',
    );
  });

  it('Not now dismisses without writing any credential', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
