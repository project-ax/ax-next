import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { AuthProvidersTab } from '../AuthProvidersTab';
import type { AuthProviderEntry } from '@/lib/auth-providers';

// Mock the wire clients at the lib boundary — no network.
vi.mock('@/lib/auth-providers', () => ({
  listAuthProviders: vi.fn(),
  setAuthProviderEnabled: vi.fn(),
  deleteAuthProvider: vi.fn(),
}));
// AddProviderForm only renders in the add flow; stub it out.
vi.mock('../AddProviderForm', () => ({ AddProviderForm: () => null }));

import { listAuthProviders, deleteAuthProvider, setAuthProviderEnabled } from '@/lib/auth-providers';

const mockList = vi.mocked(listAuthProviders);
const mockDelete = vi.mocked(deleteAuthProvider);

const PROVIDER: AuthProviderEntry = {
  kind: 'google',
  clientId: 'client-123.apps.googleusercontent.com',
  discoveryUrl: null,
  allowedDomains: null,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('AuthProvidersTab — styled delete confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([PROVIDER]);
    mockDelete.mockResolvedValue(undefined);
  });

  it('does not use the OS confirm; clicking remove opens a styled dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<AuthProvidersTab />);

    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Google' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Google' }));

    await waitFor(() => {
      expect(screen.getByText('Remove provider?')).toBeTruthy();
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Google');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('confirm path → calls deleteAuthProvider with the kind', async () => {
    render(<AuthProvidersTab />);
    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Google' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Google' }));
    await waitFor(() => {
      expect(screen.getByText('Remove provider?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('google');
    });
  });

  it('cancel path → dialog closes and deleteAuthProvider is NOT called', async () => {
    render(<AuthProvidersTab />);
    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Google' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Google' }));
    await waitFor(() => {
      expect(screen.getByText('Remove provider?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Remove provider?')).toBeNull();
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('AuthProvidersTab — sign-in methods list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([PROVIDER, { ...PROVIDER, kind: 'github', clientId: 'gh-1' }]);
    vi.mocked(setAuthProviderEnabled).mockResolvedValue(undefined);
  });

  it('is one named list with a row per method, each with a details button and a switch', async () => {
    render(<AuthProvidersTab />);
    const list = await screen.findByRole('list', { name: 'Sign-in methods' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('button', { name: 'Google' })).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('switch', { name: 'Disable Google' })).toBeInTheDocument();
  });

  it('flipping the switch toggles the method and never opens its details', async () => {
    render(<AuthProvidersTab />);
    const list = await screen.findByRole('list', { name: 'Sign-in methods' });
    fireEvent.click(within(list).getByRole('switch', { name: 'Disable Google' }));
    await waitFor(() => expect(vi.mocked(setAuthProviderEnabled)).toHaveBeenCalledWith('google', false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
