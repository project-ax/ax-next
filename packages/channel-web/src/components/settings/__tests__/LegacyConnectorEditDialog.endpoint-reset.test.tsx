import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LegacyConnectorEditDialog } from '../LegacyConnectorEditDialog';
import * as connectorsLib from '@/lib/connectors';
import * as oauthLib from '@/lib/connectors-oauth';
import type { ConnectorSummary, Connector } from '@/lib/connectors';

/**
 * TASK-758 — the stdio (legacy) editor says, before Save, that a new command
 * or args resets the server's tool permissions; and when the server refuses
 * the save because that reset failed, it says so plainly instead of the
 * generic "couldn't save".
 */

const SUMMARY: ConnectorSummary = {
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: '',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function full(args?: string[]): Connector {
  return {
    ...SUMMARY,
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      mcpServers: [
        {
          name: 'gdrive',
          transport: 'stdio',
          command: 'mcp-gdrive',
          ...(args !== undefined && { args }),
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
      isAdmin
      onOpenChange={() => {}}
      onSaved={() => {}}
    />,
  );
  const command = await screen.findByLabelText(/^command$/i);
  await waitFor(() => expect(command).toHaveValue('mcp-gdrive'));
  return { command, args: screen.getByLabelText(/^args/i) };
}

describe('LegacyConnectorEditDialog — endpoint change resets tool permissions (TASK-758)', () => {
  beforeEach(() => {
    vi.spyOn(oauthLib, 'discoverOAuthHosts').mockResolvedValue({
      hosts: [],
      auth: 'oauth',
      clientRegistration: { cimd: false, dcr: true },
    });
    vi.spyOn(connectorsLib, 'patchConnector').mockResolvedValue(full(['--x']));
    vi.spyOn(connectorsLib, 'createConnector').mockResolvedValue(full());
  });
  afterEach(() => vi.restoreAllMocks());

  it('no warning while the command and args are what was saved', async () => {
    await openEditor(full(['--read-only']));
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('warns when the command changes, and the warning goes away when it is put back', async () => {
    const { command } = await openEditor(full(['--read-only']));
    fireEvent.change(command, { target: { value: 'mcp-gdrive-v2' } });
    expect(await screen.findByTestId(WARNING)).toHaveTextContent(
      /resets its tool permissions.*asking first/i,
    );
    fireEvent.change(command, { target: { value: 'mcp-gdrive' } });
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('warns when the args change', async () => {
    const { args } = await openEditor(full(['--read-only']));
    fireEvent.change(args, { target: { value: '--read-write' } });
    expect(await screen.findByTestId(WARNING)).toBeInTheDocument();
  });

  it('a server saved with no args is not "changed" by the empty args box', async () => {
    const { args } = await openEditor(full());
    expect(args).toHaveValue('');
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('a new connector never warns — it has no permissions to lose', async () => {
    render(
      <LegacyConnectorEditDialog target="new" open isAdmin onOpenChange={() => {}} onSaved={() => {}} />,
    );
    fireEvent.change(await screen.findByLabelText(/service name/i), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/^command$/i), { target: { value: 'mcp-x' } });
    expect(screen.queryByTestId(WARNING)).not.toBeInTheDocument();
  });

  it('a refused save because the reset failed says so plainly and stays open', async () => {
    vi.spyOn(connectorsLib, 'patchConnector').mockRejectedValue(
      new Error(connectorsLib.TOOL_PERMISSIONS_RESET_FAILED),
    );
    const onSaved = vi.fn();
    vi.spyOn(connectorsLib, 'getConnector').mockResolvedValue(full(['--read-only']));
    render(
      <LegacyConnectorEditDialog
        target={SUMMARY}
        open
        isAdmin
        onOpenChange={() => {}}
        onSaved={onSaved}
      />,
    );
    const command = await screen.findByLabelText(/^command$/i);
    await waitFor(() => expect(command).toHaveValue('mcp-gdrive'));
    fireEvent.change(command, { target: { value: 'mcp-gdrive-v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      connectorsLib.TOOL_PERMISSIONS_RESET_FAILED_MESSAGE,
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
