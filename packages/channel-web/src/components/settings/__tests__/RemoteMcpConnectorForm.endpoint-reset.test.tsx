import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import {
  TOOL_PERMISSIONS_RESET_FAILED,
  TOOL_PERMISSIONS_RESET_FAILED_MESSAGE,
  type Connector,
} from '@/lib/connectors';

/**
 * TASK-758 — when the server refuses a new address because it couldn't reset
 * the server's tool permissions first, the remote-MCP editor says exactly that
 * (nothing was saved; the old address is still in use) and stays open so Save
 * can try again.
 */

const fixture: Connector = {
  id: 'linear',
  name: 'Linear',
  description: '',
  usageNote: '',
  keyMode: 'personal',
  visibility: 'shared',
  defaultAttached: false,
  createdAt: '',
  updatedAt: '',
  capabilities: {
    allowedHosts: ['mcp.example.com'],
    credentials: [],
    mcpServers: [
      {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        allowedHosts: [],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
    services: [],
  },
};

let patchResponse: () => Response;
let patches: number;

beforeEach(() => {
  patches = 0;
  patchResponse = () => new Response(JSON.stringify({ connector: fixture }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (input.includes('/tool-permissions'))
        return new Response(
          JSON.stringify({ status: 'ok', checkedAt: null, tools: [], defaults: [] }),
        );
      if (input.endsWith('/discover-hosts'))
        return new Response(
          JSON.stringify({
            hosts: [],
            auth: 'none',
            clientRegistration: { cimd: false, dcr: false },
          }),
        );
      if (init?.method === 'PATCH' || init?.method === 'POST') {
        patches++;
        return patchResponse();
      }
      return new Response(JSON.stringify({ connector: fixture }));
    }),
  );
});

async function openAndMove() {
  const options = {
    target: fixture,
    open: true,
    onOpenChange: vi.fn(),
    onSaved: vi.fn(),
  };
  render(<ConnectorEditDialog {...options} />);
  await screen.findByLabelText('Name');
  fireEvent.change(screen.getByLabelText('Server URL'), {
    target: { value: 'https://other.example.com/mcp' },
  });
  expect(screen.getByTestId('address-change-resets-tools')).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled(),
  );
  return options;
}

describe('RemoteMcpConnectorForm — a failed tool-permission reset (TASK-758)', () => {
  it('says the save was refused because the reset failed, and stays open', async () => {
    patchResponse = () =>
      new Response(JSON.stringify({ error: TOOL_PERMISSIONS_RESET_FAILED }), {
        status: 503,
      });
    const options = await openAndMove();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(TOOL_PERMISSIONS_RESET_FAILED_MESSAGE)).toBeVisible();
    expect(patches).toBe(1);
    expect(options.onSaved).not.toHaveBeenCalled();
    expect(options.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('any other save failure keeps the generic message', async () => {
    patchResponse = () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    await openAndMove();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/couldn’t save this connector/i)).toBeVisible();
    expect(screen.queryByText(TOOL_PERMISSIONS_RESET_FAILED_MESSAGE)).toBeNull();
  });
});
