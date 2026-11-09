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
import { act, within, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      artifact: vi.fn(),
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
    memory: { rules: { status: 'unavailable', doc: null } },
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

  it('switches to Thinking when provisioning finishes, before any reply arrives', async () => {
    let handlers!: StreamHandlers;
    await startTurn((h) => { handlers = h; h.onPhase?.('sandbox-starting'); });
    await waitFor(() => expect(screen.getByText('Getting set up…')).toBeTruthy());
    act(() => handlers.onPhase?.('sandbox-ready'));
    await waitFor(() => expect(screen.getByText('Thinking…')).toBeTruthy());
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
      // The panel is shut; its one line says what is happening now.
      expect(screen.getByText('Running a command…')).toBeTruthy();
    });
    expect(screen.queryByText('Getting set up…')).toBeNull();
  });

  it('holds the step title steady between one tool result and the next call', async () => {
    // The flicker: the title read the running step, then snapped to the
    // end-of-turn summary the moment its result landed, then back again when
    // the next call started. While the turn streams it stays in the present.
    let handlers!: StreamHandlers;
    await startTurn((h) => {
      handlers = h;
      h.onToolUse?.({ toolCallId: 'tu1', toolName: 'Read', detail: 'src/a.ts' });
    });
    await waitFor(() => expect(screen.getByText('Reading a.ts…')).toBeTruthy());
    act(() => handlers.onToolResult?.({ toolCallId: 'tu1' }));
    expect(screen.getByText('Reading a.ts…')).toBeTruthy();
    expect(screen.queryByText('Read a.ts')).toBeNull();
    act(() => handlers.onToolUse?.({ toolCallId: 'tu2', toolName: 'Bash', detail: 'ls' }));
    await waitFor(() => expect(screen.getByText('Running a command…')).toBeTruthy());
    act(() => handlers.onToolResult?.({ toolCallId: 'tu2' }));
    expect(screen.getByText('Running a command…')).toBeTruthy();
  });

  it('keeps what the agent says as a message, and starts a new step block under it', async () => {
    // Claude-style: a message stays where it was written. Calls after it get
    // their own collapsed title BELOW it; nothing jumps when they arrive.
    let handlers!: StreamHandlers;
    await startTurn((h) => {
      handlers = h;
      h.onToolUse?.({ toolCallId: 'tu1', toolName: 'Bash', detail: 'ls' });
    });
    await screen.findByTestId('workspace-steps');
    act(() => handlers.onToolResult?.({ toolCallId: 'tu1' }));
    act(() => handlers.onText('That failed, so I will try another way.'));
    const said = await screen.findByText('That failed, so I will try another way.');
    // Once it has said something after the block, that block is finished.
    await waitFor(() => expect(screen.getByText('Ran a command')).toBeTruthy());
    act(() => handlers.onToolUse?.({ toolCallId: 'tu2', toolName: 'Read', detail: 'src/a.ts' }));
    await waitFor(() => expect(screen.getAllByTestId('workspace-steps')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('workspace-steps');
    // The message did not move: still between the two blocks, not in either.
    expect(first!.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(said.compareDocumentPosition(second!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(second!).getByText('Reading a.ts…')).toBeTruthy();
  });

  it('draws an artifact card as soon as the file is published, from the store', async () => {
    vi.mocked(workspaceApi.artifact).mockResolvedValue({
      artifactId: 'art1',
      agentId: 'a1',
      title: 'pelican bike',
      kind: 'image',
      extension: 'SVG',
      currentVersion: 1,
    } as never);
    let handlers!: StreamHandlers;
    await startTurn((h) => {
      handlers = h;
      h.onToolUse?.({ toolCallId: 'p1', toolName: 'artifact_publish' });
    });
    act(() => handlers.onToolResult?.({ toolCallId: 'p1' }));
    act(() => handlers.onArtifactClaim?.('art1'));
    // Mid-turn, before any `done`: the card is already there.
    await waitFor(() => expect(screen.getByText('pelican bike')).toBeTruthy());
    expect(workspaceApi.artifact).toHaveBeenCalledWith('art1');
  });

  it("never draws a claimed card the store says is another agent's", async () => {
    vi.mocked(workspaceApi.artifact).mockResolvedValue({
      artifactId: 'art2',
      agentId: 'someone-else',
      title: 'not yours',
      kind: 'image',
      extension: 'SVG',
      currentVersion: 1,
    } as never);
    let handlers!: StreamHandlers;
    await startTurn((h) => {
      handlers = h;
      h.onText('Working.');
    });
    act(() => handlers.onArtifactClaim?.('art2'));
    await waitFor(() => expect(workspaceApi.artifact).toHaveBeenCalledWith('art2'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('not yours')).toBeNull();
  });

  it('titles the running step with its summary, and lists it above the step', async () => {
    // The host's line for what the agent set out to do (Claude's
    // "Working out the leg motion with a script.") replaces the bare step name.
    let handlers!: StreamHandlers;
    await startTurn((h) => {
      handlers = h;
      h.onToolUse?.({ toolCallId: 'tu1', toolName: 'Bash', detail: 'node legs.js' });
    });
    await waitFor(() => expect(screen.getByText('Running a command…')).toBeTruthy());
    act(() => handlers.onStepSummary?.({ toolCallId: 'tu1', text: 'Working out the leg motion with a script.' }));
    const panel = await screen.findByTestId('workspace-steps');
    await waitFor(() => expect(within(panel).getByText('Working out the leg motion with a script.')).toBeTruthy());
    // Open the panel: the summary is ONE row, standing in for its step
    // rather than sitting on top of a "Ran a command" row.
    fireEvent.click(within(panel).getAllByText('Working out the leg motion with a script.')[0]!);
    const rows = () => within(panel).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows()).toEqual(['Working out the leg motion with a script.']);
    // Open the row: the step it stands for is inside.
    const row = within(panel).getAllByRole('listitem')[0]!;
    fireEvent.click(within(row).getByText('Working out the leg motion with a script.'));
    expect(within(row).getByText('node legs.js')).toBeTruthy();
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
