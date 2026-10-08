/**
 * The rail's Add subview (TASK-740, connectors-rail slice 7).
 *
 * Slice 3 — Add is one step that fully happens or leaves nothing:
 *   - an OAuth connector's Add opens the sign-in popup (`mode:'add'`); the
 *     server's callback attaches, so the browser only re-reads on success and
 *     NEVER calls attach itself;
 *   - a per-agent key connector's Add opens a key form whose save posts the
 *     keys with the attach, in one request;
 *   - a shared-key or no-auth connector's Add attaches straight away, with no
 *     keys in the body at all.
 * Also pinned: what "Available" means, name-only rows with one action, the
 * search, the team-agent consent, and the fixed copy for each failure.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AttachConnectorError, workspaceApi } from '@/lib/workspace-api';
import {
  emptyCapabilities,
  getConnector,
  listConnectors,
  type Connector,
  type ConnectorSummary,
} from '@/lib/connectors';
import { beginOAuth, getOAuthStatus } from '@/lib/connectors-oauth';
import { HttpError } from '@/lib/http';
import { myCredentials, adminCredentials } from '@/lib/credentials';
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

const attachMock = vi.mocked(workspaceApi.attachConnector);

function summary(id: string, name: string, extra: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    id,
    name,
    description: '',
    usageNote: '',
    keyMode: 'personal',
    visibility: 'shared',
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
    caps.credentials = [{ slot: 'token', kind: 'api-key', description: 'Paste a Zendesk API token.' }];
  return { ...s, capabilities: caps };
}

let popup: { closed: boolean; close: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  popup = { closed: false, close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => popup as unknown as Window);
  vi.mocked(workspaceApi.connectors).mockResolvedValue({
    connectors: [{ id: 'linear', name: 'Linear', source: 'attached', editable: false, health: 'ok', removable: true }],
    shared: false,
      connectorsSupported: true, manageable: true, sharedCredentials: false,
  });
  vi.mocked(listConnectors).mockResolvedValue(CATALOG);
  vi.mocked(getConnector).mockImplementation(async (id) => full(id));
  vi.mocked(getOAuthStatus).mockResolvedValue('not-connected');
  vi.mocked(beginOAuth).mockResolvedValue({ authorizationUrl: 'https://provider.example/auth' });
  vi.mocked(myCredentials.list).mockResolvedValue([]);
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
  // Every row's one action is "Add", whatever it takes to add it.
  for (const name of ['Notion', 'Zendesk', 'Stripe', 'Company CRM']) {
    await screen.findByRole('button', { name: `Add — ${name}` });
  }
}

function postOAuth(connector: string, oauth: 'success' | 'error', reason?: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: OAUTH_MESSAGE_TYPE, connector, oauth, ...(reason !== undefined ? { reason } : {}) },
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
      screen.getByText(/Pick one your workspace offers\. If it needs a sign-in or a key, we add it to Quill once that’s done\./),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Available/ }).textContent).toBe('Available4');
    expect(screen.queryByText('Linear')).toBeNull();
    // Name only: no subtitles like "Needs a sign-in".
    expect(screen.queryByText(/Needs a/)).toBeNull();
    expect(screen.getByText('Don’t see the one you need? Ask a workspace admin to set it up.')).toBeTruthy();
    expect(screen.getByTestId('connector-access-notice').textContent).toMatch(
      /Once this connector has a key or sign-in, this agent gets that same access/,
    );
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('a connector whose details do not load says so on its row and offers nothing to click', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getConnector).mockImplementation(async (id) => {
      if (id === 'zendesk') throw new Error('blip');
      return full(id);
    });
    renderAdd();
    await screen.findByRole('button', { name: 'Add — Stripe' });
    expect(await within(row('Zendesk')).findByText('Couldn’t load it')).toBeTruthy();
    expect(within(row('Zendesk')).queryByRole('button')).toBeNull();
    warn.mockRestore();
  });

  it("reads nobody's saved keys or sign-ins to decide what Add does", async () => {
    renderAdd('admin');
    await ready();
    expect(getOAuthStatus).not.toHaveBeenCalled();
    expect(myCredentials.list).not.toHaveBeenCalled();
    expect(adminCredentials.list).not.toHaveBeenCalled();
    expect(listConnectors).toHaveBeenCalledWith('/admin/connectors');
  });

  it('search filters by name and the count follows', async () => {
    renderAdd();
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search connectors' }), {
      target: { value: 'zen' },
    });
    expect(screen.getByRole('heading', { name: /^Available/ }).textContent).toBe('Available1');
    expect(screen.getByRole('button', { name: 'Add — Zendesk' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add — Notion' })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search connectors' }), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByText('Nothing matches that search.')).toBeTruthy();
  });

  it('says so when it cannot load the list, and Try again re-reads', async () => {
    vi.mocked(listConnectors).mockRejectedValueOnce(new Error('boom'));
    renderAdd();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await ready();
  });
});

describe('a swallowed failure is never silent (TASK-757)', () => {
  it('a sign-in that cannot start is logged, says so with a next step, and attaches nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(beginOAuth).mockRejectedValue(new Error('begin down'));
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    expect(await screen.findByText(/We couldn't start the sign-in\. Please try again/)).toBeTruthy();
    expect(
      warn.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('[oauth-sign-in notion]')),
    ).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('OAuth: Add opens the sign-in, and the server adds it', () => {
  it('Add begins an Add sign-in on this agent straight away — even if a sign-in exists somewhere', async () => {
    vi.mocked(getOAuthStatus).mockResolvedValue('connected');
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    expect(beginOAuth).toHaveBeenCalledWith({ connectorId: 'notion', agentId: 'a-quill', mode: 'add' });
    expect(getOAuthStatus).not.toHaveBeenCalled();
    // Pending: spinner + Cancel.
    expect(within(row('Notion')).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(row('Notion')).getByLabelText('Waiting for sign-in')).toBeTruthy();

    postOAuth('notion', 'success');
    // The callback already attached it: re-read, never attach from here.
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('Cancel closes the sign-in — and a success arriving later re-reads nothing', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    fireEvent.click(within(row('Notion')).getByRole('button', { name: 'Cancel' }));
    expect(popup.close).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add — Notion' })).toBeTruthy();
    postOAuth('notion', 'success');
    await new Promise((r) => setTimeout(r, 20));
    expect(onAttached).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    fireEvent.click(await within(row('Notion')).findByRole('button', { name: 'Cancel' }));
    await act(async () => {
      resolveBegin({ authorizationUrl: 'https://provider.example/auth' });
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add — Notion' })).toBeTruthy();
  });

  it('a pending sign-in survives a search that hides its row', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    const search = screen.getByRole('searchbox', { name: 'Search connectors' });
    fireEvent.change(search, { target: { value: 'stripe' } });
    fireEvent.change(search, { target: { value: '' } });
    expect(popup.close).not.toHaveBeenCalled();
    postOAuth('notion', 'success');
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
  });

  it('an OAuth connector that also declares a header key still adds by signing in alone', async () => {
    vi.mocked(getConnector).mockImplementation(async (id) => {
      const c = full(id);
      if (id === 'notion') c.capabilities.credentials.push({ slot: 'TOKEN', kind: 'api-key' });
      return c;
    });
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    postOAuth('notion', 'success');
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(attachMock).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled', 'Sign-in was cancelled, so nothing was added.'],
    ['not-allowed', "You can't add connectors to this agent any more."],
    [
      'add-failed',
      "You signed in, but we couldn't add it to this agent. Nothing was saved; try again.",
    ],
    ['sign-in-failed', "Sign-in didn't finish, so Notion isn't connected. You can try again whenever you're ready."],
    [undefined, "Sign-in didn't finish, so Notion isn't connected. You can try again whenever you're ready."],
    // Anything not on the list reads as the generic sentence — never as text.
    ['<b>provider said</b>', "Sign-in didn't finish, so Notion isn't connected. You can try again whenever you're ready."],
  ])('a failed sign-in (reason %s) shows fixed copy, adds nothing, and the row is still offered', async (reason, copy) => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    postOAuth('notion', 'error', reason);
    expect(await within(row('Notion').parentElement!).findByText(copy)).toBeTruthy();
    expect(screen.queryByText(/provider said/)).toBeNull();
    expect(onAttached).not.toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add — Notion' })).toBeTruthy();
  });

  it('a message for another connector, or from another origin, does nothing', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
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
    expect(onAttached).not.toHaveBeenCalled();
    expect(within(row('Notion')).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('a team agent (the server says shared) asks for consent before the sign-in starts', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({ connectors: [], shared: true, connectorsSupported: true, manageable: true, sharedCredentials: true });
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    expect(
      await screen.findByText(/lets anyone who uses Quill act as you on Notion/),
    ).toBeTruthy();
    expect(beginOAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(beginOAuth).toHaveBeenCalledWith({ connectorId: 'notion', agentId: 'a-quill', mode: 'add' }),
    );
  });

  // TASK-813 — only the team's admins may put a sign-in or key ON a team
  // agent; the server refuses everyone else (slice 3: keys too).
  it('a team agent offers no sign-in or key Add to someone who may not set them — plain Add stays', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({ connectors: [], shared: true, connectorsSupported: true, manageable: true, sharedCredentials: false });
    renderAdd('admin');
    await screen.findByRole('button', { name: 'Add — Stripe' });
    await waitFor(() =>
      expect(within(row('Notion')).getByText('Ask the agent’s owner to sign in')).toBeTruthy(),
    );
    expect(within(row('Notion')).queryByRole('button')).toBeNull();
    expect(within(row('Zendesk')).getByText('Ask the agent’s owner to add its key')).toBeTruthy();
    expect(within(row('Zendesk')).queryByRole('button')).toBeNull();
    expect(beginOAuth).not.toHaveBeenCalled();
  });

  it('a personal agent signs in without the consent step', async () => {
    vi.mocked(workspaceApi.connectors).mockResolvedValue({ connectors: [], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
    renderAdd();
    await ready();
    expect(screen.queryByText('Ask the agent’s owner to sign in')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Notion' }));
    await waitFor(() => expect(beginOAuth).toHaveBeenCalled());
    expect(screen.queryByText(/act as you on Notion/)).toBeNull();
  });
});

describe('per-agent key: the key form, saved with the Add', () => {
  async function openKeyForm() {
    fireEvent.click(screen.getByRole('button', { name: 'Add — Zendesk' }));
    return screen.findByRole('dialog', { name: 'Add Zendesk' });
  }

  it('posts the keys with the attach, in one request, then re-reads', async () => {
    const { onAttached } = renderAdd();
    await ready();
    const dialog = await openKeyForm();
    expect(within(dialog).getByText('Paste a Zendesk API token.')).toBeTruthy();
    expect(within(dialog).getByTestId('connector-access-notice')).toBeTruthy();
    const input = within(dialog).getByLabelText(/token/i) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(attachMock).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'sk-123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(attachMock).toHaveBeenCalledWith('a-quill', 'zendesk', [{ slot: 'token', payload: 'sk-123' }]),
    );
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
  });

  it('cannot be saved with a key missing, and closing it adds nothing', async () => {
    const { onAttached } = renderAdd();
    await ready();
    const dialog = await openKeyForm();
    expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(attachMock).not.toHaveBeenCalled();
    expect(onAttached).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'connector-needs-key', 'Zendesk needs every key filled in before it can be added.'],
    [409, 'connector-needs-sign-in', 'Zendesk is added by signing in. Go back and open Add again.'],
    [409, 'already-attached', 'Zendesk is already on Quill. To change its key, remove it and add it again.'],
    [403, 'agent-store-refused', 'You can’t add keys to Quill. Ask the agent’s owner.'],
    [403, 'forbidden', 'You can’t add keys to Quill. Ask the agent’s owner.'],
    [503, 'connector-check-failed', 'We couldn’t add Zendesk to Quill just now. Nothing was saved — please try again.'],
  ])('a %i %s refusal shows fixed copy in the form, and nothing is added', async (status, code, copy) => {
    attachMock.mockRejectedValueOnce(new AttachConnectorError('/agents/a-quill/connectors', status, code));
    const { onAttached } = renderAdd();
    await ready();
    const dialog = await openKeyForm();
    fireEvent.change(within(dialog).getByLabelText(/token/i), { target: { value: 'sk-123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText(copy)).toBeTruthy();
    expect(onAttached).not.toHaveBeenCalled();
    // The key stays typed: saving again is one click.
    expect((within(dialog).getByLabelText(/token/i) as HTMLInputElement).value).toBe('sk-123');
  });
});

describe('shared key or nothing to set up: Add adds straight away', () => {
  it('"Add" attaches with NO keys in the request at all', async () => {
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Stripe' }));
    await waitFor(() => expect(attachMock).toHaveBeenCalledTimes(1));
    expect(attachMock.mock.calls[0]).toEqual(['a-quill', 'stripe']);
    expect(onAttached).toHaveBeenCalled();
    expect(beginOAuth).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a shared-key connector adds straight away for anyone — no key form', async () => {
    const { onAttached } = renderAdd('admin');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Company CRM' }));
    await waitFor(() => expect(attachMock).toHaveBeenCalledTimes(1));
    expect(attachMock.mock.calls[0]).toEqual(['a-quill', 'company-crm']);
    expect(onAttached).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a refusal says only an admin can add it, with no Retry', async () => {
    attachMock.mockRejectedValueOnce(new AttachConnectorError('/agents/a-quill/connectors', 403, 'forbidden'));
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Stripe' }));
    expect(await screen.findByText('Only a workspace admin can add Stripe to Quill.')).toBeTruthy();
    expect(within(row('Stripe')).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a missing shared key says who can add it, with no Retry', async () => {
    attachMock.mockRejectedValueOnce(
      new AttachConnectorError('/agents/a-quill/connectors', 409, 'connector-needs-shared-key'),
    );
    const { onAttached } = renderAdd('user');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Company CRM' }));
    expect(
      await screen.findByText('Company CRM doesn’t have its shared key yet. Ask a workspace admin to add it.'),
    ).toBeTruthy();
    expect(onAttached).not.toHaveBeenCalled();
    expect(within(row('Company CRM')).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('an admin is told where to add the missing shared key', async () => {
    attachMock.mockRejectedValueOnce(
      new AttachConnectorError('/agents/a-quill/connectors', 409, 'connector-needs-shared-key'),
    );
    renderAdd('admin');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Company CRM' }));
    expect(
      await screen.findByText('Company CRM doesn’t have its shared key yet. Add it in Admin › Connectors, then try again.'),
    ).toBeTruthy();
  });

  it.each([
    [409, 'connector-needs-sign-in', 'Stripe is added by signing in. Go back and open Add again.'],
    [400, 'connector-needs-key', 'Stripe needs a key first. Go back and open Add again.'],
  ])('a %i %s (the list was out of date) says so, with no Retry', async (status, code, copy) => {
    attachMock.mockRejectedValueOnce(new AttachConnectorError('/agents/a-quill/connectors', status, code));
    renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Stripe' }));
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(within(row('Stripe')).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a network failure offers a plain Retry that tries the same Add again', async () => {
    attachMock.mockRejectedValueOnce(new HttpError('/api/workspace/agents/a-quill/connectors', 0));
    const { onAttached } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add — Stripe' }));
    expect(
      await screen.findByText('We couldn’t add Stripe to Quill just now. Nothing was saved — please try again.'),
    ).toBeTruthy();
    expect(onAttached).not.toHaveBeenCalled();
    fireEvent.click(within(row('Stripe')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(attachMock).toHaveBeenCalledTimes(2);
    expect(attachMock.mock.calls[1]).toEqual(['a-quill', 'stripe']);
  });

  it('"‹ Connectors" goes back without attaching anything', async () => {
    const { onBack } = renderAdd();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }));
    expect(onBack).toHaveBeenCalled();
    expect(attachMock).not.toHaveBeenCalled();
  });
});
