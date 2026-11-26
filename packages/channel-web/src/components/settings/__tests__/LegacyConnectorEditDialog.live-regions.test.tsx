import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LegacyConnectorEditDialog } from '../LegacyConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import * as oauthLib from '@/lib/connectors-oauth';
import type { ConnectorSummary, Connector } from '@/lib/connectors';

/**
 * The OAuth-hosts discovery area swaps between loading, a result and an error.
 * AsyncState and Notice each carry their own live role, so nothing around them
 * may be a live region too: a live region inside another is announced twice
 * or not at all.
 */

const SUMMARY: ConnectorSummary = {
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: '',
  keyMode: 'personal',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function full(): Connector {
  return {
    ...SUMMARY,
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      mcpServers: [
        { name: 'gdrive', transport: 'http', url: 'https://mcp.example.com/gdrive', allowedHosts: [], credentials: [] },
      ],
    },
  };
}

const LIVE = '[role="status"],[role="alert"],[aria-live]';

function expectNoNestedLiveRegions(): void {
  for (const outer of document.querySelectorAll(LIVE)) {
    expect(outer.querySelector(LIVE), outer.textContent ?? '').toBeNull();
  }
}

async function open() {
  vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(full());
  render(<LegacyConnectorEditDialog target={SUMMARY} open onOpenChange={() => {}} onSaved={() => {}} />);
  const url = await screen.findByLabelText(/^url$/i);
  await waitFor(() => expect(url).toHaveValue('https://mcp.example.com/gdrive'));
  return url;
}

describe('LegacyConnectorEditDialog — live regions in OAuth host discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loading and a ready result are not nested live regions', async () => {
    vi.spyOn(oauthLib, 'discoverOAuthHosts').mockResolvedValue({
      hosts: ['auth.example.com'],
      auth: 'oauth',
      clientRegistration: { cimd: false, dcr: true },
    });
    await open();
    expectNoNestedLiveRegions();
    expect(await screen.findByText('auth.example.com')).toBeInTheDocument();
    expectNoNestedLiveRegions();
  });

  it('a failed discovery is one alert with Try again, not an alert inside a status', async () => {
    vi.spyOn(oauthLib, 'discoverOAuthHosts').mockRejectedValue(new Error('nope'));
    await open();
    const alert = await screen.findByText(/Could not discover OAuth hosts/);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(alert.closest('[role="status"],[aria-live]')).toBeNull();
    expectNoNestedLiveRegions();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(oauthLib.discoverOAuthHosts).toHaveBeenCalledTimes(2));
  });
});
