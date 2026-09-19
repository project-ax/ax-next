import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { RememberedSitesPanel } from '../RememberedSitesPanel';
import * as sitesLib from '@/lib/remembered-sites';

describe('RememberedSitesPanel', () => {
  beforeEach(() => {
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([
      { host: 'user.example.com', scope: 'user', rememberedAt: '2026-01-05T00:00:00.000Z' },
      { host: 'admin.example.com', scope: 'global', rememberedAt: '2026-01-06T00:00:00.000Z' },
    ]);
    vi.spyOn(sitesLib, 'forgetRememberedSite').mockResolvedValue({ revoked: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows a global row with "Set by your admin" and no button; a user row with "Ask again"', async () => {
    render(<RememberedSitesPanel />);

    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    expect(within(userRow).getByRole('button', { name: 'Ask again' })).toBeInTheDocument();

    const globalRow = screen.getByTestId('remembered-site-admin.example.com');
    expect(within(globalRow).getByText('Set by your admin')).toBeInTheDocument();
    expect(within(globalRow).queryByRole('button', { name: 'Ask again' })).toBeNull();
  });

  it('clicking Ask again revokes the host and re-reads the list', async () => {
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await waitFor(() =>
      expect(sitesLib.forgetRememberedSite).toHaveBeenCalledWith('user.example.com'),
    );
    await waitFor(() =>
      expect(
        (sitesLib.listRememberedSites as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it('shows the "we\'ll ask next time" notice on revoked: true', async () => {
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('We’ll ask about that one next time.');
  });

  it('shows the "already gone" notice on revoked: false', async () => {
    vi.spyOn(sitesLib, 'forgetRememberedSite').mockResolvedValue({ revoked: false });
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('That one was already gone.');
  });

  it('shows the failure notice on a thrown DELETE, and the row stays', async () => {
    vi.spyOn(sitesLib, 'forgetRememberedSite').mockRejectedValue(new Error('boom'));
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');
    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('We couldn’t take that back just now. Nothing changed.');
    expect(screen.getByTestId('remembered-site-user.example.com')).toBeInTheDocument();
  });

  it('renders the empty state when there are no remembered sites', async () => {
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([]);
    render(<RememberedSitesPanel />);
    await screen.findByText(
      'Nothing here yet — we’ll ask the first time your assistant wants to read a new site.',
    );
  });

  it('shows a fetch failure in an Alert without crashing', async () => {
    vi.spyOn(sitesLib, 'listRememberedSites').mockRejectedValue(new Error('network down'));
    render(<RememberedSitesPanel />);
    await screen.findByText('network down');
  });

  it('keeps the notice on screen after the revoked row disappears from a re-read', async () => {
    render(<RememberedSitesPanel />);
    const userRow = await screen.findByTestId('remembered-site-user.example.com');

    // After the revoke, the next list() call comes back without that host —
    // the row that showed the button is gone, but the notice must still be
    // on screen (the #611 lesson: the notice belongs to the PANEL, not the row).
    vi.spyOn(sitesLib, 'listRememberedSites').mockResolvedValue([
      { host: 'admin.example.com', scope: 'global', rememberedAt: '2026-01-06T00:00:00.000Z' },
    ]);

    fireEvent.click(within(userRow).getByRole('button', { name: 'Ask again' }));

    await screen.findByText('We’ll ask about that one next time.');
    await waitFor(() =>
      expect(screen.queryByTestId('remembered-site-user.example.com')).toBeNull(),
    );
    // The row is gone; the notice must not be.
    expect(screen.getByText('We’ll ask about that one next time.')).toBeInTheDocument();
  });
});
