/**
 * The shell below 768px (TASK-404).
 *
 * A walk against production measured, at phone width: Today's filter chips at
 * x = 385 on a 390px viewport, three of the four agent tabs past the right
 * edge, and `document.scrollWidth === clientWidth` — so nothing off-screen was
 * reachable. Reproduced in a real browser before the fix, which also turned up
 * a third offender the card never mentioned: `AgentRail`'s 296px column left
 * the conversation itself **0px wide**.
 *
 * WHAT THIS FILE CAN AND CANNOT PIN. jsdom applies no CSS and does no layout —
 * every `getBoundingClientRect()` is zeroes and a `md:` class is a string it
 * never reads. So an assertion here about a chip's x-position, or about a class
 * name being spelled `md:flex`, would pass identically against the broken code:
 * a check that cannot fail, wearing the costume of a guard. This file therefore
 * pins only the part of the fix that is a STATE MACHINE rather than a
 * stylesheet — the two side columns (236px nav, 296px rail) moving off-canvas
 * into a `Sheet`, which is a real difference in the rendered tree and is the
 * change that actually reclaims 532px.
 *
 * That is the same split `src/__tests__/mobile-sidebar.test.tsx` already makes
 * for the legacy shell, and for the same stated reason. The geometry is
 * verified in a real browser instead; the measured before/after numbers are in
 * the PR body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  workspaceApi,
  type AgentDetail,
  type WorkspaceAgent,
} from '@/lib/workspace-api';
import { UserProvider } from '@/lib/user-context';
import { WorkspaceShell } from '../WorkspaceShell';
import { AgentView } from '../AgentView';
import { workspaceGrantActions } from '@/lib/workspace-grant-store';
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

/**
 * THE VIEWPORT STUB. jsdom ships no `matchMedia` at all, which is exactly why
 * `use-compact.ts` guards for its absence and reads `false` — so every other
 * suite in this package keeps rendering the desktop tree untouched. Here we
 * install one deliberately.
 *
 * Only the compact query is answered from `compact`; everything else (notably
 * `theme.ts`'s `prefers-color-scheme`) gets a flat `false`, so widening the
 * viewport in a test cannot accidentally flip the palette as a side effect.
 */
const COMPACT_QUERY = 'not all and (min-width: 768px)';

function setViewport(compact: boolean): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query === COMPACT_QUERY ? compact : false,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

const user = {
  id: 'u1',
  email: 'u@example.com',
  name: 'Uma',
  role: 'user' as const,
};

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent: quill,
    conversationId: 'c-now',
    thread: [{ kind: 'user', id: 't1', text: 'what is on today' }],
    decisions: { status: 'ok' },
    past: [],
    memory: {
      rules: { status: 'unavailable', doc: null },
      learned: { status: 'unavailable', docs: [] },
    },
    ...over,
  };
}

function renderShell() {
  return render(
    <UserProvider value={user}>
      <WorkspaceShell />
    </UserProvider>,
  );
}

function renderAgentView(over: { onOpenNav?: () => void } = {}) {
  return render(
    <UserProvider value={user}>
      <AgentView
        {...(over.onOpenNav ? { onOpenNav: over.onOpenNav } : {})}
        agentId="a-quill"
        tab="chat"
        onTab={() => {}}
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
        version={0}
        pendingReply={null}
        onPendingReplyConsumed={() => {}}
        onChanged={async () => {}}
      />
    </UserProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/workspace');
  boardMock.mockReset();
  boardMock.mockResolvedValue({ agents: [quill] });
  agentMock.mockReset();
  agentMock.mockResolvedValue(detail());
  activityMock.mockReset();
  activityMock.mockResolvedValue({ events: [], nextBefore: null });
  decisionsMock.mockReset();
  decisionsMock.mockResolvedValue({ decisions: [] });
  grantsMock.mockReset();
  grantsMock.mockResolvedValue({ grants: [] });
  workspaceGrantActions.resetForTest();
});

