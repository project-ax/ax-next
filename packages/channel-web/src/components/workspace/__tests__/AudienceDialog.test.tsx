/**
 * AudienceDialog: at the people cap, Just me and Everyone must stay choosable
 * (the cap line tells people to choose Everyone), and only the people search
 * is switched off. Save decides "is this widening?" against the audience as
 * saved NOW, not as the section last read it: another owner may have narrowed
 * it in another tab.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharingView } from '@ax/agents';
import { getAdminAgent, listAdminAgents, type AdminAgent } from '@/lib/admin';
import { HttpError } from '@/lib/http';
import { AUDIENCE_MEMBERS_MAX } from '@/lib/agent-sharing';
import { searchPeople, setAudience, SharingRequestError } from '@/lib/agent-sharing-api';
import { workspaceApi } from '@/lib/workspace-api';
import { SHARING_COPY } from '@/lib/sharing-copy';
import { AudienceDialog } from '../AudienceDialog';

vi.mock('@/lib/admin', async (original) => ({
  ...(await original<typeof import('@/lib/admin')>()),
  listAdminAgents: vi.fn(),
  getAdminAgent: vi.fn(),
}));
vi.mock('@/lib/agent-sharing-api', async (original) => ({
  ...(await original<typeof import('@/lib/agent-sharing-api')>()),
  searchPeople: vi.fn(),
  setAudience: vi.fn(),
}));
vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { connectors: vi.fn() } };
});

const getAgentMock = vi.mocked(getAdminAgent);
const setAudienceMock = vi.mocked(setAudience);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAdminAgents).mockResolvedValue([]);
  vi.mocked(searchPeople).mockResolvedValue([{ id: 'carol', displayName: 'Carol' }]);
  vi.mocked(workspaceApi.connectors).mockResolvedValue({
    connectors: [],
    shared: false,
    manageable: true,
    sharedCredentials: false,
    connectorsSupported: true,
  });
});

/** Juniper as the server answers it now. */
function agentNow(audience: SharingView['audience']): AdminAgent {
  return {
    id: 'a1',
    ownerId: 'owner',
    ownerType: 'user',
    visibility: 'personal',
    displayName: 'Juniper',
    allowedTools: [],
    mcpConfigIds: [],
    model: 'x/y',
    skillAttachments: [],
    connectorAttachments: [],
    shared: audience.kind !== 'just-me',
    isOwner: true,
    sharing: { audience, owners: [{ id: 'owner', displayName: 'Owner', creator: true }] },
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

function renderDialog(
  saved: SharingView['audience'],
  handlers: { onSaved?: (s: SharingView) => void; onClose?: () => void } = {},
) {
  render(
    <AudienceDialog
      open
      agentId="a1"
      agentName="Juniper"
      saved={saved}
      ownerIds={new Set(['owner'])}
      onSaved={handlers.onSaved ?? vi.fn()}
      onOpenConnections={vi.fn()}
      onClose={handlers.onClose ?? vi.fn()}
    />,
  );
  return screen.getByRole('dialog', { name: SHARING_COPY.picker.title('Juniper') });
}

async function pickCarol(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('combobox', { name: SHARING_COPY.picker.fieldLabel }));
  fireEvent.change(screen.getByPlaceholderText(SHARING_COPY.picker.placeholder), {
    target: { value: 'Ca' },
  });
  fireEvent.click(await screen.findByRole('option', { name: 'Carol' }, { timeout: 10_000 }));
}

describe('AudienceDialog — Save reads what is saved now', () => {
  it('asks first when another owner narrowed it since: Everyone here, just-me now, a list in the draft', async () => {
    getAgentMock.mockResolvedValue(agentNow({ kind: 'just-me' }));
    const dialog = renderDialog({ kind: 'everyone' });
    await pickCarol(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));

    expect(
      await screen.findByRole('dialog', { name: SHARING_COPY.confirm.title('Juniper', ['Carol']) }),
    ).toBeTruthy();
    expect(getAgentMock).toHaveBeenCalledWith('a1');
    expect(setAudienceMock).not.toHaveBeenCalled();
  });

  it('the confirmation fails closed when the agent has connections attached but the read names none', async () => {
    getAgentMock.mockResolvedValue({ ...agentNow({ kind: 'just-me' }), connectorAttachments: ['gmail'] });
    const dialog = renderDialog({ kind: 'just-me' });
    await pickCarol(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));

    const confirm = await screen.findByRole('dialog', {
      name: SHARING_COPY.confirm.title('Juniper', ['Carol']),
    });
    expect(
      await within(confirm).findByText(SHARING_COPY.confirm.connectionsFailed('Juniper')),
    ).toBeTruthy();
    expect(within(confirm).getByRole('button', { name: SHARING_COPY.confirm.share })).toBeDisabled();
  });

  it('if the fresh read fails, says so, logs it and saves nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getAgentMock.mockRejectedValue(new Error('read agent: 500'));
    const dialog = renderDialog({ kind: 'everyone' });
    await pickCarol(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));

    expect(await within(dialog).findByText(SHARING_COPY.errors.generic)).toBeTruthy();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save })).toBeEnabled(),
    );
    expect(setAudienceMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: SHARING_COPY.confirm.title('Juniper', ['Carol']) }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AudienceDialog — what a failed read says', () => {
  async function saveWithRead(read: () => Promise<AdminAgent>) {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getAgentMock.mockImplementation(read);
    const dialog = renderDialog({ kind: 'everyone' });
    await pickCarol(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));
    return dialog;
  }

  it('a 404 says the agent is gone', async () => {
    const dialog = await saveWithRead(() => Promise.reject(new HttpError('/admin/agents/a1', 404)));
    expect(await within(dialog).findByText(SHARING_COPY.errors.notFound('Juniper'))).toBeTruthy();
    expect(setAudienceMock).not.toHaveBeenCalled();
  });

  it('an answer without sharing says only its owners can change it', async () => {
    const { sharing: _sharing, ...noSharing } = agentNow({ kind: 'everyone' });
    const dialog = await saveWithRead(() => Promise.resolve(noSharing as AdminAgent));
    expect(await within(dialog).findByText(SHARING_COPY.errors.forbidden('Juniper'))).toBeTruthy();
    expect(setAudienceMock).not.toHaveBeenCalled();
  });
});

