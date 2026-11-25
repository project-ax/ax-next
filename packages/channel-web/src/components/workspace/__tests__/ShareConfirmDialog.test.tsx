/**
 * ShareConfirmDialog (TASK-1247): widening who can use an agent names what it
 * shares. Every connection that travels with the agent is named with the
 * account it's signed in to; the viewer's own legacy connectors are not. It
 * fails closed: Share stays off while the connections load, after the read
 * fails, and on a reopen until a fresh read lands. Words come from
 * SHARING_COPY; tests never repeat a sentence.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentConnectorRow, AgentConnectorSource, AgentConnectorsRead } from '@/lib/workspace-types';
import { SHARING_COPY, personLabel } from '@/lib/sharing-copy';
import { ShareConfirmDialog, type ShareConfirmDialogProps } from '../ShareConfirmDialog';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { connectors: vi.fn() } };
});
const connectorsMock = vi.mocked(workspaceApi.connectors);

const AGENT = 'Fern';
const ACCOUNT = 'vinay@example.com';

const GMAIL: AgentConnectorRow = {
  id: 'gmail',
  name: 'Gmail',
  source: 'attached',
  editable: false,
  health: 'ok',
  removable: true,
  signedIn: { account: ACCOUNT, byName: 'Vinay', byYou: true, at: null },
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
/** The viewer's own connector: it never reaches anyone the agent is shared with. */
const NOTION: AgentConnectorRow = {
  id: 'notion',
  name: 'Notion',
  source: 'legacy-owned',
  editable: true,
  health: 'ok',
  removable: true,
};

function answer(rows: AgentConnectorRow[], over: Partial<AgentConnectorsRead> = {}): AgentConnectorsRead {
  return {
    connectors: rows,
    shared: false,
    manageable: true,
    sharedCredentials: false,
    connectorsSupported: true,
    ...over,
  };
}

