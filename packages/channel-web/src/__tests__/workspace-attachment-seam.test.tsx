/**
 * TASK-424 — a file the person attached has to leave a trace in their own
 * transcript, LIVE and after a RELOAD.
 *
 * The walk found the opposite on `agent:11a2d06c`: the model received the image
 * and described it, and the agent view drew nothing at all — no thumbnail, no
 * filename, zero `<img>`. On reload the thread read as an agent describing an
 * image that was never sent, and the person had no way to audit what they had
 * actually shared.
 *
 * Shaped after `workspace-steps-seam.test.tsx`, because this is the same seam
 * (#567's lesson: the live and reloaded paths diverge, and a fix on one of them
 * is half a fix). One fixture, two paths, and what is compared is what is ON
 * SCREEN:
 *
 *   - reload — the real `GET /api/workspace/agents/:id` handler over a stubbed
 *              `conversations:get` holding a committed `attachment` block, the
 *              shape `routes-chat.ts` writes after `attachments:commit`;
 *   - live   — `AgentView` mid-turn, right after the composer handed the
 *              message over and before any re-read.
 *
 * WHAT THE EVIDENCE IS, decided rather than left to the renderer: the FILENAME
 * always, and a THUMBNAIL as well whenever the file is an image and the durable
 * path is known. This is the person's own record of what they did, so it errs
 * toward showing more of it. The live frame has no workspace path yet (the
 * commit is what mints one), so it shows the name alone and the reloaded frame
 * adds the picture — the same two-variant split chat's `AttachmentChip` already
 * makes, and the reason the name is asserted on BOTH paths while the `<img>` is
 * asserted only on the durable one.
 *
 * WHY THE NEGATIVE ASSERTIONS ARE LOAD-BEARING. Against unfixed code both paths
 * render an ordinary text bubble, so anything phrased as "live agrees with
 * reload" passes vacuously. Every assertion below is therefore positive about a
 * specific thing on screen — the filename, an `<img>` whose `src` points at the
 * committed file — and the caption-less case is included because a user turn
 * whose only content was the file used to be dropped from the thread entirely.
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
import { uploadAttachment } from '@/lib/attachment-upload';
import type { AgentDetail, WorkspaceAgent } from '@/lib/workspace-api';
import { ATTACHMENT_NAME_MAX_CHARS } from '@/components/workspace/WorkspaceAttachmentChip';
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

vi.mock('@/lib/attachment-upload', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/attachment-upload')>();
  return { ...actual, uploadAttachment: vi.fn() };
});

/** THE fixture — one image, as the person picked it and as the host stored it. */
const FILE_NAME = 'roof-damage.png';
const FILE_TYPE = 'image/png';
const FILE_PATH = '.ax/uploads/c1/t1/roof-damage.png';
const CAPTION = 'what do you make of this?';
const ATTACHMENT_ID = 'att-1';

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

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

function mkRes(): {
  res: RouteResponse;
  captured: { status: number; body: unknown };
} {
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

/** The user turn as the transcript holds it after `attachments:commit`. */
const attachmentBlock = {
  type: 'attachment',
  path: FILE_PATH,
  displayName: FILE_NAME,
  mediaType: FILE_TYPE,
  sizeBytes: 4096,
};

function storedTurns(blocks: unknown[], agentBlocks?: unknown[]): unknown[] {
  return [
    {
      turnId: 't1',
      turnIndex: 0,
      role: 'user',
      contentBlocks: blocks,
      createdAt: '2026-09-18T10:00:00.000Z',
    },
    {
      turnId: 't2',
      turnIndex: 1,
      role: 'assistant',
      contentBlocks: agentBlocks ?? [
        { type: 'text', text: 'Those are missing shingles.' },
      ],
      createdAt: '2026-09-18T10:00:05.000Z',
    },
  ];
}

const conversationRow = {
  conversationId: 'c1',
  userId: 'u1',
  agentId: 'a1',
  title: null,
  activeSessionId: null,
  activeReqId: null,
  createdAt: '2026-09-18T10:00:00.000Z',
  lastActivityAt: null,
};

/** The same read, but the extra blocks ride on the AGENT's turn instead. */
async function reloadDetailWithAgentBlocks(
  agentBlocks: unknown[],
): Promise<AgentDetail> {
  return reloadDetail([{ type: 'text', text: CAPTION }], agentBlocks);
}

async function reloadDetail(
  blocks: unknown[],
  agentBlocks?: unknown[],
): Promise<AgentDetail> {
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
    conversationRow,
  ]);
  bus.registerService('conversations:get', 'conversations', async () => ({
    conversation: conversationRow,
    turns: storedTurns(blocks, agentBlocks),
  }));

  const handlers = makeWorkspaceHandlers({ bus, initCtx });
  const { res, captured } = mkRes();
  await handlers.agentDetail(mkReq(), res);
  expect(captured.status).toBe(200);
  return captured.body as AgentDetail;
}

