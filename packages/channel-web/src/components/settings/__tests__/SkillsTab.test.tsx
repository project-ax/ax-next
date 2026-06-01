import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SkillsTab } from '../SkillsTab';
import type { SkillSummary } from '@ax/skills';

vi.mock('@/lib/user-skills', () => ({
  listUserSkills: vi.fn(),
  listAuthoredSkills: vi.fn(),
  getUserSkill: vi.fn(),
  createUserSkill: vi.fn(),
  updateUserSkill: vi.fn(),
  deleteUserSkill: vi.fn(),
  shareUserSkill: vi.fn(),
  approveAuthoredSkill: vi.fn(),
}));
vi.mock('@/lib/credentials', () => ({ setDestinationCredential: vi.fn() }));
vi.mock('@/components/admin/SkillEditor', () => ({
  SkillEditor: () => <div data-testid="skill-editor" />,
}));

import { listUserSkills, listAuthoredSkills } from '@/lib/user-skills';
const mockListUserSkills = vi.mocked(listUserSkills);
const mockListAuthoredSkills = vi.mocked(listAuthoredSkills);

const PRIVATE_SKILL: SkillSummary = {
  id: 'my-helper',
  description: 'My private helper.',
  version: 1,
  scope: 'user',
  connectors: [],
  defaultAttached: false,
  updatedAt: '2026-05-20T10:00:00.000Z',
};

// A catalog (scope:'global') skill → the single "Catalog" source badge.
const CATALOG_SKILL: SkillSummary = {
  id: 'web-search',
  description: 'Search the web.',
  version: 3,
  scope: 'global',
  connectors: [],
  defaultAttached: true,
  updatedAt: '2026-05-20T10:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockListAuthoredSkills.mockResolvedValue([]);
});

describe('SkillsTab', () => {
  it('lists the user skills', async () => {
    mockListUserSkills.mockResolvedValue([PRIVATE_SKILL]);
    render(<SkillsTab />);
    expect(await screen.findByText('my-helper')).toBeInTheDocument();
    expect(screen.getByText('My private helper.')).toBeInTheDocument();
  });

  it('shows the single "Catalog" badge on a catalog skill, none on a private skill', async () => {
    mockListUserSkills.mockResolvedValue([PRIVATE_SKILL, CATALOG_SKILL]);
    render(<SkillsTab />);
    await screen.findByText('web-search');

    const catalogRow = screen.getByText('web-search').closest('tr')!;
    expect(catalogRow.textContent).toMatch(/Catalog/);

    const privateRow = screen.getByText('my-helper').closest('tr')!;
    expect(privateRow.textContent).not.toMatch(/Catalog/);
  });

  it('a solo user with only private skills sees NO catalog badge or language', async () => {
    mockListUserSkills.mockResolvedValue([PRIVATE_SKILL]);
    render(<SkillsTab />);
    await screen.findByText('my-helper');
    expect(screen.queryByText('Catalog')).toBeNull();
  });

  it('shows the empty state with no "catalog" language', async () => {
    mockListUserSkills.mockResolvedValue([]);
    render(<SkillsTab />);
    await waitFor(() => {
      expect(screen.getByText(/No skills/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/catalog/i)).toBeNull();
  });
});
