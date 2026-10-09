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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { uploadAttachment, type AttachmentUploadResult } from '@/lib/attachment-upload';
import { workspaceApi } from '@/lib/workspace-api';
import { HttpError } from '@/lib/http';
import { UserProvider } from '@/lib/user-context';
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
      // TASK-373 — the shell's mount read-back; nothing in this file raises a
      // grant, so an empty page keeps every subject out of the render.
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      saveRules: vi.fn(),
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
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const saveRulesMock = vi.mocked(workspaceApi.saveRules);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
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
function renderAt(path: string) {
  window.history.replaceState(null, '', path);
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
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
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
});

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
    renderAt('/workspace/activity');

    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeTruthy();
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

    fireEvent.click(navItem('Routines'));

    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/routines'),
    );
    expect(screen.getByText('Nothing scheduled yet')).toBeTruthy();
    expect(navItem('Routines')).toHaveAttribute('aria-current', 'page');
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

  it('keeps the rules editor out of the rail Memory tab', async () => {
    withRules('- cc Priya');
    renderAt('/workspace/agents/a-quill/memory');

    const panel = await screen.findByRole('tabpanel', { name: 'Memory' });
    expect(within(panel).queryByRole('textbox', { name: /Instructions/u })).toBeNull();
    expect(within(panel).queryByText('- cc Priya')).toBeNull();

    // It says where the rules went, and the link goes there.
    fireEvent.click(within(panel).getByRole('button', { name: 'Settings' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-quill/settings/instructions'),
    );
  });
});
