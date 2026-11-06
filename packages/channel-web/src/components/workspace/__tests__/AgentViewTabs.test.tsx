/**
 * The chat header's side-panel toggles, as ASSISTIVE TECH sees them.
 *
 * Successor to the TASK-437 tab-set tests. The panel used to be a Radix tab
 * set, and the defect those tests pinned was `aria-controls` pointing at
 * ids that did not exist. The panel is now opened by a single-select toggle
 * group in the chat header (Claude's mini-icon pattern): there are no tabs, so
 * the guard becomes "nothing advertises a panel that is not there", plus the
 * same keyboard contract (one Tab stop, arrows within) and the same economy
 * (only the open view mounts, and only it reads).
 *
 * jsdom has no CSS; the accessibility tree, roles, ids, tabindex and
 * `document.activeElement` are real, and they are the whole subject.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, type AgentDetail, type WorkspaceAgent } from '@/lib/workspace-api';
import { AgentView } from '../AgentView';
import { RAIL_PANELS } from '../AgentRail';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      // Activity reads the rail route; Files reads user files. Each should be
      // called only once its own view is open.
      rail: vi.fn(async () => railFixture()),
      artifacts: vi.fn(async () => []),
      probeArtifactsDownload: vi.fn(),
      artifactsDownloadAllUrl: vi.fn(() => '/api/workspace/agents/a-quill/artifacts/download-all'),
      // A root 404 is an empty list.
      userFiles: vi.fn(async () => {
        const E = actual.WorkspaceApiError as new (path: string, status: number) => Error;
        throw new E('/agents/a-quill/user-files/', 404);
      }),
      revokeGrant: vi.fn(),
      sendMessage: vi.fn(),
      streamReply: vi.fn(),
    },
  };
});

const agentMock = vi.mocked(workspaceApi.agent);

const quill: WorkspaceAgent = {
  id: 'a-quill',
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
    conversationId: 'c-now',
    thread: [{ kind: 'user', id: 't1', text: 'what is on today' }],
    decisions: { status: 'ok' },
    past: [],
    memory: {
      rules: { status: 'unavailable', doc: null },
    },
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

function toggles(): HTMLElement[] {
  const group = screen.getByRole('group', { name: 'Side panel' });
  return within(group).getAllByRole('radio');
}

beforeEach(() => {
  localStorage.clear();
  agentMock.mockReset();
  agentMock.mockResolvedValue(detail());
  vi.mocked(workspaceApi.rail).mockClear();
  vi.mocked(workspaceApi.userFiles).mockClear();
  vi.mocked(workspaceApi.artifacts).mockClear();
});

afterEach(() => localStorage.clear());

describe('AgentView side-panel toggles — the accessibility tree', () => {
  it('draws one toggle per offered view, none pressed, and no tab set at all', async () => {
    renderView();
    await screen.findByRole('group', { name: 'Side panel' });

    // No facts memory in this detail, so no Memory toggle.
    expect(toggles().map((t) => t.getAttribute('aria-label'))).toEqual([
      RAIL_PANELS.files.label,
      RAIL_PANELS.activity.label,
      RAIL_PANELS.artifacts.label,
    ]);
    for (const t of toggles()) expect(t.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryAllByRole('tab', { hidden: true })).toHaveLength(0);
    expect(screen.queryAllByRole('tabpanel', { hidden: true })).toHaveLength(0);
  });

  /*
    The TASK-437 rule, restated for what is here now: nothing in the pane
    points at an element that is not there.
  */
  it('leaves no aria-controls dangling in the header or the panel, open or closed', async () => {
    renderView();
    const group = await screen.findByRole('group', { name: 'Side panel' });
    const header = group.closest('header') as HTMLElement;
    const scopes = () => [header, ...screen.queryAllByRole('complementary')];
    const dangling = () =>
      scopes()
        .flatMap((scope) => [...scope.querySelectorAll('[aria-controls]')])
        .map((el) => el.getAttribute('aria-controls') as string)
        .filter((id) => document.getElementById(id) === null);

    expect(dangling()).toEqual([]);
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    await screen.findByRole('complementary', { name: 'Files' });
    expect(dangling()).toEqual([]);
  });

  it('presses exactly the toggle whose view is open, and names the panel after it', async () => {
    renderView();
    fireEvent.click(await screen.findByRole('radio', { name: 'Activity' }));

    expect(await screen.findByRole('complementary', { name: 'Activity' })).toBeTruthy();
    expect(toggles().filter((t) => t.getAttribute('aria-checked') === 'true')).toEqual([
      screen.getByRole('radio', { name: 'Activity' }),
    ]);

    fireEvent.click(screen.getByRole('radio', { name: 'Activity' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    for (const t of toggles()) expect(t.getAttribute('aria-checked')).toBe('false');
  });

  /*
    ONLY THE OPEN VIEW MOUNTS, AND ONLY IT READS. Opening the agent pane must
    not fire the Files and Activity reads for panels nobody is looking at.
  */
  it('reads nothing for a closed view, and only the open one’s data', async () => {
    renderView();
    await screen.findByRole('group', { name: 'Side panel' });
    expect(workspaceApi.userFiles).not.toHaveBeenCalled();
    expect(workspaceApi.rail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    await waitFor(() => expect(workspaceApi.userFiles).toHaveBeenCalled());
    expect(workspaceApi.rail).not.toHaveBeenCalled();
  });

  it('opening Artifacts fetches only the artifact list', async () => {
    renderView();
    await screen.findByRole('group', { name: 'Side panel' });
    expect(workspaceApi.artifacts).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: 'Artifacts' }));
    await waitFor(() => expect(workspaceApi.artifacts).toHaveBeenCalledWith('a-quill'));
    expect(workspaceApi.userFiles).not.toHaveBeenCalled();
    expect(workspaceApi.rail).not.toHaveBeenCalled();
  });

  /*
    KEYBOARD: the strip is ONE Tab stop and the arrow keys move within it
    (Radix's roving tabindex on the toggle group). Pins against a rewrite into
    hand-rolled buttons — three Tab stops, no arrow keys.
  */
  it('is one Tab stop, with the arrow keys moving between toggles', async () => {
    renderView();
    await screen.findByRole('group', { name: 'Side panel' });

    /*
      Radix puts the single Tab stop on the GROUP until something inside has
      been focused (its roving `currentTabStopId` starts null), so every
      toggle reads -1 and the group carries the 0 — the tabs pattern exactly.
    */
    const group = screen.getByRole('group', { name: 'Side panel' });
    expect(group.getAttribute('tabindex')).toBe('0');
    for (const t of toggles()) expect(t.getAttribute('tabindex')).toBe('-1');

    const [first, second] = toggles();
    first?.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it('remembers the open view across a remount on desktop', async () => {
    const first = renderView();
    fireEvent.click(await screen.findByRole('radio', { name: 'Files' }));
    await screen.findByRole('complementary', { name: 'Files' });
    first.unmount();

    renderView();
    expect(await screen.findByRole('complementary', { name: 'Files' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'true');
  });
});
