/**
 * The seam this card exists to close: a turn that ran tools must read the same
 * LIVE and after a RELOAD.
 *
 * One fixture, two paths, one assertion that they agree:
 *
 *   - live   — `AgentView` streaming, `workspaceApi.streamReply` firing the
 *              `tool-use` / `tool-result` / `text` callbacks;
 *   - reload — the real `GET /api/workspace/agents/:id` handler over a stubbed
 *              `conversations:get` holding the same calls as stored blocks.
 *
 * Both are rendered through the real `AgentConversation`, and what is compared
 * is what is ON SCREEN — the header sentence and the step rows — not two
 * in-memory objects that happen to be shaped alike.
 *
 * WHY THE COUNT ASSERTION IS NOT DECORATION. Against the unfixed code both
 * paths render nothing, so "live equals reload" passes vacuously — which is
 * exactly how this card's original acceptance criterion was unsatisfiable. The
 * count is read OUT OF THE RENDERED HEADER and checked against the rendered
 * rows, so an empty panel fails on the header lookup before the equality ever
 * runs. Verified by mutation: revert `buildThread`'s steps branch and this file
 * goes red.
 */
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import { makeWorkspaceHandlers } from '@/server/routes-workspace';
import type { RouteRequest, RouteResponse } from '@/server/routes-chat';
import { AgentConversation } from '@/components/workspace/AgentConversation';
import { AgentView } from '@/components/workspace/AgentView';
import { workspaceApi } from '@/lib/workspace-api';
import type {
  AgentDetail,
  ThreadMessage,
  WorkspaceAgent,
} from '@/lib/workspace-api';
import { rail as railFixture } from '@/components/workspace/__tests__/rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
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

/**
 * THE fixture. Both paths are derived from this one list, so the test cannot
 * accidentally compare a live rendering of one turn with a reloaded rendering
 * of a different one.
 *
 * The first call carries a host-authored phrase and an `mcp__`-namespaced wire
 * name (nobody should read `mcp__linear__create_issue` on screen); the second
 * carries no phrase, so it falls back to the bare tool name.
 */
const CALLS = [
  {
    id: 'tu1',
    name: 'mcp__linear__create_issue',
    phrase: 'Filing a Linear issue',
  },
  { id: 'tu2', name: 'Bash', phrase: undefined },
] as const;

const REPLY = 'Filed it, and the build is green.';
/** Never rendered on this surface — invariant J4. Present so the test can look. */
const SCRATCHPAD = 'the user probably wants me to guess here';

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/** What is drawn: the panel's header sentence and its rows, in order. */
interface RenderedPanel {
  label: string;
  steps: string[];
}

function readPanel(container: HTMLElement): RenderedPanel {
  const panel = container.querySelector('[data-testid="workspace-steps"]');
  if (panel === null) throw new Error('no step panel was rendered');
  const trigger = panel.querySelector('button');
  if (trigger === null) throw new Error('the step panel has no header');
  return {
    label: (trigger.textContent ?? '').trim(),
    steps: [...panel.querySelectorAll('li')].map((li) =>
      (li.textContent ?? '').trim(),
    ),
  };
}

/** The count the header REPORTS, read back out of the header itself. */
function reportedCount(label: string): number {
  const m = /^(\d+) steps?\b/.exec(label);
  if (m === null) throw new Error(`header does not report a count: "${label}"`);
  return Number(m[1]);
}

function conversationProps(
  thread: ThreadMessage[],
): ComponentProps<typeof AgentConversation> {
  return {
    agent: quill,
    thread,
    decisions: [],
    readOnly: false,
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    approvalRead: 'ok',
    onRetryApprovals: vi.fn(),
    grants: [],
    onGrantResolved: vi.fn(),
    onGranted: vi.fn(async () => true),
  };
}

// ---------------------------------------------------------------------------
// The reload path: the real route handler over a stubbed transcript.
// ---------------------------------------------------------------------------

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function mkReq(): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params: { agentId: 'a1' },
    signedCookie: () => null,
  } as unknown as RouteRequest;
}

function mkRes(): { res: RouteResponse; captured: { status: number; body: unknown } } {
  const captured = { status: 0, body: undefined as unknown };
  const res = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text() {},
    end() {},
  } as unknown as RouteResponse;
  return { res, captured };
}

/** The same two calls, as the transcript stores them. */
function storedTurns(): unknown[] {
  return [
    {
      turnId: 't1',
      turnIndex: 0,
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'file that issue' }],
      createdAt: '2026-09-17T10:00:00.000Z',
    },
    {
      turnId: 't2',
      turnIndex: 1,
      role: 'assistant',
      contentBlocks: [
        { type: 'thinking', thinking: SCRATCHPAD },
        ...CALLS.map((c) => ({
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: {},
          ...(c.phrase === undefined ? {} : { activityPhrase: c.phrase }),
        })),
        { type: 'text', text: REPLY },
      ],
      createdAt: '2026-09-17T10:00:05.000Z',
    },
    {
      turnId: 't3',
      turnIndex: 2,
      role: 'tool',
      contentBlocks: CALLS.map((c) => ({
        type: 'tool_result',
        tool_use_id: c.id,
        content: [{ type: 'text', text: 'ok' }],
      })),
      createdAt: '2026-09-17T10:00:07.000Z',
    },
  ];
}

