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

    await waitFor(() =>
      expect(connLib.setSiteAgents).toHaveBeenCalledWith(
        'all.example.com',
        [],
        expect.arrayContaining(['a1', 'a2']),
      ),
    );
  });

  it('disables Add when the user has no agents', async () => {
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([]);
    render(<AllowedSitesPanel />);
    await screen.findByText('No allowed sites yet — add one above.');
    expect(screen.getByRole('button', { name: 'Add a site' })).toBeDisabled();
  });
});
