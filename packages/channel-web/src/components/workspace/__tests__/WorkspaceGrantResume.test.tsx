/**
 * Approving a grant starts the agent it stopped (TASK-374).
 *
 * THE FIXTURE GENUINELY STOPS A TURN, and that is the point of the file. A test
 * that seeded a grant into the store and then asserted "the turn is not parked"
 * would pass against a product that never parked anything. So the first half of
 * each case here drives a REAL turn through the shipped path — the composer
 * posts, `streamReply` delivers a `permissionRequest` frame and then the `done`
 * that ends the turn, exactly as the wire does — and only then answers the row.
 *
 * And what it asserts is that the turn CONTINUED: the model was re-invoked with
 * the text the person originally sent, in the conversation the grant was raised
 * on, and the reply that came back reached the screen. Not that a flag flipped.
 *
 * Deleting the resume — the `onGranted` call in `GrantRow`, or the shell's
 * `resumeAfterGrant` — reddens this file and nothing else in the suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { workspaceApi, type AgentDetail, type ThreadMessage } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import {
  getWorkspaceGrantSnapshot,
  workspaceGrantActions,
} from '@/lib/workspace-grant-store';
import { GRANT_NOT_RESUMED } from '@/lib/grant-copy';
import type { StreamHandlers } from '@/lib/workspace-api';
import type { PermissionRequest } from '@/server/types';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(),
      decisions: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const boardMock = vi.mocked(workspaceApi.board);
const agentMock = vi.mocked(workspaceApi.agent);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const grantsMock = vi.mocked(workspaceApi.grants);
const sendMock = vi.mocked(workspaceApi.sendMessage);
const streamMock = vi.mocked(workspaceApi.streamReply);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

const agentRow = (id: string, name: string) => ({
  id,
  name,
  state: 'resting' as const,
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
});

const QUILL = agentRow('a-quill', 'Quill');
const SCOUT = agentRow('a-scout', 'Scout');

/** The words the person types, and the only text a resume may re-send. */
const ASK = 'file my open Linear issues';
/** What the agent says as it stops. Deliberately the LAST thread message. */
const STOPPED = 'I have asked for access to Linear.';
/** What comes back once it is started again. Only ever produced by a resume. */
const ANSWER = 'Filed three issues.';

/**
 * A skill grant whose key is ALREADY SAVED, so Connect is live on first render
 * and answering it is one click with nothing to type. Same fixture shape as
 * `WorkspaceGrantPresence.test.tsx`, for the same reason.
 */
const linearSkill = (): PermissionRequest => ({
  kind: 'skill',
  skillId: 'linear',
  description: 'File and read Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key', account: 'linear', haveExisting: true }],
});

/** The reactive egress wall, which stops nothing and must start nothing. */
const hostWall = (): PermissionRequest => ({
  kind: 'host',
  host: 'example.org',
  sessionId: 'sess-9',
});

const detailFor = (
  agent: ReturnType<typeof agentRow>,
  conversationId: string | null,
  thread: ThreadMessage[],
): AgentDetail => ({
  agent,
  conversationId,
  thread,
  decisions: { status: 'ok' },
  past: [],
  memory: [],
});

/**
 * What the server would hold after the asking turn: the person's message, then
 * the agent saying it has asked. This is what a resume has to read back, and
 * the agent line being last is why it cannot just take the final message.
 */
const stoppedThread = (): ThreadMessage[] => [
  { kind: 'user', id: 't1', text: ASK },
  { kind: 'agent', id: 't2', text: STOPPED, time: '10:04' },
];

/** Per-conversation transcript, as the server would hold it. Mutated as turns land. */
let threads: Record<string, ThreadMessage[]>;
/** `reqId` → what that stream does. An unscripted reqId is a bug, so it throws. */
let scripts: Map<string, (h: StreamHandlers) => void>;

/** `document.visibilityState` — half the presence rule, so it is pinned. */
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => 'visible',
});

function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

/** Answer whichever grant row is on screen. One click — the key is vaulted. */
function connect() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  workspaceGrantActions.resetForTest();
  threads = { 'cnv-1': [], 'cnv-2': stoppedThread() };
  scripts = new Map();

  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [QUILL, SCOUT] });
  agentMock.mockReset();
  agentMock.mockImplementation(async (id: string, conversationId?: string) => {
    const agent = id === 'a-scout' ? SCOUT : QUILL;
    const current = id === 'a-scout' ? 'cnv-2' : 'cnv-1';
    const target = conversationId ?? current;
    return detailFor(agent, target, threads[target] ?? []);
  });
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  grantsMock.mockReset();
  grantsMock.mockResolvedValue({ grants: [] });
  sendMock.mockReset();
  streamMock.mockReset();
  streamMock.mockImplementation(async (reqId: string, h: StreamHandlers) => {
    const script = scripts.get(reqId);
    if (script === undefined) throw new Error(`unscripted stream: ${reqId}`);
    script(h);
  });

  // Every POST this surface makes in these tests — the decision, and any
  // credential write — succeeds. What is under test is what happens AFTER it.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Send a message to Quill and let the turn stop on a capability request, the
 * way the wire actually does it: the frame, then `done`.
 *
 * Returns once the grant is on screen in the thread. `request` is a parameter so
 * the `host` case can travel the identical path — the difference then is in the
 * answer, not in how the turn stopped.
 */