describe('AudienceDialog — Save judges against the fresh read', () => {
  const carolOnly = {
    kind: 'list',
    members: [{ type: 'user', id: 'carol', displayName: 'Carol' }],
  } as SharingView['audience'];

  it('writes nothing when someone already saved exactly this, and closes', async () => {
    getAgentMock.mockResolvedValue(agentNow(carolOnly));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const dialog = renderDialog({ kind: 'just-me' }, { onSaved, onClose });
    await pickCarol(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setAudienceMock).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(agentNow(carolOnly).sharing);
  });

  it('says people may remember when the fresh audience shows this takes the agent from someone', async () => {
    const dave = {
      kind: 'list',
      members: [{ type: 'user', id: 'dave', displayName: 'Dave' }],
    } as SharingView['audience'];
    getAgentMock.mockResolvedValue(agentNow(dave));
    const dialog = renderDialog({ kind: 'just-me' });
    await pickCarol(dialog);
    expect(screen.queryByText(SHARING_COPY.picker.narrowed('Juniper'))).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));
    await screen.findByRole('dialog', { name: SHARING_COPY.confirm.title('Juniper', ['Carol']) });
    expect(screen.getByText(SHARING_COPY.picker.narrowed('Juniper'))).toBeTruthy();
  });
});

describe('AudienceDialog — failures are logged', () => {
  it('a list of agents that cannot be read hides Same people as, and is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listAdminAgents).mockRejectedValue(new Error('list agents: 500'));
    renderDialog({ kind: 'just-me' });
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: SHARING_COPY.picker.sameAs })).toBeNull();
    warn.mockRestore();
  });

  it('a refused save shows the words and is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getAgentMock.mockResolvedValue(agentNow({ kind: 'everyone' }));
    setAudienceMock.mockRejectedValue(new SharingRequestError('/admin/agents/a1/audience', 403, 'forbidden'));
    const dialog = renderDialog({ kind: 'everyone' });
    await pickCarol(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: SHARING_COPY.picker.save }));
    expect(await within(dialog).findByText(SHARING_COPY.errors.forbidden('Juniper'))).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

function fullList(): SharingView['audience'] {
  return {
    kind: 'list',
    members: Array.from({ length: AUDIENCE_MEMBERS_MAX }, (_, i) => ({
      type: 'user' as const,
      id: `u-${i}`,
      displayName: `Person ${i}`,
    })),
  } as SharingView['audience'];
}

describe('AudienceDialog at the people cap', () => {
  it('keeps Everyone and Just me choosable; only the people search is off', () => {
    render(
      <AudienceDialog
        open
        agentId="a1"
        agentName="Juniper"
        saved={fullList()}
        ownerIds={new Set(['owner'])}
        onSaved={vi.fn()}
        onOpenConnections={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(SHARING_COPY.picker.peopleCap)).toBeTruthy();
    const field = screen.getByRole('combobox', { name: SHARING_COPY.picker.fieldLabel });
    expect((field as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(field);
    const input = screen.getByPlaceholderText(SHARING_COPY.picker.placeholder) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.click(screen.getByText(SHARING_COPY.picker.everyoneOption));
    expect(screen.getByText(SHARING_COPY.audience.everyone)).toBeTruthy();
    expect(screen.queryByText(SHARING_COPY.picker.peopleCap)).toBeNull();
  });
});
