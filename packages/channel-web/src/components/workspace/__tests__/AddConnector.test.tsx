/**
 * The rail's Add subview (TASK-740, connectors-rail slice 7).
 *
 * The rule pinned hardest: a connector is attached ONLY after its sign-in or
 * key has succeeded. Cancelled, failed and half-finished set-ups attach
 * nothing. Also pinned: what "Available" means, name-only rows with one
 * action, the search, the team-agent consent, and attach failure + Retry.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import {
  emptyCapabilities,
  getConnector,
  listConnectors,
  type Connector,
  type ConnectorSummary,
} from '@/lib/connectors';
import { beginOAuth, getOAuthStatus } from '@/lib/connectors-oauth';
import { myCredentials, adminCredentials, type CredentialMeta } from '@/lib/credentials';
import { OAUTH_MESSAGE_TYPE } from '@/lib/oauth-callback-bridge';
import { UserProvider } from '@/lib/user-context';
import { AddConnector } from '../AddConnector';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: { connectors: vi.fn(), attachConnector: vi.fn() },
  };
});
vi.mock('@/lib/connectors', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/connectors');
  return { ...actual, listConnectors: vi.fn(), getConnector: vi.fn() };
});
vi.mock('@/lib/connectors-oauth', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/connectors-oauth');
  return { ...actual, beginOAuth: vi.fn(), getOAuthStatus: vi.fn() };
});
vi.mock('@/lib/credentials', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/credentials');
  return {
    ...actual,
    myCredentials: { list: vi.fn() },
    adminCredentials: { list: vi.fn() },
  };
});
// The real key dialog is tested on its own; here it only has to report a save.
vi.mock('@/components/settings/ConnectorConnectDialog', () => ({
  ConnectorConnectDialog: (p: { connectorName: string; onConnected: () => void }) => (
    <div role="dialog" aria-label={`Key for ${p.connectorName}`}>
      <button type="button" onClick={p.onConnected}>
        Save key
      </button>
    </div>
  ),
}));

const attachMock = vi.mocked(workspaceApi.attachConnector);

function summary(id: string, name: string, extra: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    id,
    name,
    description: '',
    usageNote: '',
    keyMode: 'personal',
    visibility: 'shared',
    defaultAttached: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

const CATALOG: ConnectorSummary[] = [
  summary('notion', 'Notion'),
  summary('zendesk', 'Zendesk'),
  summary('stripe', 'Stripe'),
  summary('linear', 'Linear'), // already on the agent
  summary('company-crm', 'Company CRM', { keyMode: 'workspace' }),
];

function full(id: string): Connector {
  const s = CATALOG.find((c) => c.id === id)!;
  const caps = emptyCapabilities();
  if (id === 'notion') caps.credentials = [{ slot: 'notion', kind: 'oauth', server: 'notion' }];
  if (id === 'zendesk' || id === 'company-crm')
    caps.credentials = [{ slot: 'token', kind: 'api-key' }];
  return { ...s, capabilities: caps };
}

let userCreds: CredentialMeta[] = [];
let popup: { closed: boolean; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  userCreds = [];
  popup = { closed: false, close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
  vi.mocked(workspaceApi.connectors).mockResolvedValue({
    connectors: [{ id: 'linear', name: 'Linear', source: 'attached', editable: false, health: 'ok', removable: true }],
    shared: false,
      connectorsSupported: true, manageable: true,
  });
  vi.mocked(listConnectors).mockResolvedValue(CATALOG);
  vi.mocked(getConnector).mockImplementation(async (id) => full(id));
  vi.mocked(getOAuthStatus).mockResolvedValue('not-connected');
  vi.mocked(beginOAuth).mockResolvedValue({ authorizationUrl: 'https://provider.example/auth' });
  vi.mocked(myCredentials.list).mockImplementation(async () => userCreds);
  vi.mocked(adminCredentials.list).mockResolvedValue([]);
  attachMock.mockResolvedValue({ attached: true, changed: true });
});

function renderAdd(role: 'admin' | 'user' = 'user') {
  const onAttached = vi.fn();
  const onBack = vi.fn();
  render(
    <UserProvider value={{ id: 'u1', email: 'u@example.com', name: 'Uma', role }}>
      <AddConnector agentId="a-quill" name="Quill" onBack={onBack} onAttached={onAttached} />
    </UserProvider>,
  );
  return { onAttached, onBack };
}

function row(name: string): HTMLElement {
  const label = screen.getByText(name, { selector: 'span' });
  return label.closest('div[class*="h-11"]') as HTMLElement;
}

async function ready() {
  await screen.findByRole('button', { name: 'Sign in — Notion' });
  await screen.findByRole('button', { name: 'Add key — Zendesk' });
  await screen.findByRole('button', { name: 'Add — Stripe' });
}

function postOAuth(connector: string, oauth: 'success' | 'error') {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_MESSAGE_TYPE, connector, oauth },
      }),
    );
  });
}

describe('what it shows', () => {
  it('lists what the workspace offers minus what the agent has, name + one action per row', async () => {
    renderAdd();
    await ready();
    expect(screen.getByRole('heading', { name: 'Add a connector' })).toBeTruthy();
    expect(
      screen.getByText(/Pick one your workspace offers\. If it needs a sign-in, we add it to Quill once you’ve signed in\./),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Available/ }).textContent).toBe('Available3');
    expect(screen.queryByText('Linear')).toBeNull();
    // Name only: no subtitles like "Needs a sign-in".
    expect(screen.queryByText(/Needs a/)).toBeNull();
    expect(screen.getByText('Don’t see the one you need? Ask a workspace admin to set it up.')).toBeTruthy();
    expect(screen.getByTestId('connector-access-notice').textContent).toMatch(
      /Once this connector has a key or sign-in, this agent gets that same access/,
    );
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('hides company-key connectors from a non-admin, and shows them to an admin', async () => {
    renderAdd('user');
    await ready();
    expect(screen.queryByText('Company CRM')).toBeNull();
  });

  it('an admin sees company-key connectors', async () => {
    renderAdd('admin');
    expect(await screen.findByRole('button', { name: 'Add key — Company CRM' })).toBeTruthy();
    expect(listConnectors).toHaveBeenCalledWith('/admin/connectors');
  });

  it('search filters by name and the count follows', async () => {
    renderAdd();
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search connectors' }), {
      target: { value: 'zen' },
    });
    expect(screen.getByRole('heading', { name: /^Available/ }).textContent).toBe('Available1');
    expect(screen.getByRole('button', { name: 'Add key — Zendesk' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in — Notion' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search connectors' }), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByText('Nothing matches that search.')).toBeTruthy();
  });

  it('a connector already signed in reads "Add"', async () => {
    vi.mocked(getOAuthStatus).mockResolvedValue('connected');
    renderAdd();
    expect(await screen.findByRole('button', { name: 'Add — Notion' })).toBeTruthy();
    expect(getOAuthStatus).toHaveBeenCalledWith({ connectorId: 'notion', agentId: 'a-quill' });
  });

  it('says so when it cannot load the list, and Try again re-reads', async () => {
    vi.mocked(listConnectors).mockRejectedValueOnce(new Error('boom'));
    renderAdd();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await ready();
  });
});

describe('a swallowed failure is never silent (TASK-757)', () => {
  function warnSpy() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }
  const logged = (warn: ReturnType<typeof warnSpy>, tag: string) =>
    warn.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes(`[${tag}]`));

  it('a failed sign-in status read is logged and falls back to "Sign in"', async () => {
    const warn = warnSpy();
    vi.mocked(getOAuthStatus).mockRejectedValue(new Error('status down'));
    renderAdd();
    expect(await screen.findByRole('button', { name: 'Sign in — Notion' })).toBeTruthy();
    expect(logged(warn, 'add-connector oauth-status notion')).toBe(true);
    warn.mockRestore();
  });

  it('a failed personal key read is logged and falls back to asking for the key', async () => {
    const warn = warnSpy();
    vi.mocked(myCredentials.list).mockRejectedValue(new Error('creds down'));
    renderAdd();
    expect(await screen.findByRole('button', { name: 'Add key — Zendesk' })).toBeTruthy();
    expect(logged(warn, 'add-connector my-credentials')).toBe(true);
    warn.mockRestore();
  });

  it("an admin's failed workspace key read is logged", async () => {
    const warn = warnSpy();
    vi.mocked(adminCredentials.list).mockRejectedValue(new Error('creds down'));
    renderAdd('admin');
    await screen.findByRole('button', { name: 'Add key — Zendesk' });
    await waitFor(() => expect(logged(warn, 'add-connector workspace-credentials')).toBe(true));
    warn.mockRestore();
  });

  it('a sign-in that cannot start is logged, says so with a next step, and attaches nothing', async () => {
    const warn = warnSpy();
    vi.mocked(beginOAuth).mockRejectedValue(new Error('begin down'));
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    expect(await screen.findByText(/We couldn't start the sign-in\. Please try again/)).toBeTruthy();
    expect(logged(warn, 'oauth-sign-in notion')).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('sign in, then attach', () => {
  it('attaches only after the provider says the sign-in succeeded', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    expect(beginOAuth).toHaveBeenCalledWith({ connectorId: 'notion', agentId: 'a-quill' });
    // Pending: spinner + Cancel, and nothing attached yet.
    expect(within(row('Notion')).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(row('Notion')).getByLabelText('Waiting for sign-in')).toBeTruthy();
    expect(attachMock).not.toHaveBeenCalled();

    vi.mocked(getOAuthStatus).mockResolvedValue('connected');
    postOAuth('notion', 'success');
    await waitFor(() => expect(attachMock).toHaveBeenCalledWith('a-quill', 'notion'));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
  });

  it('attaches even when the status read lags the success message', async () => {
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    // getOAuthStatus still answers not-connected.
    postOAuth('notion', 'success');
    await waitFor(() => expect(attachMock).toHaveBeenCalledWith('a-quill', 'notion'));
  });

  it('Cancel closes the sign-in and leaves nothing attached — even if a success arrives later', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    fireEvent.click(within(row('Notion')).getByRole('button', { name: 'Cancel' }));
    expect(popup.close).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in — Notion' })).toBeTruthy();
    postOAuth('notion', 'success');
    await new Promise((r) => setTimeout(r, 20));
    expect(attachMock).not.toHaveBeenCalled();
    expect(onAttached).not.toHaveBeenCalled();
  });

  it('Cancel while the sign-in is still starting never opens the popup', async () => {
    let resolveBegin: (v: { authorizationUrl: string }) => void = () => {};
    vi.mocked(beginOAuth).mockReturnValueOnce(
      new Promise((r) => {
        resolveBegin = r;
      }),
    );
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    fireEvent.click(await within(row('Notion')).findByRole('button', { name: 'Cancel' }));
    await act(async () => {
      resolveBegin({ authorizationUrl: 'https://provider.example/auth' });
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in — Notion' })).toBeTruthy();
  });

  it('a pending sign-in survives a search that hides its row', async () => {
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    const search = screen.getByRole('searchbox', { name: 'Search connectors' });
    fireEvent.change(search, { target: { value: 'stripe' } });
    fireEvent.change(search, { target: { value: '' } });
    expect(popup.close).not.toHaveBeenCalled();
    postOAuth('notion', 'success');
    await waitFor(() => expect(attachMock).toHaveBeenCalledWith('a-quill', 'notion'));
  });

  it('a sign-in + key connector: sign in, then the key, then attach — even while the status read lags', async () => {
    vi.mocked(getConnector).mockImplementation(async (id) => {
      const c = full(id);
      if (id === 'notion') c.capabilities.credentials.push({ slot: 'token', kind: 'api-key' });
      return c;
    });
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    // getOAuthStatus keeps answering not-connected throughout.
    postOAuth('notion', 'success');
    const dialog = await screen.findByRole('dialog', { name: 'Key for Notion' });
    expect(attachMock).not.toHaveBeenCalled();
    userCreds = [
      { scope: 'user', ownerId: 'u1', ref: 'account:notion:token', kind: 'api-key', createdAt: '' },
      { scope: 'user', ownerId: 'u1', ref: 'account:notion:notion', kind: 'oauth', createdAt: '' },
    ];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(attachMock).toHaveBeenCalledWith('a-quill', 'notion'));
    expect(onAttached).toHaveBeenCalled();
    expect(beginOAuth).toHaveBeenCalledTimes(1);
  });

  it('a failed re-check after a good sign-in offers Retry that re-reads, not a second sign-in', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    vi.mocked(getConnector).mockRejectedValueOnce(new Error('blip'));
    postOAuth('notion', 'success');
    expect(await screen.findByText('We couldn’t check Notion just now. Please try again.')).toBeTruthy();
    expect(attachMock).not.toHaveBeenCalled();
    fireEvent.click(within(row('Notion')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attachMock).toHaveBeenCalledWith('a-quill', 'notion'));
    expect(onAttached).toHaveBeenCalled();
    expect(beginOAuth).toHaveBeenCalledTimes(1);
  });

  it('a failed sign-in attaches nothing and says so', async () => {
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    postOAuth('notion', 'error');
    expect(await screen.findByText(/Sign-in didn't finish, so Notion isn't connected/)).toBeTruthy();
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('a message for another connector, or from another origin, attaches nothing', async () => {
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    postOAuth('zendesk', 'success');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evil.example',
          data: { type: OAUTH_MESSAGE_TYPE, connector: 'notion', oauth: 'success' },
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(attachMock).not.toHaveBeenCalled();
    expect(within(row('Notion')).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('a team agent (the server says shared) asks for consent before the sign-in starts', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({ connectors: [], shared: true, connectorsSupported: true, manageable: true });
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    expect(
      await screen.findByText(/lets anyone who uses Quill act as you on Notion/),
    ).toBeTruthy();
    expect(beginOAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(beginOAuth).toHaveBeenCalled());
  });

  it('a personal agent signs in without the consent step', async () => {
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(beginOAuth).toHaveBeenCalled());
    expect(screen.queryByText(/act as you on Notion/)).toBeNull();
  });

  it('attach failing after a good sign-in shows the error and Retry', async () => {
    attachMock.mockRejectedValueOnce(new WorkspaceApiError('/agents/a-quill/connectors', 500));
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    postOAuth('notion', 'success');
    expect(await screen.findByText(/We couldn’t add Notion to Quill just now/)).toBeTruthy();
    expect(onAttached).not.toHaveBeenCalled();
    fireEvent.click(within(row('Notion')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(attachMock).toHaveBeenCalledTimes(2);
    // Retry re-attaches; it never starts a second sign-in.
    expect(beginOAuth).toHaveBeenCalledTimes(1);
  });
});

describe('add key, then attach', () => {
  it('attaches once the key is saved', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add key — Zendesk' }));
    const dialog = await screen.findByRole('dialog', { name: 'Key for Zendesk' });
    expect(attachMock).not.toHaveBeenCalled();
    userCreds = [
      { scope: 'user', ownerId: 'u1', ref: 'account:zendesk', kind: 'api-key', createdAt: '' },
    ];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(attachMock).toHaveBeenCalledWith('a-quill', 'zendesk'));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
  });

  it('does not attach while a key is still missing (multi-key connector, closed early)', async () => {
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add key — Zendesk' }));
    const dialog = await screen.findByRole('dialog', { name: 'Key for Zendesk' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(getConnector).toHaveBeenCalledTimes(4));
    await new Promise((r) => setTimeout(r, 20));
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('a company-key refusal says an admin must add it, with no Retry', async () => {
    attachMock.mockRejectedValueOnce(new WorkspaceApiError('/agents/a-quill/connectors', 403));
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Stripe' }));
    expect(await screen.findByText('Only a workspace admin can add Stripe to Quill.')).toBeTruthy();
    expect(within(row('Stripe')).queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('server refuses the attach until set up (TASK-761)', () => {
  it('a 409 says it is not set up yet and offers Retry that re-checks, not a blind attach', async () => {
    attachMock.mockRejectedValueOnce(new WorkspaceApiError('/agents/a-quill/connectors', 409));
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Stripe' }));
    expect(
      await screen.findByText(
        'Stripe isn’t signed in or set up yet, so we didn’t add it to Quill. Try again to finish setting it up.',
      ),
    ).toBeTruthy();
    expect(onAttached).not.toHaveBeenCalled();
    expect(within(row('Stripe')).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('ready connectors', () => {
  it('"Add" attaches straight away, with no sign-in and no key dialog', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Stripe' }));
    await waitFor(() => expect(attachMock).toHaveBeenCalledWith('a-quill', 'stripe'));
    expect(onAttached).toHaveBeenCalled();
    expect(beginOAuth).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"‹ Connectors" goes back without attaching anything', async () => {
    const { onBack } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }));
    expect(onBack).toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
  });
});
