import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { ConnectorRegistry } from '../ConnectorRegistry';
import type { ConnectorSummary } from '@/lib/connectors';

// Mock only the network surface of the connectors lib; keep the real pure
// helpers (emptyCapabilities is referenced at module load via emptyForm()).
vi.mock('@/lib/connectors', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/connectors')>(
      '@/lib/connectors',
    );
  return {
    ...actual,
    listConnectors: vi.fn(),
    getConnector: vi.fn(),
    createConnector: vi.fn(),
    patchConnector: vi.fn(),
    deleteConnector: vi.fn(),
    testConnector: vi.fn(),
  };
});

import { listConnectors, deleteConnector } from '@/lib/connectors';

const mockList = vi.mocked(listConnectors);
const mockDelete = vi.mocked(deleteConnector);

const CONNECTOR: ConnectorSummary = {
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive access.',
  usageNote: '',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('ConnectorRegistry — styled delete confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue([CONNECTOR]);
    mockDelete.mockResolvedValue(undefined);
  });

  it('does not use the OS confirm; clicking delete opens a styled dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<ConnectorRegistry />);

    await waitFor(() => {
      expect(screen.getByText('Google Drive')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));

    await waitFor(() => {
      expect(screen.getByText('Delete connector?')).toBeTruthy();
    });
    // The dialog names the connector and never touches window.confirm.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Google Drive')).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('confirm path → calls deleteConnector with the id', async () => {
    render(<ConnectorRegistry />);
    await waitFor(() => {
      expect(screen.getByText('Google Drive')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => {
      expect(screen.getByText('Delete connector?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('gdrive');
    });
  });

  it('cancel path → dialog closes and deleteConnector is NOT called', async () => {
    render(<ConnectorRegistry />);
    await waitFor(() => {
      expect(screen.getByText('Google Drive')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => {
      expect(screen.getByText('Delete connector?')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByText('Delete connector?')).toBeNull();
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
