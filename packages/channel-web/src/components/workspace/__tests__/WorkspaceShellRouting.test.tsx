/**
 * The workspace's URL, from the shell's side.
 *
 * `workspace-route.test.ts` pins the grammar; this pins that the shell
 * actually uses it — that a deep link opens what it names, that navigating
 * leaves an address behind, and that Back unwinds inside the workspace
 * instead of leaving it.
 *
 * Everything here mounts at a real `window.location`, so each test sets one
 * and the shared `beforeEach` puts it back. jsdom keeps one location per
 * FILE: without the reset, a test that drills into an agent leaves the next
 * one mounting on that agent's URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { uploadAttachment, type AttachmentUploadResult } from '@/lib/attachment-upload';
import { workspaceApi, type FactMemoryStatement } from '@/lib/workspace-api';
import { HttpError } from '@/lib/http';
import type { TaskCheckin, TaskDetail } from '@/lib/workspace-types';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { rail as railFixture } from './rail-fixture';
import { clearViewport, setViewport } from './viewport';

import { LEARNED_SEE_ALL, LEARNED_TITLE, MEMORY_FIX_FIELD_LABEL, MEMORY_FIX_SAVE, MEMORY_FORGET, memoryFixLabel, memoryForgetLabel, memoryStatementText, memoryUndoLabel } from '../memory-copy';

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
      decisions: vi.fn(),
      conversationDecisions: vi.fn(async () => ({decisions: []})),
      tasks: vi.fn(),
      task: vi.fn(),
      taskCheckin: vi.fn(),
      duplicateTask: vi.fn(),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      // TASK-373 — the shell's mount read-back; nothing in this file raises a
      // grant, so an empty page keeps every subject out of the render.
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      saveRules: vi.fn(),
      recallMemory: vi.fn(),
      memoryEvents: vi.fn(() => new Promise(() => {})),
      correctMemory: vi.fn(),
      forgetMemory: vi.fn(),
      unforgetMemory: vi.fn(),
      connectors: vi.fn(async () => ({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true })),
      abilities: vi.fn(async () => ({ abilities: {} })),
    },
  };
});

vi.mock('@/lib/attachment-upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachment-upload')>();
  return { ...actual, uploadAttachment: vi.fn() };
});

const boardMock = vi.mocked(workspaceApi.board);
const agentMock = vi.mocked(workspaceApi.agent);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const tasksMock = vi.mocked(workspaceApi.tasks);
const taskMock = vi.mocked(workspaceApi.task);
const taskCheckinMock = vi.mocked(workspaceApi.taskCheckin);
const duplicateMock = vi.mocked(workspaceApi.duplicateTask);
const saveRulesMock = vi.mocked(workspaceApi.saveRules);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

/** Quill's one task, never reported, as the task page reads it. */
const TASK_DETAIL: TaskDetail = {
  agentName: 'Quill',
  name: 'Zero open support tickets',
  kind: 'stay-on-top',
  enabled: true,
  revision: 'rev-1',
  permissions: { fire: true, stop: true, edit: true },
  schedule: 'every hour',
  nextCheckAt: null,
  brief: { promptBody: 'Keep the support queue empty.', goodWhen: null },
  task: null,
  steps: [],
  finishBy: null,
  noRecentUpdate: null,
  doneAt: null,
  updates: [],
  replies: [],
};

/** Quill's one check-in, as its own page reads it. */
const CHECKIN: TaskCheckin = {
  taskName: 'Zero open support tickets',
  agentName: 'Quill',
  checkIn: {
    firedAt: new Date(2026, 9, 22, 10, 2).toISOString(),
    status: 'ok',
    error: null,
    report: { status: 'needs-you', update: '3 open.', reading: null },
    conversationId: 'c1',
  },
  triggerSource: 'tick',
  thread: [],
  decisions: { status: 'ok' },
};

const AGENTS = [
  {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting' as const,
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  },
];