async function stopATurn(request: PermissionRequest): Promise<void> {
  sendMock.mockResolvedValueOnce({ conversationId: 'cnv-1', reqId: 'req-ask' });
  scripts.set('req-ask', (h) => {
    h.onPermissionRequest?.(request);
    // The turn ENDS here. `request_capability` returned to the model, the model
    // said it had asked, and `chat:turn-end` fired. Nothing is waiting to be
    // attached to — which is the whole reason this task exists.
    threads['cnv-1'] = stoppedThread();
    h.onDone();
  });

  renderAt('/workspace/agents/a-quill/chat');
  const box = await screen.findByPlaceholderText('Message Quill');
  fireEvent.change(box, { target: { value: ASK } });
  fireEvent.keyDown(box, { key: 'Enter' });

  // The agent really has stopped: its closing line is in the durable thread.
  expect(await screen.findByText(STOPPED)).toBeInTheDocument();
  await screen.findByTestId('thread-grants');
}

describe('a grant answered in the thread', () => {
  it('re-invokes the model with the parked turn and the answer lands', async () => {
    await stopATurn(linearSkill());
    // The positive control for the assertion below: the answer is NOT on screen
    // before the grant is answered, so finding it afterwards means a turn ran.
    expect(screen.queryByText(ANSWER)).toBeNull();

    sendMock.mockResolvedValueOnce({ conversationId: 'cnv-1', reqId: 'req-resume' });
    scripts.set('req-resume', (h) => {
      threads['cnv-1'] = [
        ...stoppedThread(),
        { kind: 'user', id: 't3', text: ASK },
        { kind: 'agent', id: 't4', text: ANSWER, time: '10:06' },
      ];
      h.onText(ANSWER);
      h.onDone();
    });

    connect();

    /*
      THE RE-INVOCATION. Two facts, and the conversation id is the sharper one:
      a resume that started a FRESH conversation (`conversationId: null`, which
      is what `startTurn` passes) would still post the right text and still
      stream a reply, and the answer would land somewhere nobody was looking.
    */
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock).toHaveBeenLastCalledWith({
      agentId: 'a-quill',
      conversationId: 'cnv-1',
      text: ASK,
    });

    // THE OUTPUT REACHED THE TRANSCRIPT. This is only on screen because the
    // shell handed the resumed turn to the panel to stream; a resume that
    // posted and dropped the reqId would pass everything above and fail here.
    expect(await screen.findByText(ANSWER)).toBeInTheDocument();
    expect(streamMock).toHaveBeenCalledWith('req-resume', expect.anything());

    // And the question is finished with, on both render sites at once.
    await waitFor(() =>
      expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0),
    );
    expect(screen.queryByTestId('thread-grants')).toBeNull();
  });

  it('says so, and keeps the row, when it cannot start the agent again', async () => {
    await stopATurn(linearSkill());

    // The conversation read behind the resume fails. The GRANT still landed —
    // that POST succeeded — so this is the state the person must be told about
    // rather than the state the row used to vanish in.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    agentMock.mockRejectedValue(new Error('boom'));

    connect();

    expect(await screen.findByText(GRANT_NOT_RESUMED)).toBeInTheDocument();
    // Nothing was posted on a read that failed, and the row is still here to
    // carry the sentence.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getWorkspaceGrantSnapshot().grants).toHaveLength(1);

    // The way out clears it, and only then.
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() =>
      expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0),
    );
  });

  it('leaves a host wall exactly as it was', async () => {
    /*
      The egress wall never stopped the agent — `/api/chat/allow-host` widens the
      LIVE session's allowlist and the proxy already answered the blocked request
      — so there is no turn to re-issue and a resume here would post a duplicate
      message into a conversation that never asked for one.
    */
    await stopATurn(hostWall());

    fireEvent.click(screen.getByRole('button', { name: 'Just this once' }));

    await waitFor(() =>
      expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0),
    );
    // One send in this test: the message that started the turn. No resume.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('a grant answered on Today, for an agent nobody is looking at', () => {
  it('starts that agent in ITS OWN conversation, and stays on Today', async () => {
    /*
      The case the thread-only wiring could never serve, and the common one:
      most grants are raised by an agent working unattended. The row is seeded
      through the mount read-back — the shipped producer for a grant raised
      while the workspace was closed — so nothing here is poked into the store.
    */
    grantsMock.mockResolvedValue({
      grants: [
        { conversationId: 'cnv-2', agentId: 'a-scout', request: linearSkill() },
      ],
    });
    sendMock.mockResolvedValueOnce({ conversationId: 'cnv-2', reqId: 'req-scout' });

    renderAt('/workspace');
    await screen.findByTestId('grant-skill:linear');

    connect();

    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    // Scout's conversation and Scout's own last message — read back from the
    // grant's conversation, not from whatever the open route happens to be.
    expect(sendMock).toHaveBeenCalledWith({
      agentId: 'a-scout',
      conversationId: 'cnv-2',
      text: ASK,
    });
    expect(agentMock).toHaveBeenCalledWith('a-scout', 'cnv-2');

    /*
      AND THE READER IS NOT MOVED. Answering one row in a queue must not cost
      someone their place in it — there may be more rows under this one. The
      turn runs server-side whether or not a panel is streaming it, so there is
      nothing to follow them for.
    */
    expect(window.location.pathname).toBe('/workspace');
    expect(screen.queryByTestId('thread-grants')).toBeNull();
    // No stream was opened either: with no panel on screen there is nobody to
    // stream to, and staging the reqId for a panel that mounts later would
    // re-open a long-dead turn.
    expect(streamMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(getWorkspaceGrantSnapshot().grants).toHaveLength(0),
    );
  });
});