async function reloadThread(): Promise<ThreadMessage[]> {
  const bus = new HookBus();
  const notFound = (): PluginError =>
    new PluginError({ code: 'not-found', plugin: 'test', message: 'nope' });
  bus.registerService('auth:require-user', 'auth', async () => ({
    user: { id: 'u1', isAdmin: false },
  }));
  bus.registerService('agents:list-for-user', 'agents', async () => ({
    agents: [{ id: 'a1', displayName: 'Quill', visibility: 'personal' }],
  }));
  bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
    if ((i as { agentId: string }).agentId !== 'a1') throw notFound();
    return { agent: { id: 'a1', displayName: 'Quill', visibility: 'personal' } };
  });
  bus.registerService('conversations:list', 'conversations', async () => [
    {
      conversationId: 'c1',
      userId: 'u1',
      agentId: 'a1',
      title: null,
      activeSessionId: null,
      activeReqId: null,
      createdAt: '2026-09-17T10:00:00.000Z',
      lastActivityAt: null,
    },
  ]);
  bus.registerService('conversations:get', 'conversations', async () => ({
    conversation: {
      conversationId: 'c1',
      userId: 'u1',
      agentId: 'a1',
      title: null,
      activeSessionId: null,
      activeReqId: null,
      createdAt: '2026-09-17T10:00:00.000Z',
      lastActivityAt: null,
    },
    turns: storedTurns(),
  }));

  const handlers = makeWorkspaceHandlers({ bus, initCtx });
  const { res, captured } = mkRes();
  await handlers.agentDetail(mkReq(), res);
  expect(captured.status).toBe(200);
  return (captured.body as { thread: ThreadMessage[] }).thread;
}

// ---------------------------------------------------------------------------
// The live path: AgentView, mid-turn.
// ---------------------------------------------------------------------------

function liveDetail(): AgentDetail {
  return {
    agent: quill,
    conversationId: 'c1',
    thread: [{ kind: 'user', id: 't1', text: 'file that issue' }],
    decisions: { status: 'ok' },
    past: [],
    memory: [],
  } as unknown as AgentDetail;
}

function renderLiveView(): ReturnType<typeof render> {
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

describe('a turn that ran tools', () => {
  beforeEach(() => {
    vi.mocked(workspaceApi.agent).mockReset();
    vi.mocked(workspaceApi.sendMessage).mockReset();
    vi.mocked(workspaceApi.streamReply).mockReset();
  });

  it('reads the same live and on reload, and its header counts what it shows', async () => {
    // ---- reload -----------------------------------------------------------
    const thread = await reloadThread();
    const reloaded = render(<AgentConversation {...conversationProps(thread)} />);
    const onReload = readPanel(reloaded.container);
    reloaded.unmount();

    // ---- live -------------------------------------------------------------
    vi.mocked(workspaceApi.agent).mockResolvedValue(liveDetail());
    vi.mocked(workspaceApi.sendMessage).mockResolvedValue({
      conversationId: 'c1',
      reqId: 'r1',
    } as never);
    /*
      The turn is deliberately left IN FLIGHT — no `onDone`. `onDone` clears the
      transient turn and re-reads the server's copy, which would turn this into
      a second measurement of the reload path wearing a live costume.
    */
    vi.mocked(workspaceApi.streamReply).mockImplementation(
      async (_reqId: string, h): Promise<void> => {
        for (const c of CALLS) {
          h.onToolUse?.({
            toolCallId: c.id,
            toolName: c.name,
            activityPhrase: c.phrase,
          });
        }
        for (const c of CALLS) h.onToolResult?.({ toolCallId: c.id });
        h.onText(REPLY);
        await new Promise<void>(() => {});
      },
    );

    const live = renderLiveView();
    const box = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box, { target: { value: 'file that issue' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(
        live.container.querySelector('[data-testid="workspace-steps"]'),
      ).not.toBeNull();
    });
    const onLive = readPanel(live.container);

    // ---- the seam ---------------------------------------------------------
    expect(onLive.label).toBe(onReload.label);
    expect(onLive.steps).toEqual(onReload.steps);

    // The header's own number, against the rows actually drawn. This is what
    // fails first against the unfixed code.
    expect(reportedCount(onReload.label)).toBe(onReload.steps.length);
    expect(reportedCount(onLive.label)).toBe(onLive.steps.length);
    expect(onLive.steps).toHaveLength(CALLS.length);

    // The wire name never reaches the screen; the host's phrase does.
    expect(onLive.steps[0]).toBe('Filing a Linear issue');
    expect(onLive.steps[1]).toBe('Bash');
    expect(live.container.textContent).not.toContain('mcp__');

    // And the model's scratchpad reaches neither path (invariant J4).
    expect(JSON.stringify(thread)).not.toContain(SCRATCHPAD);
    expect(live.container.textContent).not.toContain(SCRATCHPAD);
    live.unmount();
  });
});