/** Mount at `path`, as a browser landing there would. */
function renderAt(path: string, onOpenAdminSettings?: (tab?: import('../../admin/AdminSidebar').AdminTabId) => void) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell onOpenAdminSettings={onOpenAdminSettings} />
    </UserProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.mocked(uploadAttachment).mockReset();
  vi.mocked(workspaceApi.connectors).mockResolvedValue({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true });
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: AGENTS });
  agentMock.mockReset();
  agentMock.mockResolvedValue({
    agent: AGENTS[0]!,
    conversationId: null,
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null } },
  });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  tasksMock.mockReset();
  tasksMock.mockResolvedValue({ tasks: [], unavailableAgents: [] });
  taskMock.mockReset();
  taskMock.mockResolvedValue(TASK_DETAIL);
  taskCheckinMock.mockReset();
  taskCheckinMock.mockResolvedValue(CHECKIN);
  duplicateMock.mockReset();
});

afterEach(clearViewport);

describe('landing on a URL', () => {
  it('opens the agent a deep link names, on the tab it names', async () => {
    // The whole point of the card: a reload used to land on Today no matter
    // where you were.
    renderAt('/workspace/agents/a-quill/files');

    expect(await screen.findByRole('tab', { name: /files/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens Activity from its own URL', async () => {
    renderAt('/workspace/tasks');

    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeTruthy();
  });

  it('opens Tasks from its own URL, with its sidebar row active', async () => {
    renderAt('/workspace/tasks');

    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: /^Today/ })).toHaveAttribute('data-active', 'false');
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));
  });

  it('opens a task from its own URL, with Tasks active in the sidebar', async () => {
    renderAt('/workspace/tasks/a1/t1');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('data-active', 'true');
    expect(taskMock).toHaveBeenCalledWith('a1', 't1');
  });

  it('opens a check-in from its own URL, with Tasks active in the sidebar', async () => {
    renderAt('/workspace/tasks/a1/t1/checkins/c1');

    expect(
      await screen.findByRole('heading', { level: 1, name: /^Check-in/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('data-active', 'true');
    expect(taskCheckinMock).toHaveBeenCalledWith('a1', 't1', 'c1');
  });

  it('See what it did on a task opens that check-in at its own address', async () => {
    taskMock.mockResolvedValue({
      ...TASK_DETAIL,
      updates: [
        {
          firedAt: new Date(2026, 9, 22, 10, 2).toISOString(),
          status: 'ok',
          error: null,
          report: { status: 'needs-you', update: '3 open.', reading: null },
          conversationId: 'c1',
        },
      ],
    });
    renderAt('/workspace/tasks/a1/t1');
    await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });

    // The latest-update card can link too; the entry's link is the one with a
    // time. jsdom reads the time's sr-only span as its own word, so the name
    // comes out as "See what it did , 10:02 AM".
    fireEvent.click(await screen.findByRole('link', { name: /^See what it did\s*,/ }));

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/tasks/a1/t1/checkins/c1'),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: /^Check-in/ }),
    ).toBeTruthy();
    expect(taskCheckinMock).toHaveBeenCalledWith('a1', 't1', 'c1');
  });

  it('a Tasks row leaves the task’s address behind', async () => {
    tasksMock.mockResolvedValue({
      tasks: [
        {
          agentId: 'a1',
          agentName: 'Quill',
          routineId: 't1',
          name: 'Zero open support tickets',
          enabled: true,
          kind: 'stay-on-top',
          steps: null,
          finishBy: null,
          task: null,
          noRecentUpdate: null,
          doneAt: null,
          canMarkDone: true,
        },
      ],
      unavailableAgents: [],
    });
    renderAt('/workspace/tasks');

    fireEvent.click(await screen.findByRole('link', { name: /Zero open support tickets/ }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace/tasks/a1/t1'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' }),
    ).toBeTruthy();
  });

  it('the Tasks row leaves an address behind', async () => {
    renderAt('/workspace');
    await screen.findByRole('heading', { name: 'Today' });

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace/tasks'));
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeTruthy();
  });

  it('rewrites bare / to the workspace root without adding history', async () => {
    // App renders the workspace at `/` when the flag is on. One canonical
    // URL per view is the goal — but a PUSH here would put a phantom entry
    // between the visitor and wherever they came from, so this must replace.
    const before = window.history.length;
    renderAt('/');

    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
    expect(window.history.length).toBe(before);
  });

  it('keeps a query string when it canonicalizes', async () => {
    renderAt('/?ref=email');

    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
    expect(window.location.search).toBe('?ref=email');
  });

  it('says so honestly when the link names an agent that is not there', async () => {
    // A shared link outlives the agent it names, and a URL is the first way
    // to reach an agent the roster never listed. The panel already has a
    // sentence for this; what is new is that a stranger's link can land on
    // it, so pin that it lands there and not on a blank shell.
    // A real HttpError: toReadOutcome classifies on the CLASS, so a plain
    // Error with a status property lands on 'failed' and the wrong sentence.
    agentMock.mockRejectedValue(
      new HttpError('/api/workspace/agents/a-gone', 404),
    );

    renderAt('/workspace/agents/a-gone');

    expect(
      await screen.findByText(/We could not open this agent/i),
    ).toBeTruthy();
  });

  it('falls back to Today on a path it cannot read', async () => {
    renderAt('/workspace/agents/%E0%A4%A');

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
  });
});

