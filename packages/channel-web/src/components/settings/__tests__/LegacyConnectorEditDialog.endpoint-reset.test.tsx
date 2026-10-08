import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LegacyConnectorEditDialog } from '../LegacyConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import * as oauthLib from '@/lib/connectors-oauth';
import type { ConnectorSummary, Connector } from '@/lib/connectors';

/**
 * TASK-758 — the legacy editor says, before Save, that a new server URL
 * resets the server's tool permissions; and when the server refuses the save
 * because that reset failed, it says so plainly instead of the generic
 * "couldn't save".
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

const URL_SAVED = 'https://mcp.example.com/gdrive';

function full(): Connector {
  return {
    ...SUMMARY,
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      mcpServers: [
        {
          name: 'gdrive',
          transport: 'http',
          url: URL_SAVED,
          allowedHosts: [],
          credentials: [],
        },
      ],
    },
  };
}

const WARNING = 'endpoint-change-resets-tools';

async function openEditor(connector: Connector) {
  vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(connector);
  render(
    <LegacyConnectorEditDialog
      target={SUMMARY}
      open
      onOpenChange={() => {}}
      onSaved={() => {}}
    />,
  );
  const url = await screen.findByLabelText(/^url$/i);
  await waitFor(() => expect(url).toHaveValue(URL_SAVED));
  return { url };
}

describe('LegacyConnectorEditDialog — endpoint change resets tool permissions (TASK-758)', () => {
  beforeEach(() => {
    vi.spyOn(oauthLib, 'discoverOAuthHosts').mockResolvedValue({
      hosts: [],
      auth: 'oauth',
      clientRegistration: { cimd: false, dcr: true },
    });
    vi.spyOn(connectorsLib, 'patchConnector').mockResolvedValue(full());
    vi.spyOn(connectorsLib, 'createConnector').mockResolvedValue(full());
  });
  afterEach(() => vi.restoreAllMocks());

  it('no warning while the URL is what was saved', async () => {
    await openEditor(full());
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('warns when the URL changes, and the warning goes away when it is put back', async () => {
    const { url } = await openEditor(full());
    fireEvent.change(url, { target: { value: 'https://mcp.example.com/gdrive-v2' } });
    expect(await screen.findByTestId(WARNING)).toHaveTextContent(
      /resets its tool permissions.*asking first/i,
    );
    fireEvent.change(url, { target: { value: URL_SAVED } });
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('a new connector never warns — it has no permissions to lose', async () => {
    render(
      <LegacyConnectorEditDialog target="new" open onOpenChange={() => {}} onSaved={() => {}} />,
    );
    fireEvent.change(await screen.findByLabelText(/service name/i), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/^url$/i), { target: { value: 'https://mcp.example.com/x' } });
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('a refused save because the reset failed says so plainly and stays open', async () => {
    vi.spyOn(connectorsLib, 'patchConnector').mockRejectedValue(
      new Error(connectorsLib.TOOL_PERMISSIONS_RESET_FAILED),
    );
    const onSaved = vi.fn();
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(full());
    render(
      <LegacyConnectorEditDialog
        target={SUMMARY}
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const url = await screen.findByLabelText(/^url$/i);
    await waitFor(() => expect(url).toHaveValue(URL_SAVED));
    fireEvent.change(url, { target: { value: 'https://mcp.example.com/gdrive-v2' } });
    // Save waits for the new URL's host discovery to settle.
    const save = screen.getByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      connectorsLib.TOOL_PERMISSIONS_RESET_FAILED_MESSAGE,
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  // Slice 2a — any admin may edit a shared connector, but only the admin who
  // created it may retarget it. The server answers 403 owner-only-change; the
  // editor says what happened and what to do instead, and stays open.
  it('a retarget refused as owner-only says who can change it, and stays open', async () => {
    vi.spyOn(connectorsLib, 'patchConnector').mockRejectedValue(
      new Error('owner-only-change'),
    );
    const onSaved = vi.fn();
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(full());
    render(
      <LegacyConnectorEditDialog
        target={SUMMARY}
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const url = await screen.findByLabelText(/^url$/i);
    await waitFor(() => expect(url).toHaveValue(URL_SAVED));
    fireEvent.change(url, { target: { value: 'https://mcp.example.com/gdrive-v2' } });
    const save = screen.getByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the admin who created this connector can change where it connects. To point it somewhere else, delete it and add a new one.',
    );
    expect(connectorsLib.patchConnector).toHaveBeenCalledWith(
      SUMMARY.id,
      expect.anything(),
      '/admin/connectors',
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
