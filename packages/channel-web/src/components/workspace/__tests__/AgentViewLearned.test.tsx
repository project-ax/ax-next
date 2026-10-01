/**
 * "What I learned in this chat" as `AgentView` wires it (TASK-627): where the
 * block sits in the rail, and the parts that only exist because the rail is a
 * `Sheet` below `md` — the count on the toggle, the announcement while the
 * sheet is shut, and "from your message" closing the sheet before it jumps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  workspaceApi,
  type AgentDetail,
  type FactMemoryStatement,
  type MemoryEventFrame,
  type WorkspaceAgent,
} from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import type { AgentTab } from '@/lib/workspace-route';
import { MEMORY_SOURCE_ATTR, TURN_ID_ATTR } from '@/lib/thread-jump';
import { AgentView } from '../AgentView';
import {
  MEMORY_FIX_FIELD_LABEL,
  MEMORY_FIX_SAVE,
  MEMORY_USED_SINCE,
  memoryFixLabel,
  memoryStatementText,
  memoryUndoFixLabel,
  LEARNED_FROM_MY_REPLY,
  LEARNED_FROM_YOUR_MESSAGE,
  learnedSourceLabel,
  LEARNED_PAUSED,
  LEARNED_PAUSED_ACTION,
  LEARNED_SEE_ALL,
  LEARNED_TITLE,
  learnedAnnouncement,
  learnedToggleLabel,
} from '../memory-copy';
import { rail as railFixture } from './rail-fixture';
import { clearViewport, setViewport } from './viewport';

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
      recallMemory: vi.fn(),
      memoryEvents: vi.fn(),
      correctMemory: vi.fn(),
      uncorrectMemory: vi.fn(),
    },
  };
});

const agentMock = vi.mocked(workspaceApi.agent);
const recall = vi.mocked(workspaceApi.recallMemory);
const events = vi.mocked(workspaceApi.memoryEvents);
const correct = vi.mocked(workspaceApi.correctMemory);
const uncorrect = vi.mocked(workspaceApi.uncorrectMemory);

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: quill,
    conversationId: 'c-now',
    thread: [{ kind: 'user', id: 't1', text: 'I just moved to Denver' }],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null }, factsAvailable: true },
    ...over,
  };
}

function st(id: string, over: Partial<FactMemoryStatement> = {}): FactMemoryStatement {
  return {
    id,
    about: 'user',
    relation: 'lives_in',
    value: `v-${id}`,
    when: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

let push: (f: MemoryEventFrame) => void = () => {};

function renderView({
  role = 'user' as 'user' | 'admin',
  onTab = vi.fn<(t: AgentTab) => void>(),
  onOpenModelKeys = vi.fn(),
} = {}) {
  render(
    <UserProvider value={{ id: 'u1', email: 'u@example.com', name: 'Uma', role }}>
      <AgentView
        agentId="a-quill"
        tab="memory"
        onTab={onTab}
        decisions={[]}
        threadGrants={[]}
        onGrantResolved={() => {}}
        onGranted={async () => true}
        onApprove={async () => {}}
        onDismiss={async () => {}}
        onUndo={async () => {}}
        busyIds={new Set<string>()}
        notices={new Map<string, string>()}
        decisionsError={null}
        onDecisionRaised={() => {}}
        activity={[]}
        agents={[quill]}
        onBack={() => {}}
        onOpenModelKeys={onOpenModelKeys}
        version={0}
        pendingReply={null}
        onPendingReplyConsumed={() => {}}
        onChanged={async () => {}}
      />
    </UserProvider>,
  );
  return { onTab, onOpenModelKeys };
}

async function streamOpen() {
  await waitFor(() => expect(events).toHaveBeenCalled());
}

async function batch(all: FactMemoryStatement[]) {
  recall.mockResolvedValueOnce({ statements: all, degraded: [] });
  act(() => push({ kind: 'activity', state: 'recorded', statementIds: all.map((s) => s.id) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  agentMock.mockResolvedValue(detail());
  recall.mockResolvedValue({ statements: [], degraded: [] });
  events.mockImplementation((_c, onFrame) => {
    push = onFrame;
    return new Promise(() => {});
  });
});

afterEach(() => clearViewport());

describe('AgentView — "What I learned in this chat"', () => {
  it('shows the learned block in Memory and follows this conversation', async () => {
    renderView();
    await screen.findByText(LEARNED_TITLE);
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true');
    await streamOpen();
    expect(recall).toHaveBeenCalledWith('a-quill', { conversationId: 'c-now' });
    expect(events.mock.calls[0]?.[0]).toBe('c-now');
  });

  it('reads nothing when this workspace has no facts memory', async () => {
    agentMock.mockResolvedValue(
      detail({ memory: { rules: { status: 'unavailable', doc: null } } }),
    );
    renderView();
    await screen.findByText(LEARNED_TITLE);
    expect(recall).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it('See all memory opens the Memory tab', async () => {
    const { onTab } = renderView();
    fireEvent.click(await screen.findByRole('button', { name: LEARNED_SEE_ALL }));
    expect(onTab).toHaveBeenCalledWith('memory');
  });

  it('offers "Fix this" on paused memory to an admin only', async () => {
    const { onOpenModelKeys } = renderView({ role: 'admin' });
    await streamOpen();
    act(() => push({ kind: 'status', extraction: 'paused', conversation: 'idle' }));
    fireEvent.click(screen.getByRole('button', { name: LEARNED_PAUSED_ACTION }));
    expect(onOpenModelKeys).toHaveBeenCalledTimes(1);
  });

  it('does not offer "Fix this" to someone who cannot', async () => {
    renderView({ role: 'user' });
    await streamOpen();
    act(() => push({ kind: 'status', extraction: 'paused', conversation: 'idle' }));
    expect(screen.getByText(LEARNED_PAUSED)).toBeTruthy();
    expect(screen.queryByRole('button', { name: LEARNED_PAUSED_ACTION })).toBeNull();
  });
});

describe('AgentView — the block below md', () => {
  it('counts new memories on the rail toggle and announces them while the sheet is shut', async () => {
    setViewport(true);
    renderView();
    await streamOpen();
    await batch([st('a'), st('b')]);

    const toggle = await screen.findByRole('button', { name: learnedToggleLabel(2) });
    expect(within(toggle).getByText('2')).toBeTruthy();
    const region = document.querySelector('[data-learned-announcer]');
    await waitFor(() => expect(region?.textContent).toBe(learnedAnnouncement(2)));

    // Opening the sheet is what counts as seeing it.
    fireEvent.click(toggle);
    await screen.findByRole('dialog');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: learnedToggleLabel(2) })).toBeNull(),
    );
  });

  it('"from your message" closes the sheet, then highlights the message', async () => {
    setViewport(true);
    recall.mockResolvedValue({ statements: [st('a', { sourceTurnId: 't1' })], degraded: [] });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Agent details' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(await within(sheet).findByRole('button', { name: learnedSourceLabel('person', 'I just moved to Denver') }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const message = screen.getByTestId('workspace-user-message');
    await waitFor(() => expect(message.getAttribute(MEMORY_SOURCE_ATTR)).toBe('flash'));
  });

  /*
    TASK-642, measured on kind: a fact taken from the AGENT's reply read "from
    your message", and clicking it did nothing — only the person's bubble
    carried a turn id to jump to.
  */
  it('a fact from the agent’s reply says so, and its link lands on that reply', async () => {
    setViewport(false);
    agentMock.mockResolvedValue(
      detail({
        thread: [
          { kind: 'user', id: 't1', text: 'Our go-live moved to Oct 14' },
          { kind: 'agent', id: 't2', text: 'Got it — **Oct 14**.', at: '2026-09-28T06:38:00.000Z' },
        ],
      }),
    );
    recall.mockResolvedValue({
      statements: [st('echoed', { sourceTurnId: 't2' })],
      degraded: [],
    });
    renderView();
    const link = await screen.findByRole('button', {
      name: learnedSourceLabel('agent', 'Got it — Oct 14.'),
    });
    expect(link).toHaveTextContent(LEARNED_FROM_MY_REPLY);
    expect(screen.queryByRole('button', { name: new RegExp(`^${LEARNED_FROM_YOUR_MESSAGE}`) })).toBeNull();

    fireEvent.click(link);
    const reply = [...document.querySelectorAll(`[${TURN_ID_ATTR}]`)].find(
      (el) => el.getAttribute(TURN_ID_ATTR) === 't2',
    );
    expect(reply).toBeDefined();
    expect(reply).toHaveTextContent('Got it');
    await waitFor(() => expect(reply!.getAttribute(MEMORY_SOURCE_ATTR)).toBe('flash'));
  });
});

