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
    credentials: [{ slot: 'token', kind: 'api-key', account: 'notion' }],
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

describe('ConnectorConnectDialog', () => {
  beforeEach(() => {
    vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
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
          destination: { kind: 'account', service: 'notion' },
          scope: { scope: 'user', ownerId: null },
          payload: 'secret-token',
        }),
      ),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
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
