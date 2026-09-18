/**
 * The pre-content status line (TASK-352).
 *
 * `phase: 'sandbox-starting'` is the agent saying "give me a moment, I am
 * getting set up". It is worth showing while there is nothing else to show,
 * and it is a lie the moment there is: a status line under a reply that has
 * already started reads as though the reply stalled.
 *
 * The gate is structural — the status row exists only while the turn has
 * produced no text and no steps — so this is the test that says the structure
 * actually holds, in both directions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentView } from '../AgentView';
import { workspaceApi } from '@/lib/workspace-api';
import type { AgentDetail, StreamHandlers, WorkspaceAgent } from '@/lib/workspace-api';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function detail(): AgentDetail {
  return {
    agent: quill,
    conversationId: 'c1',
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null }, learned: { status: 'unavailable', docs: [] } },
  } as unknown as AgentDetail;
}

function renderView(): ReturnType<typeof render> {
  return render(
    <AgentView
      agentId="a1"
      tab="chat"
      onTab={vi.fn()}
      decisions={[]}
      threadGrants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      activity={[]}
      agents={[quill]}
      onBack={vi.fn()}
      decisionsError={null}
      version={0}
      onChanged={vi.fn()}
    />,
  );
}

/** Start a turn whose stream is driven by `script` and never finishes. */
async function startTurn(script: (h: StreamHandlers) => void): Promise<void> {
  vi.mocked(workspaceApi.agent).mockResolvedValue(detail());
  vi.mocked(workspaceApi.sendMessage).mockResolvedValue({
    conversationId: 'c1',
    reqId: 'r1',
  } as never);
  vi.mocked(workspaceApi.streamReply).mockImplementation(async (_r, h) => {
    script(h);
    await new Promise<void>(() => {});
  });
  renderView();
  const box = await screen.findByPlaceholderText('Message Quill');
  fireEvent.change(box, { target: { value: 'hello' } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

describe('the phase status line', () => {
  beforeEach(() => {
    vi.mocked(workspaceApi.agent).mockReset();
    vi.mocked(workspaceApi.sendMessage).mockReset();
    vi.mocked(workspaceApi.streamReply).mockReset();
  });

  it('shows before any content arrives', async () => {
    await startTurn((h) => h.onPhase?.('sandbox-starting'));
    await waitFor(() => {
      expect(screen.getByText('Getting set up…')).toBeTruthy();
    });
  });

  it('says only "Thinking…" when no phase was reported', async () => {
    await startTurn(() => undefined);
    await waitFor(() => {
      expect(screen.getByText('Thinking…')).toBeTruthy();
    });
    expect(screen.queryByText('Getting set up…')).toBeNull();
  });

  it('is gone once text has started, even though the phase still stands', async () => {
    await startTurn((h) => {
      h.onPhase?.('sandbox-starting');
      h.onText('Here we go.');
    });
    await waitFor(() => {
      expect(screen.getByText(/Here we go/)).toBeTruthy();
    });
    expect(screen.queryByText('Getting set up…')).toBeNull();
    expect(screen.queryByText('Thinking…')).toBeNull();
  });

  it('is gone once a STEP has started, which is content too', async () => {
    // The case a text-only gate would miss: a turn whose first observable act
    // is a tool call, not a word.
    await startTurn((h) => {
      h.onPhase?.('sandbox-starting');
      h.onToolUse?.({ toolCallId: 'tu1', toolName: 'Bash', activityPhrase: 'Running a command' });
    });
    await waitFor(() => {
      expect(screen.getByText('Running a command — in progress')).toBeTruthy();
    });
    expect(screen.queryByText('Getting set up…')).toBeNull();
  });

  it('never shows a phase arriving AFTER content — the rule, stated backwards', async () => {
    await startTurn((h) => {
      h.onText('Here we go.');
      h.onPhase?.('sandbox-starting');
    });
    await waitFor(() => {
      expect(screen.getByText(/Here we go/)).toBeTruthy();
    });
    expect(screen.queryByText('Getting set up…')).toBeNull();
  });
});