/*
  TASK-643, measured on kind (walk TASK-629): a Fix saved from the "Used N
  memories" chip updated the chip, but the rail kept the old row until a
  reload — the two surfaces each kept their own overlay. They now share one
  ledger, owned by `AgentView`.
*/
describe('AgentView — the chip and the rail share one set of fixes', () => {
  const boston = st('m1', { value: 'Boston', sourceTurnId: 't1' });
  const bostonText = memoryStatementText(boston);

  function withChip() {
    setViewport(false);
    agentMock.mockResolvedValue(
      detail({
        thread: [
          { kind: 'user', id: 't1', text: 'Where do I live?' },
          {
            kind: 'agent',
            id: 't2',
            text: 'Boston.',
            at: '2026-09-28T06:38:00.000Z',
            memoryUsed: { statements: [boston] },
          },
        ],
      }),
    );
    recall.mockResolvedValue({ statements: [boston], degraded: [] });
    correct.mockResolvedValue({ id: 'm1-fixed' });
    uncorrect.mockResolvedValue({ undone: true });
  }

  async function rail(): Promise<HTMLElement> {
    const title = await screen.findByText(LEARNED_TITLE);
    const section = title.closest('section');
    expect(section).not.toBeNull();
    return section as HTMLElement;
  }

  async function chip(): Promise<HTMLElement> {
    const el = await screen.findByTestId('workspace-memory-used');
    const trigger = within(el).getByRole('button', { name: /^Used / });
    if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
    return el;
  }

  async function saveFix(value: string) {
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(MEMORY_FIX_FIELD_LABEL), {
      target: { value },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FIX_SAVE }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  it('a fix saved from the chip shows in the rail at once, and its Undo puts the rail row back', async () => {
    withChip();
    renderView();
    const railEl = await rail();
    await within(railEl).findByText(bostonText);

    const chipEl = await chip();
    fireEvent.click(within(chipEl).getByRole('button', { name: memoryFixLabel('Boston') }));
    await saveFix('Denver');

    const fixedText = memoryStatementText({ ...boston, value: 'Denver' });
    expect(await within(railEl).findByText(fixedText)).toBeTruthy();
    expect(within(railEl).queryByText(bostonText)).toBeNull();
    // No re-read did it: the rail changed from the shared ledger alone.
    expect(recall.mock.calls.filter(([, options]) => options?.conversationId === 'c-now')).toHaveLength(1);
    expect(within(chipEl).getByText(MEMORY_USED_SINCE.replaced)).toBeTruthy();

    fireEvent.click(within(chipEl).getByRole('button', { name: memoryUndoFixLabel('Denver') }));
    await waitFor(() =>
      expect(uncorrect).toHaveBeenCalledWith('a-quill', { id: 'm1-fixed', restore: 'm1' }),
    );
    expect(await within(railEl).findByText(bostonText)).toBeTruthy();
    expect(within(railEl).queryByText(fixedText)).toBeNull();
    expect(within(chipEl).queryByText(MEMORY_USED_SINCE.replaced)).toBeNull();
  });

  it('a fix saved from the rail shows in the chip at once', async () => {
    withChip();
    renderView();
    const railEl = await rail();
    fireEvent.click(
      await within(railEl).findByRole('button', { name: memoryFixLabel(bostonText) }),
    );
    await saveFix('Denver');

    const chipEl = await chip();
    expect(within(chipEl).getByText(MEMORY_USED_SINCE.replaced)).toBeTruthy();
    expect(within(chipEl).queryByRole('button', { name: memoryFixLabel('Boston') })).toBeNull();
  });
});
