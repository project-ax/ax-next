import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { AllowedSitesPanel } from '../AllowedSitesPanel';
import * as agentsLib from '@/lib/agents';
import * as connLib from '@/lib/connections';

const AGENTS = [
  { agentId: 'a1', displayName: 'Research', visibility: 'personal' as const },
  { agentId: 'a2', displayName: 'Code', visibility: 'personal' as const },
];

describe('AllowedSitesPanel', () => {
  beforeEach(() => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue(AGENTS);
    // 'all.example.com' applies to BOTH agents; 'one.example.com' to a1 only.
    vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([
      { host: 'all.example.com', agentId: 'a1', grantedAt: 't' },
      { host: 'all.example.com', agentId: 'a2', grantedAt: 't' },
      { host: 'one.example.com', agentId: 'a1', grantedAt: 't' },
    ]);
    vi.spyOn(connLib, 'setSiteAgents').mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists each host once; "All agents" when it covers every agent, else per-agent badges', async () => {
    render(<AllowedSitesPanel />);
    const allRow = await screen.findByTestId('allowed-site-all.example.com');
    expect(within(allRow).getByText('All agents')).toBeInTheDocument();

    const oneRow = screen.getByTestId('allowed-site-one.example.com');
    // The a1-only host shows the agent name, NOT "All agents".
    expect(within(oneRow).getByText('Research')).toBeInTheDocument();
    expect(within(oneRow).queryByText('All agents')).toBeNull();
  });

  it('adds a site applied to all agents by default', async () => {
    render(<AllowedSitesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a site' }));

    // Dialog opens; default is all agents checked.
    const host = await screen.findByLabelText('Site');
    fireEvent.change(host, { target: { value: 'new.example.com' } });
    expect((screen.getByRole('checkbox', { name: 'All agents' }) as HTMLInputElement)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(connLib.setSiteAgents).toHaveBeenCalledWith(
        'new.example.com',
        expect.arrayContaining(['a1', 'a2']),
        [],
      ),
    );
    // Refresh after save.
    await waitFor(() =>
      expect((connLib.listAllAllowedSites as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });

  it('edits a host to add another agent (reconciles against the current set)', async () => {
    render(<AllowedSitesPanel />);
    const oneRow = await screen.findByTestId('allowed-site-one.example.com');
    fireEvent.click(within(oneRow).getByRole('button', { name: 'Edit' }));

    // Edit dialog for one.example.com: a1 checked, a2 not. Check a2 → save.
    await screen.findByText('Edit agents for one.example.com');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(connLib.setSiteAgents).toHaveBeenCalledWith(
        'one.example.com',
        expect.arrayContaining(['a1', 'a2']),
        ['a1'],
      ),
    );
  });

  it('removes a host by revoking it for all its agents', async () => {
    render(<AllowedSitesPanel />);
    const allRow = await screen.findByTestId('allowed-site-all.example.com');
    fireEvent.click(within(allRow).getByRole('button', { name: 'Remove' }));

    // Asks first: nothing is revoked until the dialog's "Remove site" is clicked.
    const dialog = await screen.findByRole('dialog', { name: 'Remove all.example.com?' });
    expect(connLib.setSiteAgents).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove site' }));

    await waitFor(() =>
      expect(connLib.setSiteAgents).toHaveBeenCalledWith(
        'all.example.com',
        [],
        expect.arrayContaining(['a1', 'a2']),
      ),
    );
    expect(connLib.setSiteAgents).toHaveBeenCalledTimes(1);
  });

  it('Cancel on the remove dialog revokes nothing', async () => {
    render(<AllowedSitesPanel />);
    const allRow = await screen.findByTestId('allowed-site-all.example.com');
    fireEvent.click(within(allRow).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove all.example.com?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(connLib.setSiteAgents).not.toHaveBeenCalled();
  });

  it('disables Add when the user has no agents', async () => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([]);
    render(<AllowedSitesPanel />);
    await screen.findByText('No allowed sites yet — add one above.');
    expect(screen.getByRole('button', { name: 'Add a site' })).toBeDisabled();
  });

  describe('team agents are not managed here', () => {
    const WITH_TEAM = [
      ...AGENTS,
      { agentId: 't1', displayName: 'Team Bot', visibility: 'team' as const },
    ];

    it("lists personal agents' sites only; a team agent's rows and badge never show", async () => {
      vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue(WITH_TEAM);
      vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([
        { host: 'all.example.com', agentId: 'a1', grantedAt: 't' },
        { host: 'all.example.com', agentId: 'a2', grantedAt: 't' },
        { host: 'all.example.com', agentId: 't1', grantedAt: 't' },
        { host: 'teamonly.example.com', agentId: 't1', grantedAt: 't' },
      ]);
      render(<AllowedSitesPanel />);
      const allRow = await screen.findByTestId('allowed-site-all.example.com');
      // Still "All agents": every PERSONAL agent has it; the team agent is not counted.
      expect(within(allRow).getByText('All agents')).toBeInTheDocument();
      expect(screen.queryByText('Team Bot')).toBeNull();
      expect(screen.queryByTestId('allowed-site-teamonly.example.com')).toBeNull();
      expect(
        screen.getByText(/A team agent’s sites are in that agent’s settings, under Connectors\./),
      ).toBeInTheDocument();
    });

    it('removing a host only touches the personal agents that hold it', async () => {
      vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue(WITH_TEAM);
      vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([
        { host: 'all.example.com', agentId: 'a1', grantedAt: 't' },
        { host: 'all.example.com', agentId: 't1', grantedAt: 't' },
      ]);
      render(<AllowedSitesPanel />);
      const row = await screen.findByTestId('allowed-site-all.example.com');
      fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Remove site' }));
      await waitFor(() =>
        expect(connLib.setSiteAgents).toHaveBeenCalledWith('all.example.com', [], ['a1']),
      );
    });

    it('Add a site offers personal agents only, and "All agents" means all of them', async () => {
      vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue(WITH_TEAM);
      render(<AllowedSitesPanel />);
      fireEvent.click(await screen.findByRole('button', { name: 'Add a site' }));
      fireEvent.change(await screen.findByLabelText('Site'), {
        target: { value: 'new.example.com' },
      });
      expect(screen.queryByRole('checkbox', { name: 'Team Bot' })).toBeNull();
      expect(screen.getByRole('checkbox', { name: 'Research' })).toBeTruthy();
      expect(
        screen.getByText(/Choose which of your personal agents may reach this site\./),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() =>
        expect(connLib.setSiteAgents).toHaveBeenCalledWith('new.example.com', ['a1', 'a2'], []),
      );
    });

    it('when the only agents are team agents, says where their sites are; Add is disabled', async () => {
      vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([WITH_TEAM[2]!]);
      // The team agent has a site. It is still not this panel's to show.
      vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([
        { host: 'teamonly.example.com', agentId: 't1', grantedAt: 't' },
      ]);
      render(<AllowedSitesPanel />);
      // Not "add one above": there is nothing here to add one to.
      await screen.findByText(
        'Your agents are all team agents. Their sites are in each agent’s settings, under Connectors.',
      );
      expect(screen.queryByText('No allowed sites yet — add one above.')).toBeNull();
      expect(screen.queryByTestId('allowed-site-teamonly.example.com')).toBeNull();
      expect(screen.getByRole('button', { name: 'Add a site' })).toBeDisabled();
    });

    it('when the agent list fails, the panel says so instead of showing an empty list', async () => {
      vi.spyOn(agentsLib, 'listChatAgents').mockRejectedValue(new Error('nope'));
      render(<AllowedSitesPanel />);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.queryByTestId('allowed-site-all.example.com')).toBeNull();
      expect(screen.queryByText('No allowed sites yet — add one above.')).toBeNull();
      expect(screen.getByRole('button', { name: 'Add a site' })).toBeDisabled();
    });
  });
});
