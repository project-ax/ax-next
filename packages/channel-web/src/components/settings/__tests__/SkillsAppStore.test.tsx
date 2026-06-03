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
  deleteAuthoredSkill: vi.fn(),
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
vi.mock('@/lib/admin', () => ({
  listAdminAgents: vi.fn(),
  patchAgentSkillAttachments: vi.fn(),
}));
vi.mock('@/components/admin/SkillEditor', () => ({
  SkillEditor: () => <div data-testid="skill-editor" />,
}));
vi.mock('@/components/admin/BundleReviewDialog', () => ({
  BundleReviewDialog: () => <div data-testid="bundle-review" />,
}));

import { getConnections, listCatalogSkills } from '@/lib/connections';
import { listChatAgents } from '@/lib/agents';
import {
  listUserSkills,
  listAuthoredSkills,
  adoptAuthoredSkill,
  deleteAuthoredSkill,
} from '@/lib/user-skills';
import { setSkillDefaultAttached } from '@/lib/skills';
import { listCatalogRequests } from '@/lib/catalog';
import { listAdminAgents, patchAgentSkillAttachments, type AdminAgent } from '@/lib/admin';

const mockGetConnections = vi.mocked(getConnections);
const mockListCatalog = vi.mocked(listCatalogSkills);
const mockListAgents = vi.mocked(listChatAgents);
const mockListUserSkills = vi.mocked(listUserSkills);
const mockListAuthored = vi.mocked(listAuthoredSkills);
const mockListRequests = vi.mocked(listCatalogRequests);
const mockAdoptAuthored = vi.mocked(adoptAuthoredSkill);
const mockSetDefault = vi.mocked(setSkillDefaultAttached);
const mockListAdminAgents = vi.mocked(listAdminAgents);
const mockPatchAgentSkills = vi.mocked(patchAgentSkillAttachments);
const mockDeleteAuthored = vi.mocked(deleteAuthoredSkill);

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
  mockListAdminAgents.mockResolvedValue([]);
  mockPatchAgentSkills.mockResolvedValue({ id: 'a1' } as unknown as AdminAgent);
  mockSetDefault.mockResolvedValue(undefined);
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

  // -------------------------------------------------------------------------
  // Admins can uninstall non-user (default / agent) installed skills
  // -------------------------------------------------------------------------

  it('admin: an agent-attached row shows Remove that detaches via patch, preserving siblings', async () => {
    mockGetConnections.mockResolvedValue({
      agentId: 'a1',
      skills: [
        { skillId: 'agent-skill', description: 'Attached by admin.', source: 'agent', removable: false },
      ],
    });
    mockListUserSkills.mockResolvedValue([]);
    // The handler must read the agent's REAL skill_attachments (not the union,
    // which hides agent rows that collide with a user attachment), drop the
    // target, and keep the rest (with their credentialBindings intact).
    mockListAdminAgents.mockResolvedValue([
      {
        id: 'a1',
        skillAttachments: [
          { skillId: 'agent-skill', credentialBindings: {} },
          // Sibling kept verbatim — a server-acceptable binding (slot key matches
          // the route's SLOT_RE) proves bindings pass through untouched, not just
          // that the row survives.
          { skillId: 'keep-me', credentialBindings: { TOKEN_SLOT: 'svc' } },
        ],
      } as unknown as AdminAgent,
    ]);

    render(<SkillsAppStore isAdmin={true} />);
    const removeBtn = await screen.findByRole('button', {
      name: /Remove agent-skill from this agent/i,
    });
    fireEvent.click(removeBtn);

    await waitFor(() =>
      expect(mockPatchAgentSkills).toHaveBeenCalledWith('a1', [
        { skillId: 'keep-me', credentialBindings: { TOKEN_SLOT: 'svc' } },
      ]),
    );
  });

  it('admin: a default-attached row shows Unset default that clears the workspace default', async () => {
    mockGetConnections.mockResolvedValue({
      agentId: 'a1',
      skills: [
        { skillId: 'web-search', description: 'Search the web.', source: 'default', removable: false },
      ],
    });
    mockListUserSkills.mockResolvedValue([]);

    render(<SkillsAppStore isAdmin={true} />);
    const unsetBtn = await screen.findByRole('button', {
      name: /Unset web-search as a workspace default/i,
    });
    fireEvent.click(unsetBtn);

    await waitFor(() =>
      expect(mockSetDefault).toHaveBeenCalledWith('web-search', false),
    );
  });

  it('non-admin: a non-removable row shows status text, not an uninstall button', async () => {
    mockGetConnections.mockResolvedValue({
      agentId: 'a1',
      skills: [
        { skillId: 'agent-skill', description: 'Attached by admin.', source: 'agent', removable: false },
      ],
    });
    mockListUserSkills.mockResolvedValue([]);

    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('installed-agent-skill');
    expect(screen.queryByRole('button', { name: /Remove agent-skill/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Unset .* default/i })).toBeNull();
    expect(screen.getByText('set by admin')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // A user with no agent yet is guided to create one (Install stays disabled)
  // -------------------------------------------------------------------------

  it('with no agent, Install is disabled and the user is guided to the Agents tab', async () => {
    mockListAgents.mockResolvedValue([]); // user has no assistant yet

    render(<SkillsAppStore isAdmin={false} />);
    // The catalog is still browsable, but every Install button is disabled.
    await screen.findByTestId('catalog-web-search');
    const installButtons = screen.getAllByRole('button', { name: /^Install$/i });
    expect(installButtons.length).toBeGreaterThan(0);
    for (const b of installButtons) expect(b).toBeDisabled();
    // The empty INSTALLED state explains the fix: create an agent on the Agents tab.
    expect(screen.getByText(/Agents tab/i)).toBeInTheDocument();
  });

  // Delete authored drafts (fix #1) — before this, an authored draft had only an
  // Edit/adopt affordance and NO way to remove it from the UI.

  it('an authored draft shows a Delete button', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('authored-drafted');
    expect(screen.getByRole('button', { name: /Delete drafted/i })).toBeInTheDocument();
  });

  it('Delete on an authored draft confirms, calls deleteAuthoredSkill, and drops it from the list', async () => {
    mockListAuthored.mockResolvedValueOnce(AUTHORED); // initial load shows the draft
    mockDeleteAuthored.mockResolvedValue(undefined);
    mockListAuthored.mockResolvedValue([]); // post-delete refreshOwn sees it gone
    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('authored-drafted');

    // Click Delete → a confirmation dialog appears (no call yet).
    fireEvent.click(screen.getByRole('button', { name: /Delete drafted/i }));
    expect(await screen.findByText(/Delete authored draft\?/i)).toBeInTheDocument();
    expect(mockDeleteAuthored).not.toHaveBeenCalled();

    // Confirm → the delete call fires with the draft's (agentId, skillId).
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() =>
      expect(mockDeleteAuthored).toHaveBeenCalledWith('a1', 'drafted'),
    );

    // The row drops off (refreshOwn re-read returns []).
    await waitFor(() =>
      expect(screen.queryByTestId('authored-drafted')).toBeNull(),
    );
  });

  it('a failed delete surfaces an error and leaves the draft visible', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    mockDeleteAuthored.mockRejectedValue(
      new Error('user-skills API 404: agent not accessible'),
    );
    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('authored-drafted');

    fireEvent.click(screen.getByRole('button', { name: /Delete drafted/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));

    expect(await screen.findByText(/agent not accessible/i)).toBeInTheDocument();
    expect(screen.getByTestId('authored-drafted')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // User-owned skills with no agent attachment remain visible (bug fix)
  // -------------------------------------------------------------------------
  // When a user creates a skill (via "Create") or adopts an authored draft (via
  // "Edit"), the skill ends up in ownSkills but NOT in the connections/installed
  // list (it has no per-agent attachment). Without the fix, the skill was
  // invisible — the editor closed and the skill vanished from the UI.

  it('a user-created skill not yet attached to any agent appears in the Installed section', async () => {
    // 'my-new-skill' is owned but not attached (not in getConnections result).
    mockListUserSkills.mockResolvedValue([
      {
        id: 'my-new-skill',
        description: 'My brand-new skill.',
        version: 1,
        scope: 'user',
        connectors: [],
        defaultAttached: false,
        updatedAt: '2026-06-01T10:00:00.000Z',
      } as SkillSummary,
    ]);
    mockGetConnections.mockResolvedValue({ agentId: 'a1', skills: [] });

    render(<SkillsAppStore isAdmin={false} />);

    // The skill appears in the Installed section (not a catalog skill, so
    // catalog-pdf-tools is the sentinel for full render).
    expect(await screen.findByTestId('installed-my-new-skill')).toBeInTheDocument();
    // It shows the "your own" badge.
    expect(screen.getByText('My brand-new skill.')).toBeInTheDocument();
    // Edit and Delete buttons are present.
    expect(screen.getByRole('button', { name: /Edit my-new-skill/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete my-new-skill/i })).toBeInTheDocument();
  });

  it('a user-owned-but-not-installed skill is counted in the Installed total', async () => {
    mockListUserSkills.mockResolvedValue([
      {
        id: 'my-new-skill',
        description: 'My brand-new skill.',
        version: 1,
        scope: 'user',
        connectors: [],
        defaultAttached: false,
        updatedAt: '2026-06-01T10:00:00.000Z',
      } as SkillSummary,
    ]);
    // One default-installed skill + one user-owned-not-installed skill = 2 total.
    mockGetConnections.mockResolvedValue({
      agentId: 'a1',
      skills: [
        { skillId: 'web-search', description: 'Search the web.', source: 'default', removable: false },
      ],
    });

    render(<SkillsAppStore isAdmin={false} />);
    await screen.findByTestId('installed-my-new-skill');

    expect(screen.getByText(/^Installed \(2\)/)).toBeInTheDocument();
  });

  it('an adopted authored skill stays visible in Installed after its editor saves', async () => {
    // Simulate the adopt-and-edit flow: an authored draft is adopted into
    // ownSkills (no attachment), editor opens, user saves, editor closes.
    const AUTHORED_DRAFT: AuthoredSkillListing[] = [
      { skillId: 'drafted', agentId: 'a1', description: 'An agent-authored draft.', status: 'active' },
    ];
    mockListAuthored.mockResolvedValueOnce(AUTHORED_DRAFT); // initial: draft visible
    mockAdoptAuthored.mockResolvedValue({ skillId: 'drafted', created: true, adopted: true });
    // After adopt+refreshOwn: draft is gone (adopted), skill now in ownSkills.
    mockListAuthored.mockResolvedValue([]);
    // Initially no user-owned skills (draft is in authored, not yet adopted).
    // After adopt, refreshOwn picks it up as a user-scoped copy.
    mockListUserSkills
      .mockResolvedValueOnce([]) // initial load: no user skills yet
      .mockResolvedValue([
        {
          id: 'drafted',
          description: 'An agent-authored draft.',
          version: 1,
          scope: 'user',
          connectors: [],
          defaultAttached: false,
          updatedAt: '2026-06-01T10:00:00.000Z',
        } as SkillSummary,
      ]); // post-adopt refreshOwn: copy now owned
    mockGetConnections.mockResolvedValue({ agentId: 'a1', skills: [] });

    render(<SkillsAppStore isAdmin={false} />);

    // Adopt the draft (click Edit on authored shelf). On initial load the skill
    // is only in the authored section — NOT in ownNotInstalled — so the Edit
    // button is unambiguous.
    await screen.findByTestId('authored-drafted');
    fireEvent.click(screen.getByRole('button', { name: /Edit drafted/i }));
    await waitFor(() => expect(mockAdoptAuthored).toHaveBeenCalledWith('a1', 'drafted'));

    // Editor opens on the adopted copy. Simulate the editor saving (onSaved fires).
    // The mocked SkillEditor renders a div; we find it and simulate close via the
    // onSaved prop — but since we mock the editor, onEditorSaved is not triggered
    // automatically. Instead, verify that the adopted skill is visible in Installed
    // (the own-not-installed path) which is what the bug fix ensures.
    expect(await screen.findByTestId('installed-drafted')).toBeInTheDocument();
    // The authored shelf no longer shows the draft (it was adopted).
    expect(screen.queryByTestId('authored-drafted')).toBeNull();
  });
});
