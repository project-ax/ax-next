/**
 * "Who can use <agent>?" (TASK-1247): the settings section, the picker dialog
 * and Same people as. Acceptance tests: each drives the section the way a
 * person would, from Change to the saved request.
 *
 * Widening asks first, with the confirmation that names the agent's
 * connections; narrowing doesn't ask, but says people may still remember.
 * Words come from SHARING_COPY; tests never repeat a sentence.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharingView } from '@ax/agents';
import { getAdminAgent, listAdminAgents, type AdminAgent } from '@/lib/admin';
import { searchPeople, setAudience, SharingRequestError } from '@/lib/agent-sharing-api';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import type { AgentConnectorRow, AgentConnectorsRead } from '@/lib/workspace-types';
import { SHARING_COPY } from '@/lib/sharing-copy';
import { AgentSharing } from '../AgentSharing';

vi.mock('@/lib/admin', async (original) => ({
  ...(await original<typeof import('@/lib/admin')>()),
  getAdminAgent: vi.fn(),
  listAdminAgents: vi.fn(),
}));
vi.mock('@/lib/agent-sharing-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-sharing-api')>()),
  setAudience: vi.fn(),
  searchPeople: vi.fn(),
}));
vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { connectors: vi.fn() } };
});

const getAgentMock = vi.mocked(getAdminAgent);
const listAgentsMock = vi.mocked(listAdminAgents);
const setAudienceMock = vi.mocked(setAudience);
const searchMock = vi.mocked(searchPeople);
const connectorsMock = vi.mocked(workspaceApi.connectors);

const FERN = 'Fern';
const fern: WorkspaceAgent = {
  id: 'agt_fern',
  name: FERN,
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const VINAY = { id: 'vinay', displayName: 'Vinay', creator: true };
const BOB = { id: 'bob', displayName: 'Bob', creator: false };
const CAROL = { type: 'user' as const, id: 'carol', displayName: 'Carol' };
const DAVE = { type: 'user' as const, id: 'dave', displayName: 'Dave' };

const GMAIL: AgentConnectorRow = {
  id: 'gmail',
  name: 'Gmail',
  source: 'attached',
  editable: false,
  health: 'ok',
  removable: true,
  signedIn: { account: 'vinay@example.com', byName: 'Vinay', byYou: true, at: null },
};
const CALENDAR: AgentConnectorRow = {
  id: 'gcal',
  name: 'Google Calendar',
  source: 'attached',
  editable: false,
  health: 'needs-sign-in',
  setup: 'sign-in',
  removable: true,
};

function connections(rows: AgentConnectorRow[]): AgentConnectorsRead {
  return {
    connectors: rows,
    shared: false,
    manageable: true,
    sharedCredentials: false,
    connectorsSupported: true,
  };
}

function adminAgent(over: Partial<AdminAgent> = {}): AdminAgent {
  return {
    id: 'agt_fern',
    ownerId: 'vinay',
    ownerType: 'user',
    visibility: 'personal',
    displayName: FERN,
    allowedTools: [],
    mcpConfigIds: [],
    model: 'x/y',
    skillAttachments: [],
    connectorAttachments: [],
    shared: false,
    isOwner: true,
    sharing: { audience: { kind: 'just-me' }, owners: [VINAY] },
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

/** The agent as the server answers someone it doesn't show the sharing to. */
function withoutSharing(over: Partial<AdminAgent>): AdminAgent {
  const { sharing: _hidden, ...rest } = adminAgent(over);
  return rest;
}

const JUNIPER = adminAgent({
  id: 'agt_juniper',
  displayName: 'Juniper',
  shared: true,
  sharing: { audience: { kind: 'list', members: [CAROL, DAVE] }, owners: [VINAY] },
});

/** Fern's sharing as the server answers it; `setAudience` echoes what it was sent. */
function serve(sharing: SharingView, others: AdminAgent[] = []) {
  getAgentMock.mockImplementation(async (id) => {
    if (id === 'agt_fern') return adminAgent({ sharing });
    const other = others.find((a) => a.id === id);
    if (other === undefined) throw new Error(`read agent: 404`);
    return other;
  });
  listAgentsMock.mockResolvedValue([adminAgent({ sharing }), ...others]);
  setAudienceMock.mockImplementation(async (_id, audience) => {
    const people = [VINAY, BOB, CAROL, DAVE];
    return {
      owners: sharing.owners,
      audience:
        audience.kind === 'list'
          ? {
              kind: 'list',
              members: audience.members.map((m) => ({
                type: 'user' as const,
                id: m.id,
                displayName: people.find((p) => p.id === m.id)?.displayName ?? null,
              })),
            }
          : audience,
    };
  });
}

