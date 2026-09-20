/**
 * The Activity feed must never be HANDED one agent's rows to render as
 * another's — not even for one frame.
 *
 * `useActivityFeed` is one hook instance serving two collections (the whole
 * workspace on Activity, one agent on a "What it did" tab) and it re-scopes in
 * an EFFECT. Effects run after the commit, so on the render where the reader
 * switches, `events` still describes the collection they just left. TASK-402
 * (#609) taught Today's done-count to refuse that frame; the feed itself still
 * painted it.
 *
 * WHY THIS FILE RECORDS PROPS INSTEAD OF READING THE DOM — the same reason
 * `WorkspaceShellDoneTodayScope.test.tsx` does, and the third time this epic
 * has had to say it. The bug is exactly one render wide, and Testing Library's
 * `act` flushes passive effects before handing control back, so by the time
 * any `screen.*` query runs the reset has already happened and the stale frame
 * is gone. A `queryByText` assertion here passes against the UNFIXED code.
 * What makes the frame observable at all is recording what `ActivityFeed` was
 * handed, on every render.
 *
 * The invariant asserted is deliberately stated over EVERY recorded render
 * rather than over a particular one: on any render where the feed is not told
 * it is out of scope, every row it holds must belong to the scope it is
 * rendering. A snapshot of one frame would move the moment the fetch chain
 * grew an await; this does not.
 *
 * TASK-453.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { workspaceGrantActions } from '@/lib/workspace-grant-store';
import type { ActivityEvent } from '@/lib/workspace-types';
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
      grants: vi.fn(),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
    },
  };
});

interface Frame {
  /** The scope this render of the feed is FOR: an agent id, or the workspace. */
  renderedFor: string | undefined;
  /** Which collection the rows it was handed actually came from. */
  rowScopes: (string | undefined)[];
  awaitingScope: boolean;
}

const frames: Frame[] = [];

/**
 * Stands in for the feed and records its props, one entry per render.
 *
 * It also reproduces the one affordance the real component offers and this
 * test drives — the per-row agent button, which exists only on the unscoped
 * (Activity) feed. Everything else `ActivityFeed` does is its own file's
 * business; what is under test here is what the shell HANDS it.
 */
vi.mock('../ActivityFeed', () => ({
  ActivityFeed: ({
    events,
    agentId,
    awaitingScope = false,
    onOpenAgent,
  }: {
    events: ActivityEvent[];
    agentId?: string;
    awaitingScope?: boolean;
    onOpenAgent?: (id: string) => void;
  }) => {
    frames.push({
      renderedFor: agentId,
      rowScopes: events.map((e) => COLLECTION_OF.get(e.id)),
      awaitingScope,
    });
    return (
      <div data-testid="activity-feed">
        {agentId === undefined &&
          [...new Set(events.map((e) => e.agentId))].map((id) => (
            <button key={id} type="button" onClick={() => onOpenAgent?.(id)}>
              open {id}
            </button>
          ))}
      </div>
    );
  },
}));

const boardMock = vi.mocked(workspaceApi.board);
const activityMock = vi.mocked(workspaceApi.activity);
const decisionsMock = vi.mocked(workspaceApi.decisions);
const grantsMock = vi.mocked(workspaceApi.grants);
const agentMock = vi.mocked(workspaceApi.agent);

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

const AGENTS = ['a-quill', 'a-tern'] as const;

function agentRow(id: string, state: 'resting' = 'resting') {
  return {
    id,
    name: id === 'a-quill' ? 'Quill' : 'Tern',
    state,
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  };
}

/**
 * Which collection every fixture row was fetched under, by row id — the
 * ground truth the assertion compares against.
 *
 * Read off the ID rather than off `event.agentId`, because the workspace-wide
 * page legitimately contains rows whose `agentId` is Quill's. "Belongs to the
 * workspace collection" and "is about Quill" are different facts, and
 * conflating them is how this test would go vacuous.
 */
const COLLECTION_OF = new Map<string, string | undefined>();

