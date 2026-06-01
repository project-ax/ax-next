import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillsAppStore } from '../SkillsAppStore';
import type { ConnectionSkill, CatalogSkillListing } from '@/lib/connections';
import type { SkillSummary, AuthoredSkillListing } from '@ax/skills';

vi.mock('@/lib/connections', () => ({
  getConnections: vi.fn(),
  detachConnectionSkill: vi.fn(),
  attachConnectionSkill: vi.fn(),
  listCatalogSkills: vi.fn(),
}));
vi.mock('@/lib/agents', () => ({ listChatAgents: vi.fn() }));
vi.mock('@/lib/user-skills', () => ({
  listUserSkills: vi.fn(),
  listAuthoredSkills: vi.fn(),
  getUserSkill: vi.fn(),
  createUserSkill: vi.fn(),
  updateUserSkill: vi.fn(),
  deleteUserSkill: vi.fn(),
  shareUserSkill: vi.fn(),
  adoptAuthoredSkill: vi.fn(),
}));
vi.mock('@/lib/skills', () => ({
  setSkillDefaultAttached: vi.fn(),
  deleteSkill: vi.fn(),
  getSkill: vi.fn(),
  upsertSkill: vi.fn(),
  updateSkill: vi.fn(),
}));
vi.mock('@/lib/catalog', () => ({
  listCatalogRequests: vi.fn(),
  decideCatalogRequest: vi.fn(),
}));
vi.mock('@/components/admin/SkillEditor', () => ({
  SkillEditor: () => <div data-testid="skill-editor" />,
}));
vi.mock('@/components/admin/BundleReviewDialog', () => ({
  BundleReviewDialog: () => <div data-testid="bundle-review" />,
}));

import { getConnections, listCatalogSkills } from '@/lib/connections';
import { listChatAgents } from '@/lib/agents';
import { listUserSkills, listAuthoredSkills, adoptAuthoredSkill } from '@/lib/user-skills';
import { listCatalogRequests } from '@/lib/catalog';

const mockGetConnections = vi.mocked(getConnections);
const mockListCatalog = vi.mocked(listCatalogSkills);
const mockListAgents = vi.mocked(listChatAgents);
const mockListUserSkills = vi.mocked(listUserSkills);
const mockListAuthored = vi.mocked(listAuthoredSkills);
const mockListRequests = vi.mocked(listCatalogRequests);
const mockAdoptAuthored = vi.mocked(adoptAuthoredSkill);

const INSTALLED: ConnectionSkill[] = [
  { skillId: 'web-search', description: 'Search the web.', source: 'default', removable: false },
  { skillId: 'my-helper', description: 'My private helper.', source: 'user', removable: true },
];
const CATALOG: CatalogSkillListing[] = [
  { skillId: 'web-search', description: 'Search the web.', defaultAttached: true, connectors: [] },
  { skillId: 'pdf-tools', description: 'Work with PDFs.', defaultAttached: false, connectors: ['pdf'] },
];

beforeEach(() => {
  vi.resetAllMocks();
  mockListAgents.mockResolvedValue([
    { agentId: 'a1', displayName: 'My Agent', visibility: 'personal' },
  ]);
  mockGetConnections.mockResolvedValue({ agentId: 'a1', skills: INSTALLED });
  mockListCatalog.mockResolvedValue(CATALOG);
  mockListUserSkills.mockResolvedValue([
    {
      id: 'my-helper',
      description: 'My private helper.',
      version: 1,
      scope: 'user',
      connectors: [],
      defaultAttached: false,
      updatedAt: '2026-05-20T10:00:00.000Z',
    } as SkillSummary,
  ]);
  mockListAuthored.mockResolvedValue([]);
  mockListRequests.mockResolvedValue([]);
});

