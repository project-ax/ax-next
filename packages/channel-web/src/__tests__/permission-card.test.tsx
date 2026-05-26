import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionCard } from '../components/PermissionCard';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';
import { resumeActions } from '../lib/resume-actions';

// Mock the conversation-id hook at the module level with a stable plain
// function (a mutable holder for the per-test value). Spying on the real
// `useConversationId` would swap a `useSyncExternalStore`-backed hook for a
// constant mid-lifecycle, violating the rules of hooks across re-renders.
let mockConversationId: string | null = 'cnv-1';
vi.mock('../lib/use-conversation-id', () => ({
  useConversationId: () => mockConversationId,
  setActiveConversationId: () => undefined,
}));

const linear = {
  skillId: 'linear',
  description: 'Read your Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' as const }],
};

describe('PermissionCard', () => {
  beforeEach(() => {
    mockConversationId = 'cnv-1';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    permissionCardActions.reset();
  });

  it('renders nothing when no card is pending', () => {
    const { container } = render(<PermissionCard />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the hosts + a key field, and Connect writes the key to the user-scoped store', async () => {
    vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
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
    // The credential POST routed to the USER scope (/settings, not /admin).
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/settings/destinations/skill-slot/credential',
    );
  });

  it('Connect posts the decision then triggers continue, after writing the key', async () => {
    const continueSpy = vi
      .spyOn(resumeActions, 'continueAfterGrant')
      .mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, attached: true }), { status: 200 }),
      );

    render(<PermissionCard />);
    permissionCardActions.show(linear); // one slot: api_key
    fireEvent.change(await screen.findByLabelText('api_key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    // credential write (TASK-35 route) + decision POST both fired.
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/settings/destinations/skill-slot/credential');
    expect(urls).toContain('/api/chat/permission-decision');
    const decisionCall = fetchMock.mock.calls.find(
      (c) => c[0] === '/api/chat/permission-decision',
    );
    expect(decisionCall?.[1]?.body).toContain('"skillId":"linear"');
    expect(decisionCall?.[1]?.body).toContain('"conversationId":"cnv-1"');
    expect(continueSpy).toHaveBeenCalledTimes(1);
  });

  it('Connect is disabled until every declared slot is filled', async () => {
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    expect(
      await screen.findByRole('button', { name: /^connect$/i }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText('api_key'), { target: { value: 'k' } });
    expect(screen.getByRole('button', { name: /^connect$/i })).not.toBeDisabled();
  });

  it('Connect is disabled when there is no active conversation', async () => {
    mockConversationId = null;
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    fireEvent.change(await screen.findByLabelText('api_key'), {
      target: { value: 'k' },
    });
    expect(
      screen.getByRole('button', { name: /^connect$/i }),
    ).toBeDisabled();
  });

  it('Not now dismisses without writing a credential, posting a decision, or continuing', async () => {
    const continueSpy = vi
      .spyOn(resumeActions, 'continueAfterGrant')
      .mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(continueSpy).not.toHaveBeenCalled();
  });
});
