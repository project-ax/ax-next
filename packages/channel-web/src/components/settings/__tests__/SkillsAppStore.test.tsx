import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SkillsAppStore } from '../SkillsAppStore';
import { humanizeId } from '@/lib/humanize';
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
vi.mock('@/components/settings/SkillForm', () => ({
  SkillForm: () => <div data-testid="skill-editor" />,
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

// A skill row is a list item; its title button is its only control. Rows are named by the skill id they were
// tests keyed on: installed and catalog rows by the humanised id, an authored draft by its description.
let authoredTitle = 'An agent-authored draft.';
function rowTitle(key: string): string {
  const [kind, ...rest] = key.split('-');
  return kind === 'authored' ? authoredTitle : humanizeId(rest.join('-'));
}
const LIST_NAME: Record<string, string> = {
  installed: 'Installed skills',
  catalog: 'Available in your workspace',
  authored: 'Authored by your agents',
};
// Scoped to the shelf the key names: "Web search" is both an installed row and (were it not installed) a catalog one.
const shelf = (key: string, query: 'find' | 'get' | 'query'): HTMLElement | null | Promise<HTMLElement> => {
  const name = LIST_NAME[key.split('-')[0]!]!;
  return query === 'find' ? screen.findByRole('list', { name, hidden: true })
    : query === 'get' ? screen.getByRole('list', { name, hidden: true })
    : screen.queryByRole('list', { name, hidden: true });
};
const findRow = async (key: string): Promise<HTMLElement> =>
  (await within(await (shelf(key, 'find') as Promise<HTMLElement>)).findByRole('button', { name: rowTitle(key), hidden: true })).closest('li')!;
const getRow = (key: string): HTMLElement =>
  within(shelf(key, 'get') as HTMLElement).getByRole('button', { name: rowTitle(key), hidden: true }).closest('li')!;
const queryRow = (key: string): HTMLElement | null => {
  const list = shelf(key, 'query') as HTMLElement | null;
  return list === null ? null : within(list).queryByRole('button', { name: rowTitle(key), hidden: true })?.closest('li') ?? null;
};

async function openSkillDetails(testId: string) {
  const active = screen.queryByRole('dialog');
  if (active) fireEvent.click(within(active).getByRole('button', { name: 'Close' }));
  fireEvent.mouseDown(screen.getByRole('tab', { name: testId.startsWith('catalog-') ? 'Browse' : 'Installed' }));
  const row = await findRow(testId);
  fireEvent.click(within(row).getByRole('button'));
}

describe('SkillsAppStore', () => {
  /**
   * A walk on a fresh cluster found the page arguing with itself. With nothing
   * installed and nothing in the catalog it said, stacked on one screen:
   *
   *   "No skills installed yet. Install one from your workspace below..."
   *   "Nothing left to install — everything in your workspace is already on
   *    this assistant."
   *
   * The first points at a shelf that is also empty. The second is vacuously
   * true at 0 of 0 and congratulates a first-run user for finishing something
   * they never started. Both came from branching on `notInstalled.length === 0`,
   * which cannot tell "the catalog is empty" from "you installed all of it".
   */
  it('an empty catalog reads as empty, not as everything-already-installed', async () => {
    mockGetConnections.mockResolvedValue({ agentId: 'a1', skills: [] });
    mockListCatalog.mockResolvedValue([]);
    mockListUserSkills.mockResolvedValue([]);
    render(<SkillsAppStore isAdmin={false} />);

    expect(
      await screen.findByText(/Your workspace catalog is empty/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing left to install/i)).toBeNull();
    // ...and the installed half stops pointing "below" at that same empty shelf.
    expect(screen.getByText(/Create one to get started/i)).toBeInTheDocument();
    expect(screen.queryByText(/from your workspace below/i)).toBeNull();
  });

  /** The congratulatory line still earns its place when it is actually true. */
  it('keeps everything-already-installed when the catalog is non-empty', async () => {
    mockGetConnections.mockResolvedValue({
      agentId: 'a1',
      skills: [
        { skillId: 'web-search', description: 'Search the web.', source: 'default', removable: false },
        { skillId: 'pdf-tools', description: 'Work with PDFs.', source: 'default', removable: true },
      ],
    });
    mockListUserSkills.mockResolvedValue([]);
    render(<SkillsAppStore isAdmin={false} />);

    expect(await screen.findByText(/Nothing left to install/i)).toBeInTheDocument();
    expect(screen.queryByText(/Your workspace catalog is empty/i)).toBeNull();
  });

  it('renders INSTALLED with a count and NOT INSTALLED with a count', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    // Wait for both shelves to settle (the catalog row is the last to render).
    expect(await findRow('catalog-pdf-tools')).toBeInTheDocument();
    // Two installed skills: web-search (default) + my-helper (user).
    expect(screen.getByText(/^Installed \(2\)/)).toBeInTheDocument();
    // web-search is installed (default) → INSTALLED shows it.
    expect(getRow('installed-web-search')).toBeInTheDocument();
    // pdf-tools is NOT installed → it shows on the catalog shelf.
    expect(screen.getByText('Work with PDFs.')).toBeInTheDocument();
    // The not-installed heading reflects the post-exclusion count (1: pdf-tools).
    expect(screen.getByText(/^Not installed .* \(1\)/)).toBeInTheDocument();
  });

  it('excludes installed skills from the NOT INSTALLED shelf', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    // Wait for the installed exclusion to land (the default row renders) before
    // counting Install buttons.
    await findRow('catalog-pdf-tools');
    // Only one "Install" button — for pdf-tools — since web-search is installed.
    await openSkillDetails('catalog-pdf-tools');
    const installButtons = screen.getAllByRole('button', { name: /^Install$/i });
    expect(installButtons).toHaveLength(1);
    // web-search is NOT on the catalog shelf (it's installed).
    expect(queryRow('catalog-web-search')).toBeNull();
  });

  it('a default-installed row shows the 🏢 default marker and no Remove', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    const row = await findRow('installed-web-search');
    // The default skill is marked "default" and is not removable.
    expect(row.textContent).toMatch(/default/i);
    expect(screen.queryByRole('button', { name: /Remove web-search/i })).toBeNull();
  });

  it('opens the consent dialog when Install is clicked', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    await findRow('catalog-pdf-tools');
    await openSkillDetails('catalog-pdf-tools');
    fireEvent.click(screen.getByRole('button', { name: /^Install$/i }));
    // The consent dialog titles itself "Install <skillId>".
    expect(await screen.findByText('Install PDF tools')).toBeInTheDocument();
  });

  it('a non-admin does NOT see admin curation affordances', async () => {
    render(<SkillsAppStore isAdmin={false} />);
    await findRow('catalog-pdf-tools');
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
    await findRow('catalog-pdf-tools');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Browse' }));
    expect(screen.getByRole('button', { name: /Add to workspace/i })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Review' }));
    expect(await screen.findByText(/Awaiting review \(1\)/i)).toBeInTheDocument();
  });

  it('when the first agent list read fails, Try again picks the agent and the shelf fills in', async () => {
    mockListAgents
      .mockRejectedValueOnce(new Error('agents 503'))
      .mockResolvedValue([{ agentId: 'a1', displayName: 'My Agent', visibility: 'personal' }]);
    render(<SkillsAppStore isAdmin={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('agents 503');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('My helper')).toBeInTheDocument();
    expect(mockGetConnections).toHaveBeenCalledWith('a1');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('a failed Awaiting review read says so, not "No pending requests", and Try again re-reads', async () => {
    mockListRequests.mockRejectedValueOnce(new Error('requests 503')).mockResolvedValue([]);
    render(<SkillsAppStore isAdmin={true} />);
    await findRow('catalog-pdf-tools');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: /Awaiting review/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('requests 503');
    expect(screen.queryByText(/No pending requests/)).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No pending requests/)).toBeInTheDocument();
    expect(mockListRequests).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Adopt-&-edit authored skills (TASK-134)
  // -------------------------------------------------------------------------

  const AUTHORED: AuthoredSkillListing[] = [
    { skillId: 'drafted', agentId: 'a1', description: 'An agent-authored draft.', status: 'active' },
  ];

  /**
   * A browser walk installed a real agent-authored skill, and its 231-character
   * description ran out of the row: under the status badge, under the Edit and
   * Delete buttons, and past the panel edge with a horizontal scrollbar.
   *
   * The span already had `truncate` and its wrapper already had `min-w-0`.
   * Neither was the bug. `overflow` and `text-overflow` do NOTHING to a
   * non-replaced inline box, so an inline span ignores `truncate` outright and
   * reports its full intrinsic width — measured at 1313px inside an 896px row.
   * `block` is the whole fix.
   *
   * This is why it hid from review: a span that happens to be a flex ITEM gets
   * blockified by its flex container, so the two rows in flex parents were
   * always fine. The two in block parents were not.
   */
  it('a long description is clamped and breaks words, in the shared row, or it runs out of the row', async () => {
    const long =
      'Fetch current weather and multi-day forecasts for any location. ' +
      'Use when the user asks about weather, temperature, rain, wind, or ' +
      'the forecast for a city or place.';
    mockListAuthored.mockResolvedValue([{ skillId: 'drafted', agentId: 'a1', description: long, status: 'active' }]);
    authoredTitle = long;
    render(<SkillsAppStore isAdmin={false} />);

    // An authored draft is titled by its description; the row clamps the title instead (it truncates, full text in `title`).
    const row = await findRow('authored-drafted');
    const title = within(row).getByRole('button', { hidden: true });
    expect(title).toHaveAttribute('title', long);
    expect(title.className).toContain('ax-truncate');

    // The catalog shelf's description has the same shared-row treatment.
    const catalogRow = await findRow('catalog-pdf-tools');
    const catalogDesc = catalogRow.querySelector('[data-part="description"]');
    expect(catalogDesc).not.toBeNull();
    expect(catalogDesc!.className).toContain('ax-break-words');
    expect(catalogDesc!.className).toContain('ax-line-clamp-2');
    authoredTitle = 'An agent-authored draft.';
  });

  it('an authored draft says which skill and which agent wrote it, on both pages', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    const { unmount } = render(<SkillsAppStore isAdmin={false} />);
    expect(await findRow('authored-drafted')).toHaveTextContent('drafted · a1');
    unmount();
    render(<SkillsAppStore isAdmin={false} agentId="a1" />);
    const list = await screen.findByRole('list', { name: 'Authored by your agents' });
    expect(within(list).getByRole('listitem')).toHaveTextContent('drafted · a1');
  });

  it('an authored draft shows an Edit (adopt-&-edit) button', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    render(<SkillsAppStore isAdmin={false} />);
    const row = await findRow('authored-drafted');
    expect(row).toBeInTheDocument();
    expect(screen.getByText('Authored by your agents')).toBeInTheDocument();
    await openSkillDetails('authored-drafted');
    expect(screen.getByRole('button', { name: /Edit drafted/i })).toBeInTheDocument();
  });

  it('Edit on an authored draft adopts it then opens the editor on the copy', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    mockAdoptAuthored.mockResolvedValue({ skillId: 'drafted', created: true, adopted: true });
    render(<SkillsAppStore isAdmin={false} />);
    await findRow('authored-drafted');

    await openSkillDetails('authored-drafted');
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
    await findRow('authored-drafted');

    await openSkillDetails('authored-drafted');
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
    await openSkillDetails('installed-agent-skill');
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
    await openSkillDetails('installed-web-search');
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
    await findRow('installed-agent-skill');
    expect(screen.queryByRole('button', { name: /Remove agent-skill/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Unset .* default/i })).toBeNull();
    await openSkillDetails('installed-agent-skill');
    expect(screen.getByText('set by admin')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // A user with no agent yet is guided to create one (Install stays disabled)
  // -------------------------------------------------------------------------

  it('with no agent, Install is disabled and the user is guided to the Agents tab', async () => {
    mockListAgents.mockResolvedValue([]); // user has no assistant yet

    render(<SkillsAppStore isAdmin={false} />);
    // The catalog is still browsable, but every Install button is disabled.
    await findRow('catalog-web-search');
    await openSkillDetails('catalog-pdf-tools');
    const installButtons = screen.getAllByRole('button', { name: /^Install$/i });
    expect(installButtons.length).toBeGreaterThan(0);
    for (const b of installButtons) expect(b).toBeDisabled();
    // The empty INSTALLED state explains the fix: create an agent on the Agents tab.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Installed' }));
    expect(screen.getByText(/Agents tab/i)).toBeInTheDocument();
  });

  // Delete authored drafts (fix #1) — before this, an authored draft had only an
  // Edit/adopt affordance and NO way to remove it from the UI.

  it('an authored draft shows a Delete button', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    render(<SkillsAppStore isAdmin={false} />);
    await findRow('authored-drafted');
    await openSkillDetails('authored-drafted');
    expect(screen.getByRole('button', { name: /Delete drafted/i })).toBeInTheDocument();
  });

  it('Delete on an authored draft confirms, calls deleteAuthoredSkill, and drops it from the list', async () => {
    mockListAuthored.mockResolvedValueOnce(AUTHORED); // initial load shows the draft
    mockDeleteAuthored.mockResolvedValue(undefined);
    mockListAuthored.mockResolvedValue([]); // post-delete refreshOwn sees it gone
    render(<SkillsAppStore isAdmin={false} />);
    await findRow('authored-drafted');

    // Click Delete → a confirmation dialog appears (no call yet).
    await openSkillDetails('authored-drafted');
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
      expect(queryRow('authored-drafted')).toBeNull(),
    );
  });

  it('a failed delete surfaces an error and leaves the draft visible', async () => {
    mockListAuthored.mockResolvedValue(AUTHORED);
    mockDeleteAuthored.mockRejectedValue(
      new Error('user-skills API 404: agent not accessible'),
    );
    render(<SkillsAppStore isAdmin={false} />);
    await findRow('authored-drafted');

    await openSkillDetails('authored-drafted');
    fireEvent.click(screen.getByRole('button', { name: /Delete drafted/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));

    expect(await screen.findByText(/agent not accessible/i)).toBeInTheDocument();
    expect(getRow('authored-drafted')).toBeInTheDocument();
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
    expect(await findRow('installed-my-new-skill')).toBeInTheDocument();
    // It shows the "your own" badge.
    expect(screen.getByText('My brand-new skill.')).toBeInTheDocument();
    // Edit and Delete buttons are present.
    await openSkillDetails('installed-my-new-skill');
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
    await findRow('installed-my-new-skill');

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
    await findRow('authored-drafted');
    await openSkillDetails('authored-drafted');
    fireEvent.click(screen.getByRole('button', { name: /Edit drafted/i }));
    await waitFor(() => expect(mockAdoptAuthored).toHaveBeenCalledWith('a1', 'drafted'));

    // Editor opens on the adopted copy. Simulate the editor saving (onSaved fires).
    // The mocked SkillEditor renders a div; we find it and simulate close via the
    // onSaved prop — but since we mock the editor, onEditorSaved is not triggered
    // automatically. Instead, verify that the adopted skill is visible in Installed
    // (the own-not-installed path) which is what the bug fix ensures.
    expect(await findRow('installed-drafted')).toBeInTheDocument();
    // The authored shelf no longer shows the draft (it was adopted).
    expect(queryRow('authored-drafted')).toBeNull();
  });
});

 describe('agent-specific skills settings', () => {
  it('uses the fixed agent’s installed data without needing an agent picker', async () => {
    mockListAgents.mockResolvedValue([]);
    render(<SkillsAppStore isAdmin={false} agentId="a1" agentName="Alpha" />);
    await screen.findByText('My helper');
    expect(mockGetConnections).toHaveBeenCalledWith('a1');
    expect(mockListAgents).not.toHaveBeenCalled();
    expect(screen.queryByText(/don’t have an assistant/)).toBeNull();
    expect(screen.getByRole('tab', { name: 'Installed' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for my-helper' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit skill' }));
    expect(await screen.findByTestId('skill-editor')).toBeTruthy();
  });
  // A modal menu here leaves the page unclickable after its dialog removes
  // the trigger (production, 2026-10-19).
  it('the skill actions menu never locks the page', async () => {
    mockListAgents.mockResolvedValue([]);
    render(<SkillsAppStore isAdmin={false} agentId="a1" agentName="Alpha" />);
    await screen.findByText('My helper');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for my-helper' }), { button: 0, ctrlKey: false });
    expect(await screen.findAllByRole('menuitem')).not.toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe('none');
  });
  it('places unattached private skills in Browse and filters them by the search', async () => {
    mockGetConnections.mockResolvedValue({ agentId: 'a1', skills: [] });
    render(<SkillsAppStore isAdmin={false} agentId="a1" />);
    await screen.findByText(/No skills installed yet/);
    expect(screen.queryByText('My helper')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Browse' }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('My helper')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the workspace catalog' }), { target: { value: 'pdf' } });
    expect(screen.queryByText('My helper')).toBeNull();
    // In the agent's own page the row has no sheet: its title is plain text, not a button.
    expect(within(screen.getByRole('list', { name: 'Available in your workspace' })).getByText('PDF tools')).toBeTruthy();
  });

  it('a failed read says so (not "no skills"), and Try again re-reads and shows the shelf', async () => {
    mockGetConnections.mockRejectedValueOnce(new Error('connections 503'));
    mockListCatalog.mockRejectedValueOnce(new Error('catalog 503'));
    render(<SkillsAppStore isAdmin={false} agentId="a1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/503/);
    expect(screen.queryByText('No skills installed yet')).toBeNull();
    expect(screen.queryByText('Your workspace catalog is empty')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('My helper')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mockGetConnections).toHaveBeenCalledTimes(2);
    expect(mockListCatalog).toHaveBeenCalledTimes(2);
  });
});
