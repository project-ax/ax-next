import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KeysTab } from '../KeysTab';
import * as credLib from '../../../lib/credentials';

describe('KeysTab', () => {
  beforeEach(() => {
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([
      { scope: 'user', ownerId: 'u1', ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key', createdAt: '2026-05-20T00:00:00Z' },
      { scope: 'user', ownerId: 'u1', ref: 'skill:github:GH_TOKEN', kind: 'api-key', createdAt: '2026-05-22T00:00:00Z' },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists the user keys masked, with a used-by hint derived from the ref', async () => {
    render(<KeysTab />);
    // "used by: <skill>" is the skill id parsed from skill:<id>:<slot>
    expect(await screen.findByText(/used by: linear/)).toBeInTheDocument();
    expect(screen.getByText(/used by: github/)).toBeInTheDocument();
    // the raw secret slot value is never rendered as a key=value pair
    expect(screen.queryByText(/LINEAR_API_KEY=/)).not.toBeInTheDocument();
    // each row shows a masked indicator
    expect(screen.getAllByText('••••••').length).toBe(2);
  });

  it('Remove calls clearDestinationCredential with the parsed skill-slot destination', async () => {
    const clear = vi.spyOn(credLib, 'clearDestinationCredential').mockResolvedValue();
    render(<KeysTab />);
    await screen.findByText(/used by: linear/);
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith({
        destination: { kind: 'skill-slot', skillId: 'linear', slot: 'LINEAR_API_KEY' },
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
