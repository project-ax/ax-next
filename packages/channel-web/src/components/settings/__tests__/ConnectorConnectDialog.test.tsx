import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorConnectDialog } from '../ConnectorConnectDialog';
import * as connectorsLib from '@/lib/connectors';
import * as credLib from '@/lib/credentials';
import type { Connector } from '@/lib/connectors';

function fullConnector(overrides: Partial<Connector>): Connector {
  return {
    id: 'c1',
    name: 'C1',
    description: '',
    usageNote: '',
    keyMode: 'personal',
    visibility: 'private',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    capabilities: connectorsLib.emptyCapabilities(),
    defaultAttached: false,
    ...overrides,
  };
}

const PERSONAL = fullConnector({
  id: 'my-notion',
  name: 'My Notion',
  keyMode: 'personal',
  visibility: 'private',
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    credentials: [{ slot: 'token', kind: 'api-key' }],
  },
});

const WORKSPACE = fullConnector({
  id: 'company-sf',
  name: 'Salesforce',
  keyMode: 'workspace',
  visibility: 'shared',
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    credentials: [{ slot: 'sf-key', kind: 'api-key' }],
  },
});

const NO_KEY = fullConnector({
  id: 'plain-mcp',
  name: 'Plain MCP',
  keyMode: 'personal',
  visibility: 'private',
  capabilities: connectorsLib.emptyCapabilities(),
});

// TASK-124 — a multi-slot connector. Both slots fall back to the connector id as
// the service tag; the per-slot ref form keeps them on DISTINCT vault rows
// (`account:<id>:<SLOT>`), and the dialog must build the destination from the
// plan's structured `service`/`slotTag`, never by slicing the `:`-bearing ref.
const MULTI_SLOT = fullConnector({
  id: 'oauthsvc',
  name: 'OAuth Service',
  keyMode: 'personal',
  visibility: 'private',
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    credentials: [
      { slot: 'CLIENT_ID', kind: 'api-key' },
      { slot: 'CLIENT_SECRET', kind: 'api-key' },
    ],
  },
});