afterEach(() => {
  /*
    `matchMedia` is a property we ADDED to jsdom's window — deleting it restores
    "no matchMedia at all", which is the state every other suite in this package
    renders under. Leaving a stub behind would silently put the next file on a
    desktop-or-compact viewport it never asked for.
  */
  delete (window as Partial<Window>).matchMedia;
});

describe('the workspace shell below md', () => {
  it('moves the 236px nav off-canvas and keeps it reachable', async () => {
    setViewport(true);
    renderShell();

    // The shell has mounted (Today's empty state is on screen)…
    expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy();

    // …and the nav is NOT taking 236px of a 390px viewport.
    expect(screen.queryByRole('navigation')).toBeNull();

    // It is one tap away, not gone. This is the distinction the card draws:
    // content that is off-screen with no way back is a dead end; content behind
    // a labelled control is not.
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(trigger);

    expect(await screen.findByRole('navigation')).toBeTruthy();
  });

  it('closes the nav once you pick something, so the sheet is not a trap', async () => {
    setViewport(true);
    renderShell();
    expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const nav = await screen.findByRole('navigation');

    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));

    await waitFor(() => expect(nav.isConnected).toBe(false));
  });

  it('above md the nav is still the inline column it always was', async () => {
    setViewport(false);
    renderShell();

    expect(await screen.findByText('Nothing is waiting on you.')).toBeTruthy();
    // No sheet, no trigger — the desktop tree is untouched by this change.
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
  });
});

describe('the agent pane below md', () => {
  it('moves the 296px rail off-canvas and keeps it reachable', async () => {
    setViewport(true);
    renderAgentView();

    // The pane has mounted (its tab strip is up).
    expect(
      await screen.findByRole('tab', { name: 'Conversation' }),
    ).toBeTruthy();

    /*
      The rail is what squeezed the conversation column to ZERO pixels at 390px
      — measured, not inferred. Below `md` it must not be an inline column.
    */
    expect(screen.queryByText('What it may do alone')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Agent details' }));

    expect(await screen.findByText('What it may do alone')).toBeTruthy();
  });

  it('closes the rail when you open a past conversation from it', async () => {
    /*
      The rail sheet covers the thread it just changed. Tapping a row under
      "Previous conversations" swaps the conversation BEHIND the overlay, so a
      sheet left open reads as a tap that did nothing. Same rule the nav sheet
      follows; it was missed here on the first pass (review finding 1).
    */
    setViewport(true);
    agentMock.mockResolvedValue(
      detail({ past: [{ id: 'c-old', title: 'March', meta: 'last week' }] }),
    );
    renderAgentView();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Agent details' }),
    );
    const panel = await screen.findByText('What it may do alone');

    fireEvent.click(screen.getByRole('button', { name: /March/ }));

    await waitFor(() => expect(panel.isConnected).toBe(false));
  });

  it('offers the roster from inside a thread, without going Back first', async () => {
    /*
      Below `md` the sidebar is off-canvas and this pane owns the screen. With
      no trigger here the only route to another agent was Back to Today, which
      costs the reader their place in the thread (review finding 2).
    */
    setViewport(true);
    const onOpenNav = vi.fn();
    renderAgentView({ onOpenNav });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Open navigation' }),
    );
    expect(onOpenNav).toHaveBeenCalledTimes(1);
  });

  it('above md the rail is still the inline column it always was', async () => {
    setViewport(false);
    renderAgentView({ onOpenNav: () => {} });

    expect(
      await screen.findByRole('tab', { name: 'Conversation' }),
    ).toBeTruthy();
    expect(await screen.findByText('What it may do alone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agent details' })).toBeNull();
    /*
      Even handed `onOpenNav`, the nav trigger stays off above `md` — the
      sidebar is a column on screen, and a second door to it would be two
      controls for one thing.
    */
    expect(
      screen.queryByRole('button', { name: 'Open navigation' }),
    ).toBeNull();
  });
});
