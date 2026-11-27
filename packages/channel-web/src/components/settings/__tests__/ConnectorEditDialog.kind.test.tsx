import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ConnectorEditDialog } from '../ConnectorEditDialog';
import * as oauthLib from '@/lib/connectors-oauth';
import { emptyCapabilities, type ConnectorPrefill } from '@/lib/connectors';

const props = () => ({ target: 'new' as const, open: true, onOpenChange: vi.fn(), onSaved: vi.fn() });
const MCP_REQUEST: ConnectorPrefill = {
  connectorId: 'notion',
  name: 'Notion',
  usageNote: '',
  keyMode: 'personal',
  capabilities: {
    ...emptyCapabilities(),
    mcpServers: [{ name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', allowedHosts: [], credentials: [] }],
  },
};

describe('ConnectorEditDialog kind (TASK-1239)', () => {
  // The remote form reads AX's OAuth client details on mount; keep it offline.
  beforeEach(() => {
    vi.spyOn(oauthLib, 'getOAuthClientMetadata').mockRejectedValue(new Error('offline'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('a blank new connector opens the remote MCP form by default', () => {
    render(<ConnectorEditDialog {...props()} />);
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    expect(screen.queryByLabelText(/paste a docker-compose/i)).toBeNull();
  });

  it('kind "general" opens the general editor blank, on Direct API, with the compose paste', async () => {
    render(<ConnectorEditDialog {...props()} kind="general" />);
    const dialog = await screen.findByRole('dialog', { name: 'New connector' });
    expect(within(dialog).getByRole('radio', { name: /direct api/i })).toHaveAttribute('data-state', 'on');
    expect(within(dialog).queryByLabelText(/^url$/i)).toBeNull();
    expect(within(dialog).getByLabelText(/service name/i)).toHaveValue('');
    expect(within(dialog).getByLabelText(/paste a docker-compose/i)).toBeInTheDocument();
  });

  it('a prefill wins over kind', () => {
    render(<ConnectorEditDialog {...props()} prefill={MCP_REQUEST} kind="general" />);
    expect(screen.getByLabelText('Server URL')).toHaveValue('https://mcp.notion.com/mcp');
  });

  it('keeps what the admin typed when the parent re-renders', async () => {
    const { rerender } = render(<ConnectorEditDialog {...props()} kind="general" />);
    fireEvent.change(await screen.findByLabelText(/service name/i), { target: { value: 'Dev stack' } });
    rerender(<ConnectorEditDialog {...props()} kind="general" />);
    expect(screen.getByLabelText(/service name/i)).toHaveValue('Dev stack');
  });
});