function page(scope: string | undefined, n: number): ActivityEvent[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `${scope ?? 'workspace'}-row-${i}`;
    COLLECTION_OF.set(id, scope);
    return {
      id,
      // The workspace page mixes both agents; a scoped page is all its own.
      agentId: scope ?? AGENTS[i % AGENTS.length]!,
      at: new Date(2026, 7, 23, 9, 0, 0).toISOString(),
      text: `${scope ?? 'workspace'} row ${i}`,
      kind: 'done' as const,
      detail: null,
      tag: null,
      decisionId: null,
    };
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/workspace');
  frames.length = 0;
  COLLECTION_OF.clear();

  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: AGENTS.map((id) => agentRow(id)) });
  agentMock.mockReset();
  agentMock.mockImplementation(async (id: string) => ({
    agent: agentRow(id),
    conversationId: null,
    thread: [],
    decisions: { status: 'ok' as const },
    past: [],
    memory: {
      rules: { status: 'unavailable' as const, doc: null },
      learned: { status: 'unavailable' as const, docs: [] },
    },
  }));
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  grantsMock.mockReset();
  grantsMock.mockResolvedValue({ grants: [] });
  workspaceGrantActions.resetForTest();

  activityMock.mockReset();
  activityMock.mockImplementation(async (params?: { agentId?: string }) => ({
    events: page(params?.agentId, params?.agentId === undefined ? 4 : 2),
    nextBefore: null,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every render where the feed claimed to be showing live rows. */
function liveFrames(): Frame[] {
  return frames.filter((f) => !f.awaitingScope);
}

/** Renders that were handed a row from a collection they are not rendering. */
function misScoped(): Frame[] {
  return liveFrames().filter((f) =>
    f.rowScopes.some((s) => s !== f.renderedFor),
  );
}

describe('the Activity feed across a scope change', () => {
  it('is never handed the previous agent’s rows to render as the record', async () => {
    window.history.replaceState(null, '', '/workspace/agents/a-quill/did');
    render(
      <UserProvider value={user}>
        <WorkspaceShell />
      </UserProvider>,
    );

    /*
      The precondition, PROVEN rather than timed: Quill's own page is in hand
      and on screen. Had we left for Activity before it was applied, the feed
      would still be holding the empty list the re-scope reset it to, there
      would be no agent-scoped rows available to leak, and the assertion below
      would pass for a reason unrelated to the fix.
    */
    await waitFor(() =>
      expect(activityMock).toHaveBeenCalledWith({ agentId: 'a-quill' }),
    );
    await waitFor(() =>
      expect(
        frames.some(
          (f) =>
            f.renderedFor === 'a-quill' &&
            !f.awaitingScope &&
            f.rowScopes.length === 2,
        ),
      ).toBe(true),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    await waitFor(() => expect(activityMock).toHaveBeenCalledWith({}));
    await waitFor(() =>
      expect(
        frames.some(
          (f) =>
            f.renderedFor === undefined &&
            !f.awaitingScope &&
            f.rowScopes.length === 4,
        ),
      ).toBe(true),
    );

    // The card: not one frame of Quill's rows presented as the whole record.
    expect(misScoped()).toEqual([]);

    /*
      NON-VACUITY. The stale frame must actually have HAPPENED — otherwise
      this file would stay green if the shell stopped rendering the feed
      altogether, or if some future change made the switch synchronous and
      there were never a frame to get wrong. At least one render must have
      been told it was out of scope.
    */
    expect(frames.filter((f) => f.awaitingScope).length).toBeGreaterThan(0);
  });

  it('opens an agent’s own record from a row in the record, and never mixes the two', async () => {
    window.history.replaceState(null, '', '/workspace/activity');
    render(
      <UserProvider value={user}>
        <WorkspaceShell />
      </UserProvider>,
    );

    await waitFor(() => expect(activityMock).toHaveBeenCalledWith({}));
    await waitFor(() =>
      expect(
        frames.some(
          (f) =>
            f.renderedFor === undefined &&
            !f.awaitingScope &&
            f.rowScopes.length === 4,
        ),
      ).toBe(true),
    );

    /*
      #609's reviewer: there was no path from the record to an agent's OWN
      record — `openAgent` always landed on `tab:'chat'`, which is a different
      question from the one the reader just asked. Clicking a name in the
      record now opens that agent's record.
    */
    fireEvent.click(screen.getByRole('button', { name: 'open a-tern' }));
    await waitFor(() =>
      expect(window.location.pathname).toBe('/workspace/agents/a-tern/did'),
    );

    await waitFor(() =>
      expect(activityMock).toHaveBeenCalledWith({ agentId: 'a-tern' }),
    );
    await waitFor(() =>
      expect(
        frames.some(
          (f) =>
            f.renderedFor === 'a-tern' &&
            !f.awaitingScope &&
            f.rowScopes.length === 2,
        ),
      ).toBe(true),
    );

    /*
      The other direction of the same defect — the workspace's rows, which
      include Quill's, rendering unattributed under Tern's tab.

      MEASURED, not assumed: this direction never produces a stale frame at
      all, and the reason is not the fix. `AgentView` is keyed on the agent id
      and returns "Loading…" until its own detail read resolves, which is after
      the feed's reset effect has run — so the tab's `ActivityFeed` does not
      exist during the frame that would be wrong. That is why no
      `awaitingScope` is threaded into `AgentView`: there is nothing there for
      it to refuse. Asserted anyway, because the day that gate changes is the
      day this goes red.
    */
    expect(misScoped()).toEqual([]);
  });
});