describe('navigating', () => {
  /**
   * The roster row for the one agent, by role rather than by bare text.
   *
   * "Quill" is no longer unique on Today: a one-agent roster now shows the
   * agent's name in the composer's picker slot too, because with one agent
   * there is nothing to pick and the slot became a label (TASK-250). A
   * `findByText('Quill')` matched both and threw on the ambiguity.
   */
  function rosterRow() {
    return screen.findByRole('button', { name: /^Quill\s*,/ });
  }

  it('keeps a clamped roster name reachable in `title` (TASK-436)', async () => {
    /*
      The roster row clamps the agent's name to the sidebar's width. jsdom has
      no CSS, so this does not assert the clamp — it asserts that the element
      doing the clamping carries the whole name, which is the half that was
      missing: the row used to be the only copy of a name it truncated.
    */
    renderAt('/workspace');
    const row = await rosterRow();
    const label = row.querySelector('span[title]');
    expect(label?.getAttribute('title')).toBe('Quill');
    expect(label?.textContent).toBe('Quill');
  });

  it('gives an opened agent an address', async () => {
    renderAt('/workspace');

    fireEvent.click(await rosterRow());

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill'),
    );
  });

  it('puts the tab in the URL, so a tab is linkable', async () => {
    renderAt('/workspace/agents/a-quill');

    // Radix Tabs activates a trigger on mousedown, not click — a bare
    // fireEvent.click leaves the tab exactly where it was.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /files/i }));

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill/files'),
    );
  });

  it('unwinds in-workspace navigation with Back', async () => {
    renderAt('/workspace');
    fireEvent.click(await rosterRow());
    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill'),
    );

    // jsdom moves the URL on back() but does not dispatch popstate for it.
    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(window.location.pathname).toBe('/workspace');
  });

  it('does not stack a history entry for the view already on screen', async () => {
    renderAt('/workspace');
    await rosterRow();
    const before = window.history.length;

    // The sidebar's Today button, while Today is what is showing.
    fireEvent.click(screen.getByRole('button', { name: /today/i }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace'));
    expect(window.history.length).toBe(before);
  });
});

