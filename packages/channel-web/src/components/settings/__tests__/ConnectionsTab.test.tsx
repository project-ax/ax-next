import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectionsTab } from '../ConnectionsTab';
import * as agentsLib from '../../../lib/agents';
import * as connLib from '../../../lib/connections';

describe('ConnectionsTab', () => {
  beforeEach(() => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([
      { agentId: 'a1', displayName: 'Research', visibility: 'personal' },
    ]);
    vi.spyOn(connLib, 'getConnections').mockResolvedValue({
      agentId: 'a1',
      skills: [
        { skillId: 'web_search', description: 'Search the web', source: 'default', removable: false },
        { skillId: 'linear', description: 'Linear issues', source: 'user', removable: true },
      ],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the merged skills with locked/removable affordances', async () => {
    render(<ConnectionsTab />);
    expect(await screen.findByText('Linear issues')).toBeInTheDocument();
    expect(screen.getByText('Search the web')).toBeInTheDocument();
    // default is locked (no Remove), user-added is removable.
    expect(screen.getAllByRole('button', { name: /remove/i })).toHaveLength(1);
  });

  it('Remove calls detachConnectionSkill and refetches', async () => {
    const detach = vi.spyOn(connLib, 'detachConnectionSkill').mockResolvedValue();
    render(<ConnectionsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /remove/i }));
    await waitFor(() => expect(detach).toHaveBeenCalledWith('a1', 'linear'));
    // refetch after remove (initial load + post-remove reload).
    await waitFor(() => expect(connLib.getConnections).toHaveBeenCalledTimes(2));
  });

  it('shows an error alert when the connections load fails', async () => {
    vi.spyOn(connLib, 'getConnections').mockRejectedValue(new Error('connections: 500'));
    render(<ConnectionsTab />);
    expect(await screen.findByText(/connections: 500/)).toBeInTheDocument();
  });
});