function renderSection() {
  const onSection = vi.fn();
  render(<AgentSharing agent={fern} onSection={onSection} />);
  return { onSection };
}

async function openChange(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: SHARING_COPY.change }));
  return screen.findByRole('dialog', { name: SHARING_COPY.picker.title(FERN) });
}

function pickFixed(dialog: HTMLElement, label: string) {
  fireEvent.click(within(dialog).getByRole('combobox', { name: SHARING_COPY.picker.fieldLabel }));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${label}`, 'u') }));
}

async function pickPerson(dialog: HTMLElement, query: string, name: string) {
  fireEvent.click(within(dialog).getByRole('combobox', { name: SHARING_COPY.picker.fieldLabel }));
  fireEvent.change(screen.getByPlaceholderText(SHARING_COPY.picker.placeholder), {
    target: { value: query },
  });
  fireEvent.click(await screen.findByRole('option', { name }));
}

const save = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));

const confirmDialog = (who: 'everyone' | string[]) =>
  screen.findByRole('dialog', { name: SHARING_COPY.confirm.title(FERN, who) });

beforeEach(() => {
  vi.clearAllMocks();
  connectorsMock.mockResolvedValue(connections([]));
  searchMock.mockResolvedValue([]);
});

describe('AgentSharing — widening asks first', () => {
  it('widen to Everyone with connections: the confirmation names Gmail and Google Calendar, and Share saves { kind: everyone }', async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY] });
    connectorsMock.mockResolvedValue(connections([GMAIL, CALENDAR]));
    renderSection();
    expect(await screen.findByText(SHARING_COPY.audience.justMe(1))).toBeTruthy();

    const dialog = await openChange();
    pickFixed(dialog, SHARING_COPY.picker.everyoneOption);
    save(dialog);

    const confirm = await confirmDialog('everyone');
    expect(await within(confirm).findByText('Gmail')).toBeTruthy();
    expect(within(confirm).getByText('Google Calendar')).toBeTruthy();
    expect(setAudienceMock).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: SHARING_COPY.confirm.share }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setAudienceMock).toHaveBeenCalledTimes(1);
    expect(setAudienceMock).toHaveBeenCalledWith('agt_fern', { kind: 'everyone' });
    expect(screen.getByText(SHARING_COPY.audience.everyone)).toBeTruthy();
  });

  it('widen without connections: no connections line or Remove connections first, and Share saves', async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY] });
    renderSection();
    const dialog = await openChange();
    pickFixed(dialog, SHARING_COPY.picker.everyoneOption);
    save(dialog);

    const confirm = await confirmDialog('everyone');
    const share = within(confirm).getByRole('button', { name: SHARING_COPY.confirm.share });
    await waitFor(() => expect(share).toBeEnabled());
    expect(
      within(confirm).queryByRole('button', { name: SHARING_COPY.confirm.removeConnectionsFirst }),
    ).toBeNull();

    fireEvent.click(share);
    await waitFor(() => expect(setAudienceMock).toHaveBeenCalledWith('agt_fern', { kind: 'everyone' }));
  });

  it('Remove connections first saves nothing and opens Connectors', async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY] });
    connectorsMock.mockResolvedValue(connections([GMAIL]));
    const { onSection } = renderSection();
    const dialog = await openChange();
    pickFixed(dialog, SHARING_COPY.picker.everyoneOption);
    save(dialog);

    const confirm = await confirmDialog('everyone');
    fireEvent.click(
      await within(confirm).findByRole('button', { name: SHARING_COPY.confirm.removeConnectionsFirst }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setAudienceMock).not.toHaveBeenCalled();
    expect(onSection).toHaveBeenCalledWith('connectors');
  });

  it('adding a person to a list asks first and names only the new person', async () => {
    serve({ audience: { kind: 'list', members: [CAROL] }, owners: [VINAY] });
    searchMock.mockResolvedValue([{ id: 'dave', displayName: 'Dave' }]);
    renderSection();
    const dialog = await openChange();
    expect(within(dialog).getByText('Carol')).toBeTruthy();

    await pickPerson(dialog, 'Da', 'Dave');
    expect(within(dialog).getByText('Dave')).toBeTruthy();
    save(dialog);

    const confirm = await confirmDialog(['Dave']);
    const share = within(confirm).getByRole('button', { name: SHARING_COPY.confirm.share });
    await waitFor(() => expect(share).toBeEnabled());
    fireEvent.click(share);

    await waitFor(() =>
      expect(setAudienceMock).toHaveBeenCalledWith('agt_fern', {
        kind: 'list',
        members: [
          { type: 'user', id: 'carol' },
          { type: 'user', id: 'dave' },
        ],
      }),
    );
  });

  it("cancelling the confirmation returns to the picker with the draft intact", async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY] });
    renderSection();
    const dialog = await openChange();
    pickFixed(dialog, SHARING_COPY.picker.everyoneOption);
    save(dialog);

    const confirm = await confirmDialog('everyone');
    fireEvent.click(within(confirm).getByRole('button', { name: SHARING_COPY.confirm.cancel }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: SHARING_COPY.confirm.title(FERN, 'everyone') })).toBeNull(),
    );
    const picker = screen.getByRole('dialog', { name: SHARING_COPY.picker.title(FERN) });
    expect(
      within(picker).getByRole('button', { name: SHARING_COPY.picker.remove(SHARING_COPY.audience.everyone) }),
    ).toBeTruthy();
    expect(setAudienceMock).not.toHaveBeenCalled();
  });
});

describe('AgentSharing — narrowing saves without asking', () => {
  it('narrow from Everyone to Just me: no confirmation, the narrowed line shows, and it saves { kind: just-me }', async () => {
    serve({ audience: { kind: 'everyone' }, owners: [VINAY] });
    renderSection();
    const dialog = await openChange();
    expect(within(dialog).queryByText(SHARING_COPY.picker.narrowed(FERN))).toBeNull();

    pickFixed(dialog, SHARING_COPY.audience.justMe(1));
    expect(within(dialog).getByText(SHARING_COPY.picker.narrowed(FERN))).toBeTruthy();
    expect(within(dialog).getByText(SHARING_COPY.picker.emptyDraft(FERN))).toBeTruthy();
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setAudienceMock).toHaveBeenCalledWith('agt_fern', { kind: 'just-me' });
    expect(connectorsMock).not.toHaveBeenCalled();
    expect(screen.getByText(SHARING_COPY.audience.justMe(1))).toBeTruthy();
  });

  it('narrow a list by removing a person saves the smaller list without asking', async () => {
    serve({ audience: { kind: 'list', members: [CAROL, DAVE] }, owners: [VINAY] });
    renderSection();
    const dialog = await openChange();
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.remove('Carol') }));
    expect(within(dialog).getByText(SHARING_COPY.picker.narrowed(FERN))).toBeTruthy();
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setAudienceMock).toHaveBeenCalledWith('agt_fern', {
      kind: 'list',
      members: [{ type: 'user', id: 'dave' }],
    });
    expect(connectorsMock).not.toHaveBeenCalled();
  });

  it('Save is off until the draft differs from what is saved', async () => {
    serve({ audience: { kind: 'everyone' }, owners: [VINAY] });
    renderSection();
    const dialog = await openChange();
    const button = within(dialog).getByRole('button', { name: SHARING_COPY.picker.save });
    expect(button).toBeDisabled();
    pickFixed(dialog, SHARING_COPY.audience.justMe(1));
    expect(button).toBeEnabled();
    pickFixed(dialog, SHARING_COPY.picker.everyoneOption);
    expect(button).toBeDisabled();
  });

  it('a refused save keeps the dialog open with the owners-only message', async () => {
    serve({ audience: { kind: 'everyone' }, owners: [VINAY] });
    setAudienceMock.mockRejectedValue(new SharingRequestError('/admin/agents/agt_fern/audience', 403, 'forbidden'));
    renderSection();
    const dialog = await openChange();
    pickFixed(dialog, SHARING_COPY.audience.justMe(1));
    save(dialog);

    expect(await within(dialog).findByText(SHARING_COPY.errors.forbidden(FERN))).toBeTruthy();
    expect(screen.getByRole('dialog', { name: SHARING_COPY.picker.title(FERN) })).toBeTruthy();
    // The section still says what's saved.
    expect(screen.getAllByText(SHARING_COPY.audience.everyone).length).toBeGreaterThan(0);
  });
});

describe('AgentSharing — Same people as…', () => {
  async function chooseSameAs(dialog: HTMLElement, agent: string) {
    const trigger = await within(dialog).findByRole('button', { name: SHARING_COPY.picker.sameAs });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: agent }));
  }

  it("copies another agent's list, then Save confirms and saves those members", async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY] }, [JUNIPER]);
    renderSection();
    const dialog = await openChange();
    await chooseSameAs(dialog, 'Juniper');

    expect(await within(dialog).findByText('Carol')).toBeTruthy();
    expect(within(dialog).getByText('Dave')).toBeTruthy();
    save(dialog);

    const confirm = await confirmDialog(['Carol', 'Dave']);
    const share = within(confirm).getByRole('button', { name: SHARING_COPY.confirm.share });
    await waitFor(() => expect(share).toBeEnabled());
    fireEvent.click(share);

    await waitFor(() =>
      expect(setAudienceMock).toHaveBeenCalledWith('agt_fern', {
        kind: 'list',
        members: [
          { type: 'user', id: 'carol' },
          { type: 'user', id: 'dave' },
        ],
      }),
    );
  });

  it("leaves out this agent's owners", async () => {
    const juniper = adminAgent({
      id: 'agt_juniper',
      displayName: 'Juniper',
      shared: true,
      sharing: {
        audience: { kind: 'list', members: [{ type: 'user', id: 'bob', displayName: 'Bob' }, CAROL] },
        owners: [VINAY],
      },
    });
    serve({ audience: { kind: 'just-me' }, owners: [VINAY, BOB] }, [juniper]);
    renderSection();
    const dialog = await openChange();
    await chooseSameAs(dialog, 'Juniper');

    expect(await within(dialog).findByText('Carol')).toBeTruthy();
    expect(within(dialog).queryByText('Bob')).toBeNull();
  });

  it('says so when the other list cannot be read', async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY] }, [JUNIPER]);
    const base = getAgentMock.getMockImplementation();
    getAgentMock.mockImplementation(async (id) => {
      if (id === 'agt_juniper') throw new Error('read agent: 500');
      return base!(id);
    });
    renderSection();
    const dialog = await openChange();
    await chooseSameAs(dialog, 'Juniper');
    expect(await within(dialog).findByText(SHARING_COPY.picker.copyFailed('Juniper'))).toBeTruthy();
  });

  it('is hidden when you have no other shared agent', async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY] }, [
      adminAgent({ id: 'agt_quill', displayName: 'Quill', shared: false }),
    ]);
    renderSection();
    const dialog = await openChange();
    await waitFor(() => expect(listAgentsMock).toHaveBeenCalled());
    await act(async () => {});
    expect(within(dialog).queryByRole('button', { name: SHARING_COPY.picker.sameAs })).toBeNull();
  });
});

describe('AgentSharing — the section', () => {
  it('a team agent shows the team line and no Change', async () => {
    getAgentMock.mockResolvedValue(withoutSharing({ visibility: 'team', ownerType: 'team' }));
    renderSection();
    expect(await screen.findByText(SHARING_COPY.team(FERN))).toBeTruthy();
    expect(screen.queryByRole('button', { name: SHARING_COPY.change })).toBeNull();
  });

  it('someone who is not an owner is told who can change it', async () => {
    getAgentMock.mockResolvedValue(withoutSharing({ isOwner: false }));
    renderSection();
    expect(await screen.findByText(SHARING_COPY.errors.forbidden(FERN))).toBeTruthy();
    expect(screen.queryByRole('button', { name: SHARING_COPY.change })).toBeNull();
  });

  it('a failed read says so, and Try again reads again', async () => {
    getAgentMock.mockRejectedValueOnce(new Error('read agent: 500'));
    getAgentMock.mockResolvedValueOnce(adminAgent());
    renderSection();
    expect(await screen.findByText(SHARING_COPY.errors.loadFailed(FERN))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: SHARING_COPY.tryAgain }));
    expect(await screen.findByRole('button', { name: SHARING_COPY.change })).toBeTruthy();
    expect(getAgentMock).toHaveBeenCalledTimes(2);
  });

  it('heads the row with the question and lists up to two people, then a count', async () => {
    const eve = { type: 'user' as const, id: 'eve', displayName: 'Eve' };
    serve({ audience: { kind: 'list', members: [CAROL, DAVE, eve] }, owners: [VINAY] });
    renderSection();
    expect(await screen.findByText(SHARING_COPY.heading(FERN))).toBeTruthy();
    expect(screen.getByText(SHARING_COPY.audience.people(['Carol', 'Dave'], 3))).toBeTruthy();
  });

  it('with co-owners, "Just me" reads as its owners in the summary and in the picker', async () => {
    serve({ audience: { kind: 'just-me' }, owners: [VINAY, BOB] });
    renderSection();
    expect(await screen.findByText(SHARING_COPY.audience.justMe(2))).toBeTruthy();
    expect(screen.queryByText(SHARING_COPY.audience.justMe(1))).toBeNull();

    const dialog = await openChange();
    fireEvent.click(within(dialog).getByRole('combobox', { name: SHARING_COPY.picker.fieldLabel }));
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options[0]).toBe(SHARING_COPY.audience.justMe(2));
    expect(options.some((o) => o === SHARING_COPY.picker.justMeOption)).toBe(false);
  });
});