describe('SkillsAppStore', () => {
  it('renders INSTALLED with a count and NOT INSTALLED with a count', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    // Wait for both shelves to settle (the catalog row is the last to render).
    expect(await screen.findByTestId('catalog-pdf-tools')).toBeInTheDocument();
    // Two installed skills: web-search (default) + my-helper (user).
    expect(screen.getByText(/^Installed \(2\)/)).toBeInTheDocument();
    // web-search is installed (default) → INSTALLED shows it.
    expect(screen.getByTestId('installed-web-search')).toBeInTheDocument();
    // pdf-tools is NOT installed → it shows on the catalog shelf.
    expect(screen.getByText('Work with PDFs.')).toBeInTheDocument();
    // The not-installed heading reflects the post-exclusion count (1: pdf-tools).
    expect(screen.getByText(/^Not installed .* \(1\)/)).toBeInTheDocument();
  });

  it('excludes installed skills from the NOT INSTALLED shelf', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    // Wait for the installed exclusion to land (the default row renders) before
    // counting Install buttons.
    await screen.findByTestId('catalog-pdf-tools');
    // Only one "Install" button — for pdf-tools — since web-search is installed.
    const installButtons = screen.getAllByRole('button', { name: /^Install$/i });
    expect(installButtons).toHaveLength(1);
    // web-search is NOT on the catalog shelf (it's installed).
    expect(screen.queryByTestId('catalog-web-search')).toBeNull();
  });

  it('a default-installed row shows the 🏢 default marker and no Remove', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    const row = await screen.findByTestId('installed-web-search');
    // The default skill is marked "default" and is not removable.
    expect(row.textContent).toMatch(/default/i);
    expect(screen.queryByRole('button', { name: /Remove web-search/i })).toBeNull();
  });

  it('opens the consent dialog when Install is clicked', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('catalog-pdf-tools');
    fireEvent.click(screen.getByRole('button', { name: /^Install$/i }));
    // The consent dialog titles itself "Install <skillId>".
    expect(await screen.findByText('Install pdf-tools')).toBeInTheDocument();
  });

  it('a non-admin does NOT see admin curation affordances', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('catalog-pdf-tools');
    expect(screen.queryByRole('button', { name: /Add to workspace/i })).toBeNull();
    expect(screen.queryByText(/Awaiting review/i)).toBeNull();
  });

  it('an admin sees "Add to workspace" and the Awaiting review affordance', async () => {
    mockListRequests.mockResolvedValue([
      {
        requestId: 'r1',
        kind: 'share',
        skillId: 'shared-thing',
        requestedByUserId: 'u2',
        sourceOwnerUserId: 'u2',
        status: 'pending',
        description: 'A shared thing.',
        createdAt: '2026-05-20T10:00:00.000Z',
        manifestYaml: 'name: shared-thing\n',
        bodyMd: '# x',
        files: [],
      },
    ]);
    render(<SkillsAppStore isAdmin={true} />);
    await screen.findByTestId('catalog-pdf-tools');
    expect(screen.getByRole('button', { name: /Add to workspace/i })).toBeInTheDocument();
    expect(await screen.findByText(/Awaiting review \(1\)/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Adopt-&-edit authored skills (TASK-134)
  // -------------------------------------------------------------------------

  const AUTHORED: AuthoredSkillListing[] = [
    { skillId: 'drafted', agentId: 'a1', description: 'An agent-authored draft.', status: 'active' },
  ];

  it('an authored draft shows an Edit (adopt-&-edit) button', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    render(<SkillsAppStore isAdmin={false} />);
    const row = await screen.findByTestId('authored-drafted');
    expect(row).toBeInTheDocument();
    expect(screen.getByText('Authored by your agents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit drafted/i })).toBeInTheDocument();
  });

  it('Edit on an authored draft adopts it then opens the editor on the copy', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    mockAdoptAuthored.mockResolvedValue({ skillId: 'drafted', created: true, adopted: true });
    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('authored-drafted');

    fireEvent.click(screen.getByRole('button', { name: /Edit drafted/i }));

    // The adopt call is made with the draft's (agentId, skillId).
    await waitFor(() =>
      expect(mockAdoptAuthored).toHaveBeenCalledWith('a1', 'drafted'),
    );
    // The form-first editor (TASK-133, mocked here) opens on the adopted copy.
    expect(await screen.findByTestId('skill-editor')).toBeInTheDocument();
  });

  it('a failed adopt surfaces an error and does NOT open the editor', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    mockAdoptAuthored.mockRejectedValue(
      new Error('user-skills API 409: not-adoptable'),
    );
    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('authored-drafted');

    fireEvent.click(screen.getByRole('button', { name: /Edit drafted/i }));

    expect(await screen.findByText(/not-adoptable/i)).toBeInTheDocument();
    expect(screen.queryByTestId('skill-editor')).toBeNull();
  });
});
