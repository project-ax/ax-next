import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorsTab } from '../ConnectorsTab';
import * as connectorsLib from '@/lib/connectors';
import * as agentsLib from '@/lib/agents';
import * as connLib from '@/lib/connections';
import type { ConnectorSummary } from '@/lib/connectors';

const PRIVATE_CONN: ConnectorSummary = {
  id: 'my-notion',
  name: 'My Notion',
  description: 'Personal Notion workspace.',
  usageNote: 'Ask the agent to read or update Notion pages.',
  keyMode: 'personal',
  visibility: 'private',
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

// A SHARED connector → catalog-sourced (badge present). keyMode workspace → the
// connect flow spends one shared key.
const SHARED_CONN: ConnectorSummary = {
  id: 'company-salesforce',
  name: 'Salesforce',
  description: 'The company Salesforce org.',
  usageNote: 'Drive the sf CLI for our workflows.',
  keyMode: 'workspace',
  visibility: 'shared',
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

describe('ConnectorsTab', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
      PRIVATE_CONN,
      SHARED_CONN,
    ]);
    // Allowed-sites section deps — default empty so most tests focus on the
    // connector list. Tests that exercise allowed-sites override these.
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'getAllowedSites').mockResolvedValue({
      agentId: 'a1',
      hosts: [],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists the user connectors by service name', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    expect(await screen.findByText('My Notion')).toBeInTheDocument();
    expect(screen.getByText('Salesforce')).toBeInTheDocument();
  });

  it('shows the single "Catalog" badge ONLY on the catalog-sourced (shared) connector', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Salesforce');
    // Exactly one Catalog badge across the whole tab (only the shared connector).
    const badges = screen.getAllByText('Catalog');
    expect(badges).toHaveLength(1);
    // It belongs to the Salesforce tile (the shared/catalog connector).
    const sharedTile = screen.getByTestId('connector-tile-company-salesforce');
    expect(sharedTile.textContent).toMatch(/Catalog/);
    // The private connector's tile carries no "Catalog" copy.
    const privateTile = screen.getByTestId('connector-tile-my-notion');
    expect(privateTile.textContent).not.toMatch(/Catalog/);
  });

  it('keeps the default view mechanism-free (no transport/command/url/args)', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('My Notion');
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/stdio/i);
    expect(body).not.toMatch(/transport/i);
    expect(body).not.toMatch(/command/i);
    expect(body).not.toMatch(/\bargs\b/i);
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('captions what each connector needs (a key) without naming the mechanism', async () => {
    render(<ConnectorsTab isAdmin={false} />);
    await screen.findByText('Salesforce');
    // workspace keyMode → a shared key; personal → a personal key.
    expect(screen.getByText(/shared key/i)).toBeInTheDocument();
    expect(screen.getByText(/personal key/i)).toBeInTheDocument();
  });

  it('shows the empty state with no "catalog" language for a solo user', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([]);
    render(<ConnectorsTab isAdmin={false} />);
    await waitFor(() => {
      expect(screen.getByText(/no connected services/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Catalog')).toBeNull();
    expect(screen.queryByText(/catalog/i)).toBeNull();
  });

  it('surfaces a load error in an alert', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockRejectedValue(
      new Error('connectors boom'),
    );
    render(<ConnectorsTab isAdmin={false} />);
    await waitFor(() => {
      expect(screen.getByText('connectors boom')).toBeInTheDocument();
    });
  });

  it('shows the per-agent Allowed sites mirror and revokes a host', async () => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([
      { agentId: 'a1', displayName: 'Research', visibility: 'personal' },
    ]);
    vi.spyOn(connLib, 'getAllowedSites').mockResolvedValue({
      agentId: 'a1',
      hosts: [{ host: 'status.example.com', grantedAt: '2026-05-20T00:00:00Z' }],
    });
    const revoke = vi.spyOn(connLib, 'revokeAllowedSite').mockResolvedValue();
    render(<ConnectorsTab isAdmin={false} />);
    expect(await screen.findByText('Allowed sites')).toBeInTheDocument();
    expect(await screen.findByText('status.example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('a1', 'status.example.com'));
  });
});