function props(over: Partial<ShareConfirmDialogProps> = {}): ShareConfirmDialogProps {
  return {
    open: true,
    agentId: 'a-fern',
    agentName: AGENT,
    attachedConnectorIds: [],
    who: { kind: 'everyone' },
    saving: false,
    error: null,
    onShare: vi.fn(),
    onRemoveConnectionsFirst: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

function renderDialog(over: Partial<ShareConfirmDialogProps> = {}) {
  const p = props(over);
  return { ...render(<ShareConfirmDialog {...p} />), props: p };
}

const button = (name: string) => screen.getByRole('button', { name });
const shareButton = () => button(SHARING_COPY.confirm.share);
const queryRemoveFirst = () =>
  screen.queryByRole('button', { name: SHARING_COPY.confirm.removeConnectionsFirst });
const pageText = () => document.body.textContent ?? '';

/** The one paragraph whose whole text is `text`: a line can be several nodes. */
function paragraph(text: string): HTMLElement {
  return screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === text);
}

/** How the connections line names one connection: "Gmail (signed in as …)". */
function named(row: AgentConnectorRow): string {
  const account = row.signedIn?.account;
  const label = personLabel(row.name);
  return account ? `${label} (${SHARING_COPY.confirm.signedInAs(account)})` : label;
}

/** The connections line's opening words, taken from the copy, not retyped. */
const CONNECTIONS_LEAD = SHARING_COPY.confirm.connections(AGENT, ['{name}']).split('{name}')[0]!;

async function readLanded() {
  await waitFor(() => expect(shareButton()).toBeEnabled());
}

beforeEach(() => {
  connectorsMock.mockReset();
});

describe('ShareConfirmDialog', () => {
  it("names each attached connection and the account it's signed in to", async () => {
    connectorsMock.mockResolvedValue(answer([GMAIL, CALENDAR, NOTION]));
    renderDialog();
    await readLanded();

    expect(connectorsMock).toHaveBeenCalledWith('a-fern');
    expect(paragraph(SHARING_COPY.confirm.connections(AGENT, [named(GMAIL), named(CALENDAR)]))).toBeInTheDocument();
    // Provider text sits in its own <bdi>, so an RTL account can't reorder the sentence.
    expect(screen.getByText(ACCOUNT).tagName).toBe('BDI');
    expect(pageText()).not.toContain(NOTION.name);
  });

  it('names a connection from a source it does not know (an over-full list is safe)', async () => {
    const unknown = 'shared-drive' as unknown as AgentConnectorSource;
    connectorsMock.mockResolvedValue(answer([{ ...CALENDAR, source: unknown }]));
    renderDialog();
    await readLanded();

    expect(paragraph(SHARING_COPY.confirm.connections(AGENT, [named(CALENDAR)]))).toBeInTheDocument();
    expect(queryRemoveFirst()).not.toBeNull();
  });

  it("fences a connection's name before showing it", async () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const spoofed = { ...CALENDAR, name: `Gm${rlo}ail${zwsp}Drive` };
    connectorsMock.mockResolvedValue(answer([spoofed]));
    renderDialog();
    await readLanded();

    expect(paragraph(SHARING_COPY.confirm.connections(AGENT, [personLabel(spoofed.name)]))).toBeInTheDocument();
    expect(pageText()).not.toContain(rlo);
    expect(pageText()).not.toContain(zwsp);
  });

  it('Remove connections first reports it and never shares', async () => {
    connectorsMock.mockResolvedValue(answer([GMAIL]));
    const { props: p } = renderDialog();
    await readLanded();

    fireEvent.click(button(SHARING_COPY.confirm.removeConnectionsFirst));
    expect(p.onRemoveConnectionsFirst).toHaveBeenCalledTimes(1);
    expect(p.onShare).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty list', answer([])],
    ['a runner that loads no connectors', answer([GMAIL, CALENDAR], { connectorsSupported: false })],
    ["only the viewer's own legacy connectors", answer([NOTION])],
  ])(
    'with no connections (%s) there is no connections line and no Remove connections first, and Share shares',
    async (_, read) => {
      connectorsMock.mockResolvedValue(read);
      const { props: p } = renderDialog();
      await readLanded();

      expect(pageText()).not.toContain(CONNECTIONS_LEAD);
      for (const row of read.connectors) expect(pageText()).not.toContain(row.name);
      expect(queryRemoveFirst()).toBeNull();

      fireEvent.click(shareButton());
      expect(p.onShare).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['an empty list', answer([])],
    ['a runner that loads no connectors', answer([GMAIL], { connectorsSupported: false })],
    ["only the viewer's own legacy connectors", answer([NOTION])],
  ])(
    'when the agent has connections attached but the read names none of them (%s), Share stays off and Try again reads again',
    async (_, read) => {
      connectorsMock.mockResolvedValueOnce(read).mockResolvedValueOnce(answer([GMAIL]));
      const { props: p } = renderDialog({ attachedConnectorIds: ['gmail'] });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(SHARING_COPY.confirm.connectionsFailed(AGENT));
      expect(shareButton()).toBeDisabled();
      fireEvent.click(shareButton());
      expect(p.onShare).not.toHaveBeenCalled();

      fireEvent.click(within(alert).getByRole('button', { name: SHARING_COPY.confirm.tryAgain }));
      await readLanded();
      expect(paragraph(SHARING_COPY.confirm.connections(AGENT, [named(GMAIL)]))).toBeInTheDocument();
    },
  );

  it('an attached connection the read does name is enough to share', async () => {
    connectorsMock.mockResolvedValue(answer([GMAIL]));
    renderDialog({ attachedConnectorIds: ['gmail', 'gone-from-the-catalog'] });
    await readLanded();
    expect(paragraph(SHARING_COPY.confirm.connections(AGENT, [named(GMAIL)]))).toBeInTheDocument();
  });

  it('Share stays off while the connections are loading', async () => {
    let land!: (read: AgentConnectorsRead) => void;
    connectorsMock.mockReturnValue(new Promise((resolve) => (land = resolve)));
    const { props: p } = renderDialog();

    expect(screen.getByText(SHARING_COPY.confirm.loading)).toBeInTheDocument();
    expect(shareButton()).toBeDisabled();
    fireEvent.click(shareButton());
    expect(p.onShare).not.toHaveBeenCalled();
    // Unknown is not "none": no Remove connections first until the read says so.
    expect(queryRemoveFirst()).toBeNull();

    await act(async () => land(answer([GMAIL])));
    expect(shareButton()).toBeEnabled();
    expect(screen.queryByText(SHARING_COPY.confirm.loading)).toBeNull();
  });

  it.each([
    ['refused', () => Promise.reject(new Error('connectors read failed'))],
    ['malformed', () => Promise.resolve({} as AgentConnectorsRead)],
  ])("if the connections can't be read (%s), Share stays off and Try again reads them again", async (_, first) => {
    connectorsMock.mockImplementationOnce(first).mockResolvedValueOnce(answer([GMAIL]));
    const { props: p } = renderDialog();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(SHARING_COPY.confirm.connectionsFailed(AGENT));
    expect(shareButton()).toBeDisabled();
    fireEvent.click(shareButton());
    expect(p.onShare).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole('button', { name: SHARING_COPY.confirm.tryAgain }));
    expect(connectorsMock).toHaveBeenCalledTimes(2);
    expect(shareButton()).toBeDisabled();

    await readLanded();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(paragraph(SHARING_COPY.confirm.connections(AGENT, [named(GMAIL)]))).toBeInTheDocument();
  });

  it.each([
    ['while it checks the connections', () => new Promise<AgentConnectorsRead>(() => {}), async () => {}],
    [
      'when the check fails',
      () => Promise.reject(new Error('down')),
      async () => {
        await screen.findByRole('alert');
      },
    ],
    ['with no connections', () => Promise.resolve(answer([])), readLanded],
    ['with connections', () => Promise.resolve(answer([GMAIL])), readLanded],
  ])(
    'always says what it remembers, its files and artifacts, and its Instructions (%s)',
    async (_, read, settled) => {
      connectorsMock.mockImplementation(read);
      renderDialog();
      await settled();

      expect(paragraph(SHARING_COPY.confirm.memory(AGENT))).toBeInTheDocument();
      expect(paragraph(SHARING_COPY.confirm.filesAndInstructions(AGENT))).toBeInTheDocument();
    },
  );

  it('the title names the people being added, or everyone', async () => {
    connectorsMock.mockResolvedValue(answer([]));
    const { props: p, rerender } = renderDialog();
    expect(screen.getByRole('dialog', { name: SHARING_COPY.confirm.title(AGENT, 'everyone') })).toBeInTheDocument();

    const spoofed = `Mallory${String.fromCharCode(0x202e)}lacitirc`;
    const added = [
      { id: 'u-alice', displayName: 'Alice Archer' },
      { id: 'u-mallory', displayName: spoofed },
      { id: 'u-unnamed', displayName: null },
    ];
    rerender(<ShareConfirmDialog {...p} who={{ kind: 'people', added }} />);
    const title = SHARING_COPY.confirm.title(
      AGENT,
      added.map((person) => personLabel(person.displayName)),
    );
    expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
    expect(pageText()).not.toContain(spoofed);
    await readLanded();
  });

  it('reads the connections each time it opens, and never while closed', async () => {
    connectorsMock.mockResolvedValue(answer([]));
    const { props: p, rerender } = renderDialog({ open: false });
    expect(connectorsMock).not.toHaveBeenCalled();

    rerender(<ShareConfirmDialog {...p} open />);
    await readLanded();
    rerender(<ShareConfirmDialog {...p} open={false} />);

    // Reopened: the earlier answer doesn't count, so Share waits for a fresh one.
    connectorsMock.mockReturnValue(new Promise(() => {}));
    rerender(<ShareConfirmDialog {...p} open />);
    expect(connectorsMock).toHaveBeenCalledTimes(2);
    expect(shareButton()).toBeDisabled();
  });

  it('switching agents while open drops the old agent’s answer and waits for the new one', async () => {
    connectorsMock.mockResolvedValueOnce(answer([GMAIL]));
    const { props: p, rerender } = renderDialog({ agentId: 'a-fern' });
    await screen.findByText(GMAIL.name);
    expect(shareButton()).toBeEnabled();

    // Agent B's read never lands: nothing of agent A's may linger or be shareable.
    connectorsMock.mockReturnValueOnce(new Promise(() => {}));
    rerender(<ShareConfirmDialog {...p} agentId="a-juniper" agentName="Juniper" />);

    expect(connectorsMock).toHaveBeenLastCalledWith('a-juniper');
    expect(shareButton()).toBeDisabled();
    expect(pageText()).not.toContain(GMAIL.name);
    expect(screen.getByText(SHARING_COPY.confirm.loading)).toBeInTheDocument();
  });

  it('while sharing nothing closes it and every button is off; a failed Share shows its error inside', async () => {
    connectorsMock.mockResolvedValue(answer([GMAIL]));
    const { props: p } = renderDialog({ saving: true, error: SHARING_COPY.errors.generic });
    await screen.findByText(ACCOUNT);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(button('Close'));
    expect(p.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    for (const name of [
      SHARING_COPY.confirm.cancel,
      SHARING_COPY.confirm.removeConnectionsFirst,
      SHARING_COPY.confirm.share,
    ]) {
      expect(button(name)).toBeDisabled();
    }
    expect(screen.getByRole('alert')).toHaveTextContent(SHARING_COPY.errors.generic);
  });

  it('Cancel and Escape cancel when nothing is being shared', async () => {
    connectorsMock.mockResolvedValue(answer([]));
    const { props: p } = renderDialog();
    await readLanded();

    fireEvent.click(button(SHARING_COPY.confirm.cancel));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(p.onCancel).toHaveBeenCalledTimes(2);
    expect(p.onShare).not.toHaveBeenCalled();
  });
});
