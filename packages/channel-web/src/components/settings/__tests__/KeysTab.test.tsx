import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KeysTab } from '../KeysTab';
import * as credLib from '../../../lib/credentials';
import * as connLib from '../../../lib/connections';

describe('KeysTab', () => {
  beforeEach(() => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      { scope: 'user', ownerId: 'u1', ref: 'account:linear', kind: 'api-key', createdAt: '2026-05-20T00:00:00Z' },
      { scope: 'user', ownerId: 'u1', ref: 'skill:github:GH_TOKEN', kind: 'api-key', createdAt: '2026-05-22T00:00:00Z' },
    ]);
    vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({
      linear: ['linear', 'linear-search'],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists a service-keyed account row with a used-by hint from account-usage', async () => {
    render(<KeysTab />);
    // account:linear → service label "linear" + used-by from the usage map.
    expect(await screen.findByText(/used by: linear, linear-search/)).toBeInTheDocument();
    // the masked indicator is rendered per row.
    expect(screen.getAllByText('••••••').length).toBe(2);
    // the raw secret value is never rendered as a key=value pair.
    expect(screen.queryByText(/GH_TOKEN=/)).not.toBeInTheDocument();
  });

  it('keeps per-slot (skill) rows working (back-compat)', async () => {
    render(<KeysTab />);
    // skill:github:GH_TOKEN → used by: github · GH_TOKEN
    expect(await screen.findByText(/used by: github · GH_TOKEN/)).toBeInTheDocument();
  });

  it('falls back to the service name when no skill references it yet', async () => {
    vi.spyOn(connLib, 'getAccountUsage').mockResolvedValue({});
    render(<KeysTab />);
    // account:linear with empty usage → "used by: linear" (the service name).
    expect(await screen.findByText('used by: linear')).toBeInTheDocument();
  });

  it('Add a key by service calls setDestinationCredential with the account destination', async () => {
    const set = vi.spyOn(credLib, 'setDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    fireEvent.click(screen.getByRole('button', { name: /^add a key$/i }));
    fireEvent.change(await screen.findByLabelText(/^service$/i), { target: { value: 'github' } });
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: 'ghp_secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({
        destination: { kind: 'account', service: 'github' },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload: 'ghp_secret',
      }),
    );
  });

  it('rejects an invalid service slug with a friendly error and disables Save', async () => {
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    fireEvent.click(screen.getByRole('button', { name: /^add a key$/i }));
    fireEvent.change(await screen.findByLabelText(/^service$/i), { target: { value: 'Bad Service' } });
    expect(screen.getByText(/lowercase service name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('Remove on an account row calls clearDestinationCredential with the account destination', async () => {
    const clear = vi.spyOn(credLib, 'clearDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    // the first Remove button is the account:linear row.
    fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0]!);
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        destination: { kind: 'account', service: 'linear' },
        scope: { scope: 'user', ownerId: null },
      }),
    );
  });

  it('Remove on a per-slot row calls clearDestinationCredential with the skill-slot destination', async () => {
    const clear = vi.spyOn(credLib, 'clearDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: github · GH_TOKEN/);
    // the second Remove button is the skill:github:GH_TOKEN row.
    fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[1]!);
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        destination: { kind: 'skill-slot', skillId: 'github', slot: 'GH_TOKEN' },
        scope: { scope: 'user', ownerId: null },
      }),
    );
  });

  it('shows an empty-state when there are no keys', async () => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([]);
    render(<KeysTab />);
    expect(await screen.findByText(/no keys yet/i)).toBeInTheDocument();
  });
});
