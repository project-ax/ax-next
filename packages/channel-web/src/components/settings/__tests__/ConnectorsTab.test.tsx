import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { ConnectorsTab } from '../ConnectorsTab';
import * as connectorsLib from '@/lib/connectors';
import * as agentsLib from '@/lib/agents';
import * as connLib from '@/lib/connections';
import * as credLib from '@/lib/credentials';
import type { ConnectorSummary, Connector } from '@/lib/connectors';
import {
  headingOutline,
  headingOutlineProblems,
} from '@/test-utils/heading-outline';

const PRIVATE_CONN: ConnectorSummary = {
  id: 'my-notion',
  name: 'My Notion',
  description: 'Personal Notion workspace.',
  usageNote: 'Ask the agent to read or update Notion pages.',
  keyMode: 'personal',
  visibility: 'private',
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

// A SHARED connector (catalog-sourced). keyMode workspace → it needs one shared key.
const SHARED_CONN: ConnectorSummary = {
  id: 'company-salesforce',
  name: 'Salesforce',
  description: 'The company Salesforce org.',
  usageNote: 'Drive the sf CLI for our workflows.',
  keyMode: 'workspace',
  visibility: 'shared',
  createdAt: '2026-05-20T00:00:00Z',
  updatedAt: '2026-05-20T00:00:00Z',
};

/** Build the full connector a `getConnector` mock returns (carries capabilities).
 *  A single api-key slot — the connector owns its own key, keyed by the id, so the
 *  derived presence ref is `account:<connectorId>`. */
function fullOf(summary: ConnectorSummary): Connector {
  return {
    ...summary,
    capabilities: {
      ...connectorsLib.emptyCapabilities(),
      credentials: [{ slot: 'token', kind: 'api-key' }],
    },
  };
}

describe('ConnectorsTab', () => {
  beforeEach(() => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([
      PRIVATE_CONN,
      SHARED_CONN,
    ]);
    // The tab no longer reads a connector's full record or anyone's credential
    // presence (no Ready / Needs a key status, no Connect). These spies stay so
    // a test can assert those reads never happen.
    vi.spyOn(connectorsLib, 'getConnector').mockImplementation(async (id: string) => {
      if (id === PRIVATE_CONN.id) return fullOf(PRIVATE_CONN);
      return fullOf(SHARED_CONN);
    });
    vi.spyOn(credLib.myCredentials, 'list').mockResolvedValue([]);
    vi.spyOn(credLib.adminCredentials, 'list').mockResolvedValue([]);
    // No proposed (pending authored) drafts by default → the Proposed shelf is
    // absent (#310). Tests that exercise the fallback override this.
    vi.spyOn(connectorsLib, 'listAuthoredPending').mockResolvedValue([]);
    // The site lists live on Settings › Sites now; these spies stay so a test
    // can assert this tab never reads them.
    vi.spyOn(agentsLib, 'listChatAgents').mockResolvedValue([]);
    vi.spyOn(connLib, 'listAllAllowedSites').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists the connectors by service name', async () => {
    render(<ConnectorsTab />);
    expect(await screen.findByText('My Notion')).toBeInTheDocument();
    expect(screen.getByText('Salesforce')).toBeInTheDocument();
  });

  // The Settings "Proposed by your assistant" fallback (2026-06-03): a connector
  // the assistant proposed mid-turn lands as a PENDING authored draft. If the
  // in-chat approval card was missed, the user can approve it here.
  const PROPOSED_LINEAR: connectorsLib.PendingAuthoredConnector = {
    connectorId: 'linear',
    agentId: 'agt_1',
    name: 'Linear',
    usageNote: 'Drive the Linear CLI',
    keyMode: 'personal',
    status: 'pending',
    proposal: {
      allowedHosts: ['api.linear.app'],
      credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
      mcpServers: [],
      packages: { npm: ['@schpet/linear-cli'], pypi: [] },
    },
  };

  it('shows a "Proposed by your assistant" shelf when there are pending authored drafts', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending').mockResolvedValue([PROPOSED_LINEAR]);
    render(<ConnectorsTab />);
    expect(await screen.findByText(/Proposed by your assistant/i)).toBeInTheDocument();
    const tile = await screen.findByTestId('proposed-connector-linear');
    expect(within(tile).getByText('Linear')).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('omits the Proposed shelf when there are no pending drafts', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.queryByText(/Proposed by your assistant/i)).not.toBeInTheDocument();
  });

  it('approving a proposed connector writes the key then calls approve, and refreshes', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending')
      .mockResolvedValueOnce([PROPOSED_LINEAR]) // initial load
      .mockResolvedValue([]); // after approval → shelf empties
    const setCred = vi
      .spyOn(credLib, 'setDestinationCredential')
      .mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof credLib.setDestinationCredential>>);
    const approve = vi
      .spyOn(connectorsLib, 'approveAuthoredConnector')
      .mockResolvedValue(undefined);

    render(<ConnectorsTab />);
    const tile = await screen.findByTestId('proposed-connector-linear');
    fireEvent.click(within(tile).getByRole('button', { name: /approve/i }));

    // The approve dialog opens with a key field for the declared slot.
    const keyField = await screen.findByLabelText('Linear API key');
    fireEvent.change(keyField, { target: { value: 'lin_secret_123' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    // The key is written to the user's vault under the connector's account ref —
    // never sent through the approve call.
    expect(setCred).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { kind: 'account', service: 'linear' },
        payload: 'lin_secret_123',
        scope: { scope: 'user', ownerId: null },
      }),
    );
    expect(approve).toHaveBeenCalledWith('linear', {
      agentId: 'agt_1',
      shown: { hosts: ['api.linear.app'], slots: ['LINEAR_API_KEY'], npm: ['@schpet/linear-cli'], pypi: [] },
    });
  });

  it('offers a Dismiss action on a proposed connector', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending').mockResolvedValue([PROPOSED_LINEAR]);
    render(<ConnectorsTab />);
    const tile = await screen.findByTestId('proposed-connector-linear');
    expect(within(tile).getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('dismissing a proposed connector rejects it (no key) and refreshes the shelf', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending')
      .mockResolvedValueOnce([PROPOSED_LINEAR]) // initial load
      .mockResolvedValue([]); // after dismiss → shelf empties
    const setCred = vi
      .spyOn(credLib, 'setDestinationCredential')
      .mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof credLib.setDestinationCredential>>);
    const reject = vi
      .spyOn(connectorsLib, 'rejectAuthoredConnector')
      .mockResolvedValue(undefined);

    render(<ConnectorsTab />);
    const tile = await screen.findByTestId('proposed-connector-linear');
    fireEvent.click(within(tile).getByRole('button', { name: /dismiss/i }));

    // Confirm in the dialog (its own Dismiss button).
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    expect(reject).toHaveBeenCalledWith('linear', { agentId: 'agt_1' });
    // Dismiss never touches the vault — that was the whole bug.
    expect(setCred).not.toHaveBeenCalled();
    // The shelf empties on refresh.
    await waitFor(() =>
      expect(screen.queryByTestId('proposed-connector-linear')).not.toBeInTheDocument(),
    );
  });

  it('keeps the default view mechanism-free (no transport/command/url/args)', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/stdio/i);
    expect(body).not.toMatch(/transport/i);
    expect(body).not.toMatch(/command/i);
    expect(body).not.toMatch(/\bargs\b/i);
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('captions what each connector needs (a key) without naming the mechanism', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    // Slice 2a: a per-person key is added per agent, so the caption says so.
    // The stored keyMode is still 'personal' — only the words changed.
    expect(
      within(screen.getByTestId('connector-tile-my-notion')).getByText(
        'Each agent adds its own key',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('connector-tile-company-salesforce')).getByText(
        'One shared key for everyone',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/personal key/i)).toBeNull();
  });

  it('shows the empty state with no "catalog" language', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockResolvedValue([]);
    render(<ConnectorsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no connectors yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Add one to make it available to the workspace\./),
    ).toBeInTheDocument();
    expect(screen.queryByText('Catalog')).toBeNull();
    expect(screen.queryByText(/catalog/i)).toBeNull();
  });

  it('surfaces a load error in an alert', async () => {
    vi.spyOn(connectorsLib, 'listConnectors').mockRejectedValue(
      new Error('connectors boom'),
    );
    render(<ConnectorsTab />);
    await waitFor(() => {
      expect(screen.getByText('connectors boom')).toBeInTheDocument();
    });
  });

  it('an owner can edit a shared personal definition', async () => {
    vi.mocked(connectorsLib.listConnectors).mockResolvedValue([
      { ...PRIVATE_CONN, visibility: 'shared', canEdit: true },
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    expect(within(tile).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('a definition the server marks read-only shows no Edit or Delete', async () => {
    vi.mocked(connectorsLib.listConnectors).mockResolvedValue([
      { ...SHARED_CONN, canEdit: false },
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    expect(within(tile).queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(within(tile).queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  // --- admin curation (TASK-127; admin-only since slice 2a) ----------------

  it('a connector the server sent without canEdit is editable (any admin may edit a shared one)', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    expect(within(tile).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('reads the list from /admin/connectors, never the /settings/connectors routes', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(connectorsLib.listConnectors).toHaveBeenCalledWith('/admin/connectors');
    expect(connectorsLib.listConnectors).not.toHaveBeenCalledWith('/settings/connectors');
  });

  it('shows admin curation controls (New + per-row Edit/Delete) for an admin', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.getByRole('button', { name: /new connector/i })).toBeInTheDocument();
    const tile = screen.getByTestId('connector-tile-my-notion');
    expect(within(tile).getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(within(tile).getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    // The connector "default" concept is gone: no per-row default toggle.
    expect(within(tile).queryByRole('button', { name: /default/i })).toBeNull();
  });

  it('admin "New connector" opens the create form', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    fireEvent.click(screen.getByRole('button', { name: /new connector/i }));
    expect(await screen.findByLabelText(/^name$/i)).toBeInTheDocument();
  });

  it('admin per-row Edit opens the edit form prefilled', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^edit$/i }));
    const nameInput = await screen.findByLabelText(/service name/i);
    await waitFor(() => expect(nameInput).toHaveValue('My Notion'));
  });

  it('admin Delete opens a styled confirm and deletes on confirm', async () => {
    const del = vi.spyOn(connectorsLib, 'deleteConnector').mockResolvedValue();
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    fireEvent.click(within(tile).getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/delete connector\?/i)).toBeInTheDocument();
    // The dialog's Delete button (the destructive confirm) is the last one.
    const dialogDelete = screen
      .getAllByRole('button', { name: /^delete$/i })
      .at(-1)!;
    fireEvent.click(dialogDelete);
    await waitFor(() =>
      expect(del).toHaveBeenCalledWith('my-notion', '/admin/connectors'),
    );
  });

  // --- one flat list of definitions (no per-viewer status, no connect) -------
  //
  // Signing in / adding keys moved to each agent's Connectors tab, so this tab
  // must not grow a Connect / Update key, a Test probe, a "Ready" / "Needs a
  // key" status that's only true for whoever is looking, or a "Catalog" badge.

  it('renders one list with no Connected / Available shelves', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.getByTestId('connector-tile-my-notion')).toBeInTheDocument();
    expect(screen.getByTestId('connector-tile-company-salesforce')).toBeInTheDocument();
    expect(screen.queryByText(/^Connected \(/)).toBeNull();
    expect(screen.queryByText(/^Available \(/)).toBeNull();
  });

  it('tells people where they sign in', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(
      screen.getByText(/People sign in from each agent’s Connectors tab\./),
    ).toBeInTheDocument();
  });

  it('an admin tile has no Test / Connect / Update key, no status words, no Catalog badge', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    for (const id of ['my-notion', 'company-salesforce']) {
      const tile = screen.getByTestId(`connector-tile-${id}`);
      expect(within(tile).queryByRole('button', { name: /^test$/i })).toBeNull();
      expect(within(tile).queryByRole('button', { name: /^connect$/i })).toBeNull();
      expect(within(tile).queryByRole('button', { name: /update key/i })).toBeNull();
      expect(tile.textContent).not.toMatch(/\bReady\b/);
      expect(tile.textContent).not.toMatch(/Needs a key/);
      expect(tile.textContent).not.toMatch(/Can't reach it|Checking…/);
      expect(tile.textContent).not.toMatch(/Catalog/);
    }
    // A tile's caption still says what it needs.
    expect(
      within(screen.getByTestId('connector-tile-company-salesforce')).getByText(
        'One shared key for everyone',
      ),
    ).toBeInTheDocument();
  });

  it('reads no credential presence and no full connector records', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    // Give any stray follow-up reads a chance to fire.
    await waitFor(() => expect(connectorsLib.listConnectors).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(connectorsLib.getConnector).not.toHaveBeenCalled();
    expect(credLib.myCredentials.list).not.toHaveBeenCalled();
    expect(credLib.adminCredentials.list).not.toHaveBeenCalled();
  });

  it('an editable tile shows exactly Edit and Delete', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    const tile = screen.getByTestId('connector-tile-my-notion');
    expect(
      within(tile)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Edit', 'Delete']);
  });

  it('a tile this person may not edit shows no buttons at all', async () => {
    vi.mocked(connectorsLib.listConnectors).mockResolvedValue([
      { ...SHARED_CONN, canEdit: false },
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('Salesforce');
    const tile = screen.getByTestId('connector-tile-company-salesforce');
    expect(within(tile).queryAllByRole('button')).toEqual([]);
  });

  // Slice 2a: the two site lists moved to their own Settings › Sites page
  // (SitesTab.test.tsx). Connectors is an admin page; the site lists are
  // everyone's, so they must not ride along here.
  it('no longer carries the site lists', async () => {
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');
    expect(screen.queryByText('Allowed sites')).toBeNull();
    expect(screen.queryByText('Sites we read without asking')).toBeNull();
    expect(connLib.listAllAllowedSites).not.toHaveBeenCalled();
  });

  /*
    THE TAB'S HEADING LEVELS (TASK-446).

    A FRAGMENT, so the expected top level is 2, not 1: this body renders inside
    `AdminPane`, under the pane title's `h1` ("Connectors"). It used to open at
    `h3` with `h4` shelves under it, which — with no `h1` above it anywhere in
    the shell — meant the tab's outline began two levels down from a heading
    that did not exist.

    The `h2` is the tab's one top-level section (the two site sections that
    used to follow it moved to Settings › Sites in slice 2a); the `h3` is the
    Proposed shelf inside it. The connector list itself
    is one flat list with no shelf headings (no Connected / Available split). Asserting the exact
    list, not just "no skipped levels", is what stops the levels being fixed by
    deleting a section heading.
  */
  it('opens at h2 and steps down one level to the Proposed shelf', async () => {
    vi.spyOn(connectorsLib, 'listAuthoredPending').mockResolvedValue([
      PROPOSED_LINEAR,
    ]);
    render(<ConnectorsTab />);
    await screen.findByText('My Notion');

    expect(headingOutlineProblems(document.body, 2)).toEqual([]);
    expect(headingOutline()).toEqual([
      'h2: Connectors',
      'h3: Proposed by your assistant (1)',
    ]);
  });
});
