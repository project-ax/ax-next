import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LegacyConnectorEditDialog } from '../LegacyConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import * as oauthLib from '@/lib/connectors-oauth';
import type { ConnectorSummary, Connector } from '@/lib/connectors';

/**
 * TASK-827 — whose key a connector uses is fixed once it exists (the server
 * refuses a change), so the legacy editor only offers the choice on a new one.
 */

const SUMMARY: ConnectorSummary = {
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: '',
  keyMode: 'workspace',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function full(): Connector {
  return { ...SUMMARY, capabilities: connectorsLib.emptyCapabilities() };
}

const LOCKED = 'To change whose key it uses, create a new connector.';

describe('LegacyConnectorEditDialog — whose key (TASK-827)', () => {
  beforeEach(() => {
    vi.spyOn(oauthLib, 'discoverOAuthHosts').mockResolvedValue({
      hosts: [],
      auth: 'none',
    });
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(full());
  });
  afterEach(() => vi.restoreAllMocks());

  it('editing an existing connector disables the choice and says how to change it', async () => {
    render(
      <LegacyConnectorEditDialog target={SUMMARY} open onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const trigger = await screen.findByLabelText('Whose key');
    await waitFor(() => expect(trigger).toHaveTextContent(/One shared key for everyone/));
    expect(trigger).toBeDisabled();
    expect(screen.getByText(LOCKED)).toBeInTheDocument();
  });

  it('a new connector can still pick whose key', async () => {
    render(
      <LegacyConnectorEditDialog target="new" open onOpenChange={() => {}} onSaved={() => {}} />,
    );
    const trigger = await screen.findByLabelText('Whose key');
    expect(trigger).toBeEnabled();
    expect(screen.queryByText(LOCKED)).not.toBeInTheDocument();
    // Slice 5 — a per-agent key is the default, and the words say whose.
    expect(trigger).toHaveTextContent('Each agent adds its own key');
  });
});