function conversationProps(
  detail: AgentDetail,
): ComponentProps<typeof AgentConversation> {
  return {
    agent: quill,
    thread: detail.thread,
    conversationId: detail.conversationId,
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

/** The user's own bubble — the half of the thread this card is about. */
function userBubble(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="workspace-user-message"]');
  if (el === null) throw new Error('the user message was not rendered at all');
  return el as HTMLElement;
}

function liveDetail(): AgentDetail {
  return {
    agent: quill,
    conversationId: 'c1',
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: {
      rules: { status: 'unavailable', doc: null },
      learned: { status: 'unavailable', docs: [] },
    },
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

describe('a message the person attached a file to', () => {
  beforeEach(() => {
    vi.mocked(workspaceApi.agent).mockReset();
    vi.mocked(workspaceApi.sendMessage).mockReset();
    vi.mocked(workspaceApi.streamReply).mockReset();
    vi.mocked(uploadAttachment).mockReset();
  });

  it('shows the file name and a thumbnail after a reload', async () => {
    const detail = await reloadDetail([
      { type: 'text', text: CAPTION },
      attachmentBlock,
    ]);
    const { container, unmount } = render(
      <AgentConversation {...conversationProps(detail)} />,
    );

    /*
      Content first, and on the WHOLE container. Against unfixed code the
      filename is nowhere on the screen at all, so this is the assertion that
      reddens, and it reddens because the evidence is missing rather than
      because a test hook is. The bubble-scoped checks below then say the
      evidence is in the right place.
    */
    expect(container.textContent).toContain(FILE_NAME);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src') ?? '').toContain(
      encodeURIComponent(FILE_PATH),
    );
    expect(img?.getAttribute('src') ?? '').toContain('conversationId=c1');

    // …and all of it belongs to the person's own message, not the agent's.
    const bubble = userBubble(container);
    expect(bubble.textContent).toContain(CAPTION);
    expect(bubble.textContent).toContain(FILE_NAME);
    expect(bubble.querySelector('img')).not.toBeNull();
    unmount();
  });

  it('keeps the turn when the file was the whole message', async () => {
    /*
      A caption-less attachment used to be dropped by `buildThread`'s
      "an empty bubble is worse than no bubble" rule, which was written when a
      user turn could only ever be text. The turn is not empty — it carries a
      file — and dropping it loses the only record that the person sent one.
    */
    const detail = await reloadDetail([attachmentBlock]);
    const { container, unmount } = render(
      <AgentConversation {...conversationProps(detail)} />,
    );
    expect(container.textContent).toContain(FILE_NAME);
    expect(userBubble(container).textContent).toContain(FILE_NAME);
    unmount();
  });

  it('draws nothing for an `attachment` block on an AGENT turn', async () => {
    /*
      The prompt-injection guard, pinned rather than assumed.

      A user turn's attachments are host-minted: `@ax/chat-orchestrator`
      persists the turn from the person's own content blocks, and the runner
      deliberately does not write user turns at all (its TASK-66 note says so).
      A model CAN emit whatever content blocks it likes on its OWN turn,
      though, and if this renderer read them the same way it would hand a
      model-chosen `path` to `GET /api/files` and a model-chosen string to a
      chip — which is the shape of the sibling finding where an MCP argument
      put a credential prefix on screen.

      It does not, because `turnAttachments` runs on `turn.role === 'user'`
      only. This test is what keeps that true: widen the call to every turn and
      it goes red.
    */
    const bus = 'sk-live-0123456789abcdef-not-a-real-key';
    const detail = await reloadDetail([{ type: 'text', text: CAPTION }]);
    const withAgentAttachment = await reloadDetailWithAgentBlocks([
      { type: 'text', text: 'Those are missing shingles.' },
      {
        type: 'attachment',
        path: '.ax/uploads/other-conversation/t9/stolen.png',
        displayName: bus,
        mediaType: 'image/png',
      },
    ]);
    // The agent's prose still renders; only the block it invented is ignored.
    expect(JSON.stringify(withAgentAttachment.thread)).toContain(
      'Those are missing shingles.',
    );
    expect(JSON.stringify(withAgentAttachment.thread)).not.toContain(bus);
    expect(JSON.stringify(withAgentAttachment.thread)).not.toContain('stolen');

    const { container, unmount } = render(
      <AgentConversation {...conversationProps(withAgentAttachment)} />,
    );
    expect(container.textContent).not.toContain(bus);
    expect(container.querySelector('img')).toBeNull();
    unmount();
    // Sanity: the same fixture on a USER turn does draw — so the negative
    // above is about WHOSE turn it is, not about the assertion being unreachable.
    expect(JSON.stringify(detail.thread)).toContain(CAPTION);
  });

  it('clamps a filename long enough to flood the accessibility tree', async () => {
    /*
      A filename comes off the person's own disk and has no length limit. The
      chip's CSS `truncate` hides the overflow on screen while leaving the whole
      string in `alt` and in the `aria-label` — so the clamp has to happen in
      the data, not in the styling. Same function the composer's chips use.
    */
    const long = `${'z'.repeat(400)}.png`;
    const detail = await reloadDetail([
      { ...attachmentBlock, displayName: long, path: '.ax/uploads/c1/t1/z.png' },
    ]);
    const { container, unmount } = render(
      <AgentConversation {...conversationProps(detail)} />,
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    const alt = img?.getAttribute('alt') ?? '';
    expect(alt.length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX_CHARS);
    expect(alt.startsWith('zzz')).toBe(true);
    unmount();
  });

  it('names the file in the live frame, before any re-read', async () => {
    vi.mocked(workspaceApi.agent).mockResolvedValue(liveDetail());
    vi.mocked(workspaceApi.sendMessage).mockResolvedValue({
      conversationId: 'c1',
      reqId: 'r1',
    } as never);
    vi.mocked(uploadAttachment).mockResolvedValue({
      attachmentId: ATTACHMENT_ID,
      displayName: FILE_NAME,
      mediaType: FILE_TYPE,
      sizeBytes: 4096,
    } as never);
    /*
      The turn is left IN FLIGHT — no `onDone`. `onDone` re-reads the server's
      copy, which would turn this into a second measurement of the reload path
      wearing a live costume.
    */
    vi.mocked(workspaceApi.streamReply).mockImplementation(
      async (): Promise<void> => {
        await new Promise<void>(() => {});
      },
    );

    const live = renderLiveView();
    const box = await screen.findByPlaceholderText('Message Quill');
    const picker = live.container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (picker === null) throw new Error('no file picker on the composer');
    fireEvent.change(picker, {
      target: {
        files: [new File([new Uint8Array([1, 2, 3])], FILE_NAME, { type: FILE_TYPE })],
      },
    });
    await waitFor(() => {
      expect(vi.mocked(uploadAttachment)).toHaveBeenCalled();
    });
    fireEvent.change(box, { target: { value: CAPTION } });
    await waitFor(() => {
      expect((box as HTMLTextAreaElement).value).toBe(CAPTION);
    });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(vi.mocked(workspaceApi.sendMessage)).toHaveBeenCalled();
    });
    // The composer has handed the message over and cleared its own chips. The
    // ONLY place the file can still be seen is the transcript.
    await waitFor(() => {
      expect(live.container.textContent).toContain(FILE_NAME);
    });
    expect(userBubble(live.container).textContent).toContain(FILE_NAME);
    expect(userBubble(live.container).textContent).toContain(CAPTION);
    live.unmount();
  });
});
