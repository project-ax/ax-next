/**
 * TASK-1247 — the non-owner view of an agent. Someone an agent is only shared
 * with (`access: 'audience'`) just chats: no settings page, even from a typed
 * or old settings address, and no link that leads to one. Owners are
 * unchanged.
 */
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, type AgentDetail, type WorkspaceAgent } from '@/lib/workspace-api';
import type { AgentAccess } from '@/lib/workspace-types';
import { ERROR_LABELS, askOwnerInstead } from '@/lib/turn-error-labels';
import { AgentView } from '../AgentView';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      connectors: vi.fn(async () => ({
        connectors: [],
        shared: false,
        manageable: true,
        sharedCredentials: false,
        connectorsSupported: true,
      })),
      rail: vi.fn(async () => railFixture()),
      userFiles: vi.fn(async () => {
        const E = actual.WorkspaceApiError as new (path: string, status: number) => Error;
        throw new E('/agents/a-quill/user-files/', 404);
      }),
      revokeGrant: vi.fn(),
      abilities: vi.fn(async () => ({
        abilities: { webSearch: true, readPages: true, runCode: true },
      })),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const agentMock = vi.mocked(workspaceApi.agent);
const sendMock = vi.mocked(workspaceApi.sendMessage);
const connectorsMock = vi.mocked(workspaceApi.connectors);
const streamMock = vi.mocked(workspaceApi.streamReply);

function detail(access: AgentAccess): AgentDetail {
  const agent: WorkspaceAgent = {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
    access,
  };
  return {
    agent,
    conversationId: 'c-now',
    thread: [{ kind: 'user', id: 't1', text: 'what is on today' }],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null } },
  };
}

function renderView(over: Partial<ComponentProps<typeof AgentView>> = {}) {
  return render(
    <AgentView
      agentId="a-quill"
      tab="chat"
      onTab={vi.fn()}
      decisions={[]}
      threadGrants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      onBack={vi.fn()}
      decisionsError={null}
      version={0}
      onChanged={vi.fn()}
      {...over}
    />,
  );
}

const settingsNav = () => screen.queryByRole('navigation', { name: 'Settings sections' });

beforeEach(() => {
  localStorage.clear();
  agentMock.mockReset();
  sendMock.mockReset();
  streamMock.mockReset();
});

describe('AgentView — the settings address', () => {
  it('opening the settings address of an agent you only use shows its chat instead', async () => {
    agentMock.mockResolvedValue(detail('audience'));
    const onTab = vi.fn();
    renderView({ settingsSection: 'connectors', onSettingsSection: vi.fn(), onTab });

    // REPLACE the history entry: a push would make Back return to this address and bounce again.
    await waitFor(() => expect(onTab).toHaveBeenCalledWith('chat', { replace: true }));
    expect(settingsNav()).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Quill settings' })).toBeNull();
  });

  it('an owner still gets the settings page', async () => {
    agentMock.mockResolvedValue(detail('co-owner'));
    const onTab = vi.fn();
    renderView({ settingsSection: 'connectors', onSettingsSection: vi.fn(), onTab });

    expect(await screen.findByRole('heading', { level: 1, name: 'Quill settings' })).toBeTruthy();
    expect(settingsNav()).not.toBeNull();
    expect(onTab).not.toHaveBeenCalled();
  });
});

describe('AgentView — a turn error that points at Connectors', () => {
  async function failTurnNeedingSignIn() {
    sendMock.mockResolvedValue({ conversationId: 'c-now', reqId: 'r1' });
    streamMock.mockImplementation(
      async (
        _reqId: string,
        h: { onError: (m: string, fix?: { opensConnectors: true }) => void },
      ) => {
        h.onError(
          'One of this agent’s connectors needs you to sign in again. Open Connectors, reconnect it, then retry.',
          { opensConnectors: true },
        );
      },
    );
    const box = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box, { target: { value: 'check my inbox' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByRole('button', { name: 'Dismiss' });
  }

  it('offers Open Connectors only to someone who manages the agent', async () => {
    agentMock.mockResolvedValue(detail('co-owner'));
    const onSettingsSection = vi.fn();
    renderView({ onSettingsSection });
    await failTurnNeedingSignIn();
    fireEvent.click(screen.getByRole('button', { name: 'Open Connectors' }));
    expect(onSettingsSection).toHaveBeenCalledWith('connectors');
  });

  it('tells someone the agent is only shared with to ask its owner, not to open Connectors', async () => {
    agentMock.mockResolvedValue(detail('audience'));
    renderView({ onSettingsSection: vi.fn() });
    await failTurnNeedingSignIn();
    expect(await screen.findByText(askOwnerInstead(ERROR_LABELS['connector-needs-reconnect']!))).toBeTruthy();
    expect(document.body.textContent ?? '').not.toContain('Open Connectors,');
  });

  it('leaves Open Connectors out for someone the agent is only shared with', async () => {
    agentMock.mockResolvedValue(detail('audience'));
    renderView({ onSettingsSection: vi.fn() });
    await failTurnNeedingSignIn();
    expect(screen.queryByRole('button', { name: 'Open Connectors' })).toBeNull();
    // The way out that remains is the one that works for them.
    expect(screen.getByRole('button', { name: 'Resend' })).toBeTruthy();
  });
});

describe('AgentView — the "signed out of a connection" notice', () => {
  const GMAIL_NEEDS_SIGN_IN = {
    connectors: [
      {
        id: 'gmail',
        name: 'Gmail',
        source: 'attached' as const,
        editable: false,
        health: 'needs-sign-in' as const,
        removable: true,
      },
    ],
    shared: false,
    manageable: true,
    sharedCredentials: false,
    connectorsSupported: true,
  };

  it('links to Connectors for an owner', async () => {
    agentMock.mockResolvedValue(detail('co-owner'));
    connectorsMock.mockResolvedValue(GMAIL_NEEDS_SIGN_IN);
    const onSettingsSection = vi.fn();
    renderView({ onSettingsSection });
    await screen.findByText(/isn’t signed in yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Connectors' }));
    expect(onSettingsSection).toHaveBeenCalledWith('connectors');
  });

  it('shows the notice without that link for someone the agent is only shared with', async () => {
    agentMock.mockResolvedValue(detail('audience'));
    connectorsMock.mockResolvedValue(GMAIL_NEEDS_SIGN_IN);
    renderView({ onSettingsSection: vi.fn() });
    expect(await screen.findByText(/isn’t signed in yet/)).toHaveTextContent('Gmail');
    expect(screen.queryByRole('button', { name: 'Open Connectors' })).toBeNull();
  });
});