describe('ConnectorConnectDialog', () => {
  beforeEach(() => {
    vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
    // Per-slot presence reads the credential lists on open. Default: empty (every
    // slot shows "enter"). Individual tests override to simulate a stored key.
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([]);
    vi.spyOn(credLib.adminCredentials, 'list').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('personal connector prompts for a PER-USER key (user-scope write)', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(PERSONAL);
    const onConnected = vi.fn();
    render(
      <ConnectorConnectDialog
        connectorId="my-notion"
        connectorName="My Notion"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={onConnected}
      />,
    );
    // A personal connector goes straight to key entry (no consent gate).
    const input = await screen.findByLabelText(/API key/i);
    fireEvent.change(input, { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$|^Connect$/i }));
    await waitFor(() =>
      expect(credLib.setDestinationCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          // Each connector owns its own key → ref keyed by the connector id.
          destination: { kind: 'account', service: 'my-notion' },
          scope: { scope: 'user', ownerId: null },
          payload: 'secret-token',
        }),
      ),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  it('multi-slot connector writes a DISTINCT per-slot account destination per slot (TASK-124)', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(MULTI_SLOT);
    render(
      <ConnectorConnectDialog
        connectorId="oauthsvc"
        connectorName="OAuth Service"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={() => {}}
      />,
    );
    // One key field per slot, headed by the slot name; the slots render in
    // declaration order (CLIENT_ID then CLIENT_SECRET).
    expect(await screen.findByText('CLIENT_ID')).toBeInTheDocument();
    expect(screen.getByText('CLIENT_SECRET')).toBeInTheDocument();
    const fields = screen.getAllByLabelText(/API key/i);
    expect(fields).toHaveLength(2);
    fireEvent.change(fields[0]!, { target: { value: 'the-id' } });
    fireEvent.change(fields[1]!, { target: { value: 'the-secret' } });
    // Each slot's form has its own Save button; saving both writes two refs.
    const saves = screen.getAllByRole('button', { name: /^Save$|^Connect$/i });
    fireEvent.click(saves[0]!);
    fireEvent.click(saves[1]!);
    await waitFor(() => {
      expect(credLib.setDestinationCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: { kind: 'account', service: 'oauthsvc', slot: 'CLIENT_ID' },
          payload: 'the-id',
        }),
      );
      expect(credLib.setDestinationCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: { kind: 'account', service: 'oauthsvc', slot: 'CLIENT_SECRET' },
          payload: 'the-secret',
        }),
      );
    });
  });

  it('workspace connector shows the shared-key CONSENT gate before the key form', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(WORKSPACE);
    render(
      <ConnectorConnectDialog
        connectorId="company-sf"
        connectorName="Salesforce"
        isAdmin
        open
        onOpenChange={() => {}}
        onConnected={() => {}}
      />,
    );
    // The consent copy is rendered, filled with the service name.
    expect(
      await screen.findByText(
        /Sharing this key lets their assistant act as you on Salesforce/i,
      ),
    ).toBeInTheDocument();
    // The key-entry form is NOT reachable yet — no API key field until consent.
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
    // Accept consent → the key form appears.
    fireEvent.click(screen.getByRole('button', { name: /I understand/i }));
    expect(await screen.findByLabelText(/API key/i)).toBeInTheDocument();
  });

  it('workspace + non-admin: cannot store the shared key, points to an admin', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(WORKSPACE);
    render(
      <ConnectorConnectDialog
        connectorId="company-sf"
        connectorName="Salesforce"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={() => {}}
      />,
    );
    expect(await screen.findByText(/an admin/i)).toBeInTheDocument();
    // No key field for a non-admin on a workspace connector.
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  it('workspace key write goes to GLOBAL scope after consent (admin)', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(WORKSPACE);
    const onConnected = vi.fn();
    render(
      <ConnectorConnectDialog
        connectorId="company-sf"
        connectorName="Salesforce"
        isAdmin
        open
        onOpenChange={() => {}}
        onConnected={onConnected}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /I understand/i }));
    const input = await screen.findByLabelText(/API key/i);
    fireEvent.change(input, { target: { value: 'company-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$|^Connect$/i }));
    await waitFor(() =>
      expect(credLib.setDestinationCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          // workspace → global scope; untagged slot → ref account:<connectorId>
          destination: { kind: 'account', service: 'company-sf' },
          scope: { scope: 'global', ownerId: null },
        }),
      ),
    );
  });

  it('a connector with no credential slots needs no key', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(NO_KEY);
    render(
      <ConnectorConnectDialog
        connectorId="plain-mcp"
        connectorName="Plain MCP"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={() => {}}
      />,
    );
    expect(await screen.findByText(/needs no key/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  it('a slot whose key is already stored shows Replace + Remove (not just enter)', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(PERSONAL);
    // The user already has a key at the slot's derived ref (account:my-notion).
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      {
        scope: 'user',
        ownerId: 'alice',
        ref: 'account:my-notion',
        kind: 'api-key',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ]);
    render(
      <ConnectorConnectDialog
        connectorId="my-notion"
        connectorName="My Notion"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={() => {}}
      />,
    );
    expect(await screen.findByRole('button', { name: /^Replace$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Remove$/i })).toBeInTheDocument();
    // The empty-slot affordance ("Save") is NOT shown for a set slot.
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull();
  });

  it('an empty slot shows enter (Save), no Remove', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(PERSONAL);
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([]);
    render(
      <ConnectorConnectDialog
        connectorId="my-notion"
        connectorName="My Notion"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={() => {}}
      />,
    );
    expect(await screen.findByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove$/i })).toBeNull();
  });

  it('removing a stored key calls the clear path and notifies the parent', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(PERSONAL);
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      {
        scope: 'user',
        ownerId: 'alice',
        ref: 'account:my-notion',
        kind: 'api-key',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ]);
    const clear = vi.spyOn(credLib, 'clearDestinationCredential').mockResolvedValue();
    const onConnected = vi.fn();
    render(
      <ConnectorConnectDialog
        connectorId="my-notion"
        connectorName="My Notion"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={onConnected}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/i }));
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: { kind: 'account', service: 'my-notion' },
          scope: { scope: 'user', ownerId: null },
        }),
      ),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  it('surfaces a load error', async () => {
    vi.spyOn(connectorsLib, 'getConnector').mockRejectedValue(new Error('get boom'));
    render(
      <ConnectorConnectDialog
        connectorId="c1"
        connectorName="C1"
        isAdmin={false}
        open
        onOpenChange={() => {}}
        onConnected={() => {}}
      />,
    );
    expect(await screen.findByText('get boom')).toBeInTheDocument();
  });
});