describe('agent settings page (TASK-888)', () => {
  /** The detail read, with a thread and a readable rules file. */
  function withRules(body = '- cc Priya') {
    agentMock.mockResolvedValue({
      agent: AGENTS[0]!,
      conversationId: 'c-now',
      thread: [{ kind: 'user', id: 't1', text: 'what is on today' }],
      decisions: { status: 'ok' },
      past: [],
      memory: {
        rules: { status: 'ok', doc: { name: 'Your rules', scope: 'rules', body } },
      },
    });
  }

  function navItem(name: string) {
    return within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole(
      'button',
      { name },
    );
  }

  it('opens the section a deep link names, and that section is selected', async () => {
    renderAt('/workspace/agents/a-quill/settings/model');

    expect(await screen.findByRole('heading', { level: 1, name: 'Quill settings' })).toBeTruthy();
    expect(navItem('Model')).toHaveAttribute('aria-current', 'page');
    expect(navItem('Instructions')).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Using the workspace default')).toBeTruthy();
    // It replaces the chat and the rail rather than sitting beside them.
    expect(screen.queryByRole('complementary', { name: 'Agent details' })).toBeNull();
    expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/model');
  });

  it('rewrites a bare /settings to the Instructions address without adding history', async () => {
    const before = window.history.length;
    renderAt('/workspace/agents/a-quill/settings');

    expect(await screen.findByRole('heading', { level: 2, name: 'Instructions' })).toBeTruthy();
    expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/instructions');
    expect(window.history.length).toBe(before);
  });

  it('gives each section its own address as you move through the nav', async () => {
    renderAt('/workspace/agents/a-quill/settings/instructions');
    await screen.findByRole('heading', { level: 1, name: 'Quill settings' });

    fireEvent.click(navItem('Housekeeping'));

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/routines'),
    );
    expect(screen.getByRole('link', {name:'Open Tasks'})).toHaveAttribute('href','/workspace/tasks');
    expect(navItem('Housekeeping')).toHaveAttribute('aria-current', 'page');
  });

  it('opens this agent\'s Skills section from routine self-improvement', async () => {
    const open = vi.fn();
    renderAt('/workspace/agents/a-quill/settings/routines', open);
    fireEvent.click(await screen.findByRole('button', {name:'View skills'}));
    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/skills'));
    expect(open).not.toHaveBeenCalled();
  });

  it('opens from the rail Settings button and comes back to the same conversation', async () => {
    withRules();
    renderAt('/workspace/agents/a-quill');
    expect(await screen.findByText('what is on today')).toBeTruthy();
    const reads = agentMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/instructions'),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Quill settings' })).toBeTruthy();
    expect(screen.getByText('what is on today')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill'));
    expect(screen.getByText('what is on today')).toBeTruthy();
    // The SAME mounted view came back — a remount would have re-read the agent
    // and opened its newest conversation, not the one that was on screen.
    expect(agentMock.mock.calls.length).toBe(reads);
  });

  it('opens Agent settings from the current conversation options menu', async () => {
    withRules();
    renderAt('/workspace/agents/a-quill');
    const options = await screen.findByRole('button', { name: 'Options for Current conversation' });
    fireEvent.pointerDown(options, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Agent settings' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/instructions'),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Quill settings' })).toBeTruthy();
  });

  it.each(['uploaded', 'pending'] as const)('preserves a %s attachment draft through Settings', async (state) => {
    withRules();
    const result: AttachmentUploadResult = {
      attachmentId: 'att-settings', displayName: 'notes.txt', mediaType: 'text/plain',
      sizeBytes: 5, expiresAt: '2026-10-09T00:00:00.000Z',
    };
    let finishUpload: (value: AttachmentUploadResult) => void = () => {};
    const pendingUpload = new Promise<AttachmentUploadResult>((resolve) => { finishUpload = resolve; });
    vi.mocked(uploadAttachment).mockReturnValue(state === 'uploaded' ? Promise.resolve(result) : pendingUpload);
    const { container } = renderAt('/workspace/agents/a-quill');
    const box = await screen.findByPlaceholderText('Message Quill');
    fireEvent.change(box, { target: { value: 'Please read this file' } });
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(picker).not.toBeNull();
    fireEvent.change(picker!, { target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] } });
    if (state === 'uploaded') await screen.findByText('Ready to send');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('button', { name: 'Back to chat' });
    if (state === 'pending') await act(async () => { finishUpload(result); });
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.getByPlaceholderText('Message Quill')).toHaveValue('Please read this file');
    expect(screen.getByText('notes.txt')).toBeVisible();
    expect(screen.getByText('Ready to send')).toBeVisible();
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it('refreshes the skipped-connector warning after returning from Settings', async () => {
    withRules();
    const read = { connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true };
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      ...read,
      connectors: [{ id: 'gmail', name: 'Gmail', source: 'attached', editable: false,
        health: 'needs-sign-in', setup: 'sign-in', removable: true }],
    });
    renderAt('/workspace/agents/a-quill');
    const sentence = 'Gmail isn’t signed in yet, so it’s off for this chat.';
    await screen.findByText(sentence);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Connectors' }));
    // A sign-in or removal in Settings changes the next authoritative read.
    vi.mocked(workspaceApi.connectors).mockResolvedValue(read);
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await waitFor(() => expect(screen.queryByText(sentence)).toBeNull());
  });

  it('loads, edits and saves the rules from Instructions', async () => {
    withRules('- cc Priya');
    saveRulesMock.mockResolvedValue({ body: '- cc Priya\n- no weekends\n' } as never);
    renderAt('/workspace/agents/a-quill/settings/instructions');

    const box = await screen.findByRole('textbox', { name: 'Instructions for Quill' });
    expect(box).toHaveValue('- cc Priya');
    expect(screen.getByText('Kept word for word. Quill reads them before every run.')).toBeTruthy();

    fireEvent.change(box, { target: { value: '- cc Priya\n- no weekends' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveRulesMock).toHaveBeenCalledWith('a-quill', '- cc Priya\n- no weekends'),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('canonicalizes a legacy Memory link into settings without a rail Memory tab', async () => {
    withRules('- cc Priya');
    renderAt('/workspace/agents/a-quill/memory');
    await screen.findByRole('heading', { level: 2, name: 'Memory' });
    expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/memory');
    expect(screen.queryByRole('tab', { name: 'Memory' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Instructions/u })).toBeNull();
  });
});


describe('Connectors settings migration (TASK-889)', () => {
  it.each(['connectors', 'rules'])('replaces a legacy %s URL with the settings section', async (tab) => {
    window.history.replaceState(null, '', `/workspace/agents/a-quill/${tab}`);
    const before = window.history.length;
    renderAt(`/workspace/agents/a-quill/${tab}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Quill settings' })).toBeVisible();
    expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/connectors');
    expect(window.history.length).toBe(before);
    expect(screen.queryByRole('tab', { name: 'Connectors' })).toBeNull();
  });

  it.each([false, true])('Open Connectors opens its settings content with compact=%s', async (compact) => {
    if (compact) setViewport(true);
    vi.mocked(workspaceApi.connectors).mockResolvedValue({
      connectors: [{ id: 'gmail', name: 'Gmail', source: 'attached', editable: false,
        health: 'needs-sign-in', setup: 'sign-in', removable: true }],
      shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true,
    });
    renderAt('/workspace/agents/a-quill');
    await screen.findByRole('button', { name: 'Open Connectors' });
    if (compact) {
      fireEvent.click(screen.getByRole('button', { name: 'Agent details' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Quill settings' })).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open Connectors' }));

    await waitFor(() => expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/connectors'));
    expect(await screen.findByRole('button', { name: 'Add connector' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Agent details' })).toBeNull();
    // The mobile generic-settings index is not the destination of a named link.
    expect(screen.getByRole('heading', { level: 1, name: compact ? 'Connectors' : 'Quill settings' })).toBeVisible();
  });
});


describe('Memory settings and the pinned learned card (TASK-890)', () => {
  const original: FactMemoryStatement = { id: 'm1', about: 'user', relation: 'lives_in', value: 'Boston', when: '2026-10-08T00:30:00Z', sourceTurnId: 't1' };
  let rows: FactMemoryStatement[];
  beforeEach(() => {
    setViewport(false);
    rows = [original];
    agentMock.mockResolvedValue({ agent: AGENTS[0]!, conversationId: 'c1',
      thread: [{ kind: 'user', id: 't1', text: 'I live in Boston' }],
      decisions: { status: 'ok' }, past: [],
      memory: { rules: { status: 'unavailable', doc: null }, factsAvailable: true } });
    vi.mocked(workspaceApi.recallMemory).mockImplementation(async () => ({ statements: rows, degraded: [] }));
    vi.mocked(workspaceApi.correctMemory).mockImplementation(async (_agent, change) => {
      rows = [{ ...original, id: 'm2', value: change.value }];
      return { id: 'm2' };
    });
    vi.mocked(workspaceApi.forgetMemory).mockImplementation(async () => { rows = []; return { forgotten: true }; });
    vi.mocked(workspaceApi.unforgetMemory).mockImplementation(async () => { rows = [original]; return { restored: ['m1'] }; });
  });
  async function expandLearned() {
    const toggle = await screen.findByRole('button', { name: /^Learned in this chat/ });
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  async function openSettings() {
    await expandLearned();
    fireEvent.click(await screen.findByRole('button', { name: LEARNED_SEE_ALL }));
    await screen.findByRole('table');
    expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/memory');
  }
  async function selectMenu(action: string) {
    const trigger = await screen.findByRole('button', { name: 'Memory actions: Boston' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: action }));
  }
  async function saveFix() {
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(MEMORY_FIX_FIELD_LABEL), { target: { value: 'Denver' } });
    fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FIX_SAVE }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }
  it('fixes in settings update the mounted learned card when returning to chat', async () => {
    renderAt('/workspace/agents/a-quill');
    await screen.findByText(LEARNED_TITLE);
    await openSettings();
    await selectMenu(memoryFixLabel('Boston'));
    await saveFix();
    expect(await screen.findByRole('button', { name: 'Memory actions: Denver' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await expandLearned();
    const card = (await screen.findByText(LEARNED_TITLE)).closest('section')!;
    expect(within(card).getByText(memoryStatementText({ ...original, value: 'Denver' }))).toBeTruthy();
    expect(within(card).queryByText(memoryStatementText(original))).toBeNull();
  });
  it('fixes in the pinned card appear in the settings manager', async () => {
    renderAt('/workspace/agents/a-quill');
    await expandLearned();
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel(memoryStatementText(original)) }));
    await saveFix();
    await openSettings();
    expect(await screen.findByRole('button', { name: 'Memory actions: Denver' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Memory actions: Boston' })).toBeNull();
  });
  it('settings Forget hides the pinned card and its Undo restores it', async () => {
    renderAt('/workspace/agents/a-quill');
    await screen.findByText(LEARNED_TITLE);
    await openSettings();
    await selectMenu(memoryForgetLabel('Boston'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FORGET }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // It remains mounted while Settings is shown, so inspect the hidden tree.
    expect(screen.queryByText(LEARNED_TITLE)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: memoryUndoLabel('Boston') }));
    await screen.findByRole('button', { name: 'Memory actions: Boston' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await expandLearned();
    expect(await screen.findByText(LEARNED_TITLE)).toBeTruthy();
    expect(screen.getByRole('button', { name: memoryFixLabel(memoryStatementText(original)) })).toBeTruthy();
  });
  it('rail Forget updates the settings manager while the Undo receipt is still available', async () => {
    renderAt('/workspace/agents/a-quill');
    await expandLearned();
    fireEvent.click(await screen.findByRole('button', { name: memoryForgetLabel(memoryStatementText(original)) }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FORGET }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: LEARNED_SEE_ALL }));
    expect(await screen.findByText(/No memories yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Memory actions: Boston' })).toBeNull();
  });
});

describe('one tasks read (TASK-933)', () => {
  it('reads tasks once at mount, whichever page it lands on', async () => {
    renderAt('/workspace/agents/a-quill');
    await screen.findByRole('tab', { name: /files/i });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));
  });

  it('reads again on entering Tasks or Today, never on entering an agent', async () => {
    renderAt('/workspace');
    await screen.findByRole('heading', { name: 'Today' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByRole('button', { name: /^Quill\s*,/ }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill'),
    );
    await screen.findByRole('tab', { name: /files/i });
    expect(tasksMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: /^Today/ }));
    await screen.findByRole('heading', { name: 'Today' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(3));
  });

  it('entering Tasks while the tasks read is running joins it, and its answer lands (TASK-933 review)', async () => {
    let land!: (page: Awaited<ReturnType<typeof workspaceApi.tasks>>) => void;
    tasksMock.mockReturnValueOnce(new Promise((res) => (land = res)));
    renderAt('/workspace');
    await screen.findByRole('heading', { name: 'Today' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    fireEvent.click(screen.getByRole('button', { name: /^Today/ }));
    await screen.findByRole('heading', { name: 'Today' });
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    expect(tasksMock).toHaveBeenCalledTimes(1);

    await act(async () =>
      land({
        tasks: [
          {
            agentId: 'a-quill',
            agentName: 'Quill',
            routineId: 't1',
            name: 'Zero open support tickets',
            enabled: true,
            kind: 'stay-on-top',
            steps: null,
            finishBy: null,
            task: null,
            noRecentUpdate: null,
            doneAt: null,
            canMarkDone: true,
          },
        ],
        unavailableAgents: [],
      }),
    );
    expect(await screen.findByText('Zero open support tickets')).toBeTruthy();
    expect(tasksMock).toHaveBeenCalledTimes(1);
  });

  // A read started before a reply, pause or resume on the task page may
  // predate it, so coming back from the task page starts a fresh read rather
  // than joining that one, and the fresh answer wins even if the old one lands
  // after it.
  it('coming back to Tasks from a task page reads afresh, and the older read can’t overwrite it (TASK-933 review)', async () => {
    const taskRow = (name: string) => ({
      agentId: 'a1',
      agentName: 'Quill',
      routineId: 't1',
      name,
      enabled: true,
      kind: 'stay-on-top' as const,
      steps: null,
      finishBy: null,
      task: null,
      noRecentUpdate: null,
      doneAt: null,
      canMarkDone: true,
    });
    let landStale!: (page: Awaited<ReturnType<typeof workspaceApi.tasks>>) => void;
    tasksMock
      .mockResolvedValueOnce({ tasks: [taskRow('Zero open support tickets')], unavailableAgents: [] })
      .mockReturnValueOnce(new Promise((res) => (landStale = res)))
      .mockResolvedValueOnce({ tasks: [taskRow('Fresh after the reply')], unavailableAgents: [] });
    renderAt('/workspace');
    await screen.findByRole('heading', { name: 'Today' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByRole('link', { name: /Zero open support tickets/ }));
    await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole('link', { name: /Fresh after the reply/ })).toBeTruthy();

    await act(async () => landStale({ tasks: [taskRow('Stale from before')], unavailableAgents: [] }));
    expect(screen.getByRole('link', { name: /Fresh after the reply/ })).toBeTruthy();
    expect(screen.queryByText('Stale from before')).toBeNull();
    expect(tasksMock).toHaveBeenCalledTimes(3);
  });

  // The reload rule must survive a hop: the task page's writes postdate a read
  // started before them, however many pages sit between that page and the next
  // Today or Tasks. Activity is the hop because it writes no task rows itself.
  it('a hop through Activity still reads afresh on the way back to Tasks (TASK-933 review)', async () => {
    renderAt('/workspace');
    await screen.findByRole('heading', { name: 'Today' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    // Entering Tasks starts a read that never answers.
    tasksMock.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));

    // Task page → Activity → Tasks, that read still held.
    act(() => {
      window.history.pushState(null, '', '/workspace/tasks/a1/t1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });
    act(() => {
      window.history.pushState(null, '', '/workspace/agents/a-quill/files');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Zero open support tickets' })).toBeNull(),
    );
    expect(tasksMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(3));
  });

  // The check-in arm: a check-in page's decisions also write task rows. Drop
  // `task-checkin` from the shell's rule and this goes back to joining the
  // held read (one call), which is what fails here.
  it('coming back to Tasks from a check-in page reads afresh (TASK-933 review)', async () => {
    tasksMock.mockReturnValueOnce(new Promise(() => {}));
    renderAt('/workspace/tasks');
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.history.pushState(null, '', '/workspace/tasks/a1/t1/checkins/c1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(taskCheckinMock).toHaveBeenCalledWith('a1', 't1', 'c1'));
    expect(tasksMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));
  });

  // Every page that can write task rows arms the reload. Drop a kind from the
  // shell's rule and the matching case goes back to joining the held read
  // (one call).
  it.each([
    ['an agent’s settings (the routine editor)', '/workspace/agents/a-quill/settings/routines'],
    ['an agent’s page (its chat approves routine changes)', '/workspace/agents/a-quill'],
  ])('coming back to Tasks from %s reads afresh (TASK-933 review)', async (_name, path) => {
    tasksMock.mockReturnValueOnce(new Promise(() => {}));
    renderAt('/workspace/tasks');
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Tasks' })).toBeNull());
    expect(tasksMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));
  });

  // Arming counts the page the app opened on: arm only after a route change
  // and this goes back to joining the held mount read (one call).
  it('opening the app on a task page arms the reload for the first trip to Tasks (TASK-933 review)', async () => {
    tasksMock.mockReturnValueOnce(new Promise(() => {}));
    renderAt('/workspace/tasks/a1/t1');
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));
  });

  // A reload spends the arming: after it, hops between Today, Tasks and
  // Activity join the read in flight again. Keep the arming after a reload and
  // every later entry restarts the read (4 calls); let Activity arm and the
  // trip to Today restarts it (3 calls).
  it('a reload spends the arming, so later hops join the read again (TASK-933 review)', async () => {
    // Every read is held, so a join stays put and only a reload adds a call.
    tasksMock.mockReturnValue(new Promise(() => {}));
    renderAt('/workspace/agents/a-quill');
    await screen.findByRole('tab', { name: /files/i });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(1));

    // Opening on an agent's page armed the reload: the trip to Tasks reads afresh.
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));

    act(() => {
      window.history.pushState(null, '', '/workspace/tasks');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Tasks' });
    fireEvent.click(screen.getByRole('button', { name: /^Today/ }));
    await screen.findByRole('heading', { name: 'Today' });
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('heading', { name: 'Tasks' });
    expect(tasksMock).toHaveBeenCalledTimes(2);
  });

  it('the badge counts a task that needs you on an agent’s page too (TASK-933)', async () => {
    tasksMock.mockResolvedValue({
      tasks: [
        {
          agentId: 'a-quill',
          agentName: 'Quill',
          routineId: 't1',
          name: 'Zero open support tickets',
          enabled: true,
          kind: 'stay-on-top',
          steps: null,
          finishBy: null,
          task: {
            status: 'needs-you',
            update: 'Two tickets are still open.',
            ask: 'Want me to draft a reply to #4410?',
            reading: null,
            doneClaimed: false,
            reportedAt: '2026-10-23T10:00:00.000Z',
          },
          noRecentUpdate: null,
          doneAt: null,
          canMarkDone: true,
        },
      ],
      unavailableAgents: [],
    });
    renderAt('/workspace/agents/a-quill');
    await screen.findByRole('tab', { name: /files/i });

    // Today isn't mounted here, so only the shell's own count can say 1.
    await waitFor(() =>
      expect(
        within(screen.getByRole('button', { name: /^Today/ })).queryByText(/^\d+$/)?.textContent,
      ).toBe('1'),
    );
  });
});

describe('Duplicate opens a paused copy (TASK-953)', () => {
  const COPY_LINE = 'This is a paused copy. Change what you need, then press Resume.';
  const COPY: TaskDetail = {
    ...TASK_DETAIL,
    name: 'Copy of Zero open support tickets',
    enabled: false,
    revision: 'rev-copy',
    nextCheckAt: null,
  };

  /** The source answers as itself, the copy as a paused copy. */
  function answerByTask() {
    taskMock.mockImplementation(async (_agentId: string, routineId: string) =>
      routineId === 't2' ? COPY : TASK_DETAIL,
    );
    duplicateMock.mockResolvedValue({ routineId: 't2' });
  }

  async function duplicateFromSource() {
    const view = renderAt('/workspace/tasks/a1/t1');
    await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByRole('heading', { level: 1, name: 'Copy of Zero open support tickets' });
    return view;
  }

  it('Duplicate opens the copy at its own address, which says once that it’s a paused copy', async () => {
    answerByTask();
    await duplicateFromSource();
    expect(window.location.pathname).toBe('/workspace/tasks/a1/t2');
    expect(duplicateMock).toHaveBeenCalledWith('a1', 't1', { requestId: expect.any(String) });
    expect(screen.getByText(COPY_LINE)).toBeInTheDocument();
  });

  it('the line doesn’t come back after Back and Forward, or on opening the copy’s address again', async () => {
    answerByTask();
    const view = await duplicateFromSource();

    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });
    expect(window.location.pathname).toBe('/workspace/tasks/a1/t1');

    act(() => {
      window.history.forward();
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { level: 1, name: 'Copy of Zero open support tickets' });
    expect(screen.queryByText(COPY_LINE)).toBeNull();

    // A reload: the same address, mounted fresh.
    view.unmount();
    renderAt('/workspace/tasks/a1/t2');
    await screen.findByRole('heading', { level: 1, name: 'Copy of Zero open support tickets' });
    expect(screen.queryByText(COPY_LINE)).toBeNull();
  });

  it('someone who left while the copy was being made stays where they went', async () => {
    answerByTask();
    let resolve!: (copy: { routineId: string }) => void;
    duplicateMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderAt('/workspace/tasks/a1/t1');
    await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(duplicateMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.history.pushState(null, '', '/workspace');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'Zero open support tickets' })).toBeNull(),
    );

    await act(async () => resolve({ routineId: 't2' }));
    expect(window.location.pathname).toBe('/workspace');
    expect(screen.queryByRole('heading', { level: 1, name: 'Copy of Zero open support tickets' })).toBeNull();
  });

  it('someone who left for Tasks gets a fresh list read once the copy is saved', async () => {
    answerByTask();
    let resolve!: (copy: { routineId: string }) => void;
    duplicateMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderAt('/workspace/tasks/a1/t1');
    await screen.findByRole('heading', { level: 1, name: 'Zero open support tickets' });
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect(duplicateMock).toHaveBeenCalledTimes(1));

    act(() => {
      window.history.pushState(null, '', '/workspace/tasks');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    // Entering Tasks read the list, before the copy was saved.
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(2));

    await act(async () => resolve({ routineId: 't2' }));
    await waitFor(() => expect(tasksMock).toHaveBeenCalledTimes(3));
    expect(window.location.pathname).toBe('/workspace/tasks');
  });
});
