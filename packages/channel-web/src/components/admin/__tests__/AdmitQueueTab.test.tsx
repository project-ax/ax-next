import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdmitQueueTab } from '../AdmitQueueTab';
import type { CatalogRequest } from '@ax/skills';

vi.mock('@/lib/catalog', () => ({
  listCatalogRequests: vi.fn(),
  decideCatalogRequest: vi.fn(),
}));
// The review dialog (opened by Review) calls getSkillOrNull on mount.
vi.mock('@/lib/skills', () => ({
  getSkillOrNull: vi.fn().mockResolvedValue(null),
}));
import { listCatalogRequests } from '@/lib/catalog';
const mockList = vi.mocked(listCatalogRequests);

const SHARE_REQ: CatalogRequest = {
  requestId: 'r1',
  kind: 'share',
  skillId: 'linear',
  requestedByUserId: 'u-author',
  sourceOwnerUserId: 'u-author',
  status: 'pending',
  description: 'Linear issues.',
  createdAt: '2026-05-26T00:00:00.000Z',
  manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
  bodyMd: '# linear\n',
  files: [],
};

describe('AdmitQueueTab', () => {
  beforeEach(() => vi.resetAllMocks());

  it('lists pending requests with their kind and skill id', async () => {
    mockList.mockResolvedValue([SHARE_REQ]);
    render(<AdmitQueueTab />);
    expect(await screen.findByText('linear')).toBeTruthy();
    expect(screen.getByText(/share/i)).toBeTruthy();
    expect(screen.getByText('Linear issues.')).toBeTruthy();
  });

  it('shows an empty state when there are no requests', async () => {
    mockList.mockResolvedValue([]);
    render(<AdmitQueueTab />);
    await waitFor(() => expect(screen.getByText(/no pending/i)).toBeTruthy());
  });

  it('opens the review dialog for a request', async () => {
    mockList.mockResolvedValue([SHARE_REQ]);
    render(<AdmitQueueTab />);
    fireEvent.click(await screen.findByRole('button', { name: /review linear/i }));
    expect(await screen.findByText(/review share request: linear/i)).toBeTruthy();
  });
});
