/**
 * ProposedConnectorApproveDialog — the Settings-side twin of the in-chat
 * connector approval card.
 *
 * TASK-344 — **the 2026-09-06 UX audit missed this file.** It is a near-copy of
 * `PermissionCard`'s reach renderer and carried the same three defects TASK-334
 * fixed there: a bare "Will access" host list (A12), raw slot ids as field
 * labels (A1), and "Installs npm packages → reaches registry.npmjs.org" (A5).
 *
 * The two surfaces describe the SAME decision — approve this connector's reach
 * — so fixing one and not the other leaves the product saying two different
 * things depending on where you happened to be standing. These tests pin the
 * parity rather than the strings in isolation, because parity is the property
 * that was broken.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProposedConnectorApproveDialog } from '../ProposedConnectorApproveDialog';
import {
  TOOL_PERMISSIONS_RESET_FAILED_APPROVE_MESSAGE,
  type PendingAuthoredConnector,
} from '@/lib/connectors';
import { connectorAccessCopy } from '@/lib/connector-access-copy';

// `hoisted` so a test can make the vault report a key already saved (TASK-700).
const vault = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<Array<{ ref: string; scope: string }>> => []),
}));
vi.mock('@/lib/credentials', () => ({
  myCredentials: { list: vault.list },
  setDestinationCredential: vi.fn(),
}));

const draft = {
  connectorId: 'linear',
  name: 'Linear',
  agentId: 'agt-1',
  proposal: {
    allowedHosts: ['api.linear.app'],
    credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' as const }],
    packages: { npm: ['@schpet/linear-cli'], pypi: [] },
  },
} as unknown as PendingAuthoredConnector;

describe('ProposedConnectorApproveDialog — parity with the in-chat card', () => {
  const open = () =>
    render(
      <ProposedConnectorApproveDialog
        draft={draft}
        open
        onOpenChange={vi.fn()}
        onApproved={vi.fn()}
      />,
    );

  it('says what the host list is for (A12)', async () => {
    open();
    expect(await screen.findByText(/it needs to reach:/i)).toBeInTheDocument();
    expect(screen.queryByText('Will access')).toBeNull();
  });

  it('labels the key field in English and says where the key goes (A1)', async () => {
    open();
    expect(await screen.findByLabelText('Linear API key')).toBeInTheDocument();
    expect(screen.getByText(/the agent never sees it/i)).toBeInTheDocument();
  });

  it('says the plain thing about downloads rather than naming registries (A5)', async () => {
    open();
    expect(
      await screen.findByText(/download some extra software/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/registry\.npmjs\.org/)).toBeNull();
  });
});

// TASK-700 — the launch disclosure (TASK-328). This is the Settings twin of the
// in-chat grant row, so it says the SAME thing in the same place (after the key,
// before Connect) — `GrantRow.test.tsx` pins the other half of that parity.
describe('ProposedConnectorApproveDialog — access disclosure (TASK-700)', () => {
  const NOTICE = 'connector-access-notice';
  const renderDraft = (d: PendingAuthoredConnector) =>
    render(
      <ProposedConnectorApproveDialog draft={d} open onOpenChange={vi.fn()} onApproved={vi.fn()} />,
    );

  it('shows the key notice between the key field and the Connect button', async () => {
    vault.list.mockResolvedValueOnce([]);
    renderDraft(draft);
    const field = await screen.findByLabelText('Linear API key');
    const notice = screen.getByTestId(NOTICE);
    const connect = screen.getByRole('button', { name: /^connect$/i });
    expect(notice).toHaveTextContent(connectorAccessCopy('key').headline);
    expect(notice).toHaveTextContent(connectorAccessCopy('key').details);
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(field, notice)).toBe(true);
    expect(follows(notice, connect)).toBe(true);
    expect(screen.getAllByTestId(NOTICE)).toHaveLength(1);
  });

  it('still shows it when the key is already saved: approving attaches that key', async () => {
    vault.list.mockResolvedValueOnce([{ ref: 'account:linear', scope: 'user' }]);
    renderDraft(draft);
    await screen.findByText(/you already saved/i);
    expect(screen.getAllByTestId(NOTICE)).toHaveLength(1);
  });

  it('a proposal that needs no key hands over no key, so shows no notice', async () => {
    const noKey = {
      ...draft,
      proposal: { ...draft.proposal, credentials: [], packages: { npm: [], pypi: [] } },
    } as unknown as PendingAuthoredConnector;
    renderDraft(noKey);
    await screen.findByText(/it needs to reach:/i);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });
});

// TASK-771 — approving a proposal promotes it through `connectors:upsert`. When
// that lands on an existing connector whose server address changed, the server
// first resets that server's tool permissions; if the reset fails it refuses
// the whole approve with 503 `tool-permissions-reset-failed` (TASK-758). The
// dialog must say what happened in words, not echo the bare code.
describe('ProposedConnectorApproveDialog — tool-permissions reset failure (TASK-771)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const noKey = {
    ...draft,
    proposal: { ...draft.proposal, credentials: [], packages: { npm: [], pypi: [] } },
  } as unknown as PendingAuthoredConnector;

  function stubApprove(status: number, body: unknown) {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function clickConnect(onApproved = vi.fn()) {
    render(
      <ProposedConnectorApproveDialog
        draft={noKey}
        open
        onOpenChange={vi.fn()}
        onApproved={onApproved}
      />,
    );
    await screen.findByText(/it needs to reach:/i);
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    return onApproved;
  }

  it('a 503 tool-permissions-reset-failed shows the plain message, not the bare code', async () => {
    const fetchMock = stubApprove(503, { error: 'tool-permissions-reset-failed' });
    const onApproved = await clickConnect();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(TOOL_PERMISSIONS_RESET_FAILED_APPROVE_MESSAGE);
    expect(alert).not.toHaveTextContent('tool-permissions-reset-failed');
    expect(onApproved).not.toHaveBeenCalled();
    // It really went through the approve route (not a short-circuit).
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/settings/connectors/authored/linear/approve',
    );
    // Retryable: Connect is live again.
    expect(screen.getByRole('button', { name: /^connect$/i })).toBeEnabled();
  });

  it('any other failure keeps its own message (only the reset code is mapped)', async () => {
    stubApprove(409, { error: 'not-authored' });
    await clickConnect();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('not-authored');
    expect(alert).not.toHaveTextContent(TOOL_PERMISSIONS_RESET_FAILED_APPROVE_MESSAGE);
  });
});
