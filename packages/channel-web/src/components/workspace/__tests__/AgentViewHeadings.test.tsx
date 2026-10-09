/**
 * The agent pane's heading OUTLINE (TASK-446).
 *
 * The defect this pins, measured in jsdom on 2026-09-19 against the commit
 * before the fix: `AgentView` rendered `[]` headings on every one of its four
 * tabs. Not a wrong level — none at all, so the only way through the surface
 * was Tab through every control in it.
 *
 * What it asserts is the outline, not the presence of a tag. `expect(h1s).toHaveLength(1)`
 * and the level sequence together are what make this fail in BOTH directions:
 * on a surface with no headings (the shipped bug) and on one that grew a second
 * `h1` or an `h2` that jumps to `h4` (the plausible way to "fix" it wrongly).
 * See `test-utils/heading-outline.ts`.
 *
 * jsdom has no CSS, so nothing here claims anything about how the headings
 * LOOK — two of them are `sr-only` on purpose and that is unmeasurable here.
 * Elements, levels and DOM order are real, and they are the whole subject.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  workspaceApi,
  WorkspaceApiError,
  type AgentDetail,
  type WorkspaceAgent,
} from '@/lib/workspace-api';
import { AgentView } from '../AgentView';
import { rail as railFixture } from './rail-fixture';
/*
  THE VIEWPORT STUB, shared (TASK-455). jsdom ships no `matchMedia`, so
  `use-compact.ts` reads `false` and every test below renders the DESKTOP tree
  unless it calls `setViewport`.
*/
import { clearViewport, setViewport } from './viewport';
import { headingOutline, headingOutlineProblems } from '@/test-utils/heading-outline';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: {
      agent: vi.fn(),
      connectors: vi.fn(async () => ({ connectors: [], shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true })),
      // The rail reads its own route — without it the chat tab throws before
      // this file's subject renders at all.
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
      abilities: vi.fn(async () => ({
        abilities: { webSearch: true, readPages: true, runCode: true },
      })),
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
      activity={[]}
      agents={[quill]}
      onBack={vi.fn()}
      decisionsError={null}
      version={0}
      onChanged={vi.fn()}
      {...over}
    />,
  );
}

beforeEach(() => {
  agentMock.mockReset();
  agentMock.mockResolvedValue(detail());
  vi.mocked(workspaceApi.rail).mockClear();
});

afterEach(() => {
  // Added to jsdom's window by `setViewport`; clearing it restores "no
  // matchMedia at all", which is what the rest of this package renders under.
  clearViewport();
});

/*
  EVERY OUTLINE ASSERTION IS WRAPPED IN `waitFor`, deliberately, and none of
  them waits on a heading first. The pane and the rail each land on their own
  read, so the tree settles a tick after mount — but a `findByRole('heading')`
  gate would make this file hang for the full `testTimeout` against the code it
  was written to catch (which has no headings to find) instead of failing in a
  second with a printable diff. Retrying the real assertion gets both.
*/
describe('AgentView heading outline', () => {
  /*
    THE CARD'S HEADLINE DEFECT, on every tab. Before the fix this array was
    empty on all four — the assertion that fails first, and loudest.
  */
  for (const tab of ['activity', 'chat', 'files', 'memory'] as const) {
    it(`gives the ${tab} tab an outline with no skipped levels and exactly one h1`, async () => {
      renderView({ tab });

      await waitFor(() => expect(headingOutlineProblems()).toEqual([]));

      // Stated separately from the generic guard so a regression says WHICH
      // rule broke, and so "exactly one" is asserted as a number rather than
      // inferred from the absence of a complaint.
      const h1s = screen.getAllByRole('heading', { level: 1 });
      expect(h1s).toHaveLength(1);
      expect(h1s[0]?.textContent).toBe('Quill');
    });
  }

  /*
    The agent is the page, so its NAME is the page title — the same call
    `WorkspaceHeader` makes on Today and Activity. The shell hands the whole
    `main` to this component on the agent route and draws no header of its own,
    so nothing else is competing for the `h1`.
  */
  it('makes the agent name the h1, and the open tab the h2 under it', async () => {
    renderView({ tab: 'memory' });

    await waitFor(() =>
      expect(headingOutline()).toEqual([
        'h1: Quill',
        'h2: Conversation',
        'h2: Memory',
        'h3: What I learned in this chat',
      ]),
    );
  });

  it('keeps the settings Connectors section and abilities in the heading outline', async () => {
    renderView({ settingsSection: 'connectors', onSettingsSection: vi.fn() });
    await screen.findByText('Granted by you');

    const page = screen.getByRole('heading', { level: 1, name: 'Quill settings' }).closest('div.overflow-y-auto')!;
    // The conversation stays mounted and hidden to preserve its composer.
    // Its headings are outside this page and outside the accessible tree.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(headingOutline(page).slice(0, 2)).toEqual(['h1: Quill settings', 'h2: Connectors']);
    expect(headingOutlineProblems(page)).toEqual([]);
    const labels = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');
    expect(labels).toContain('What Quill can do');
    expect(labels.some((l) => l.startsWith('Granted by you'))).toBe(true);
  });

  /*
    The panel heading follows the tab, rather than being four headings of which
    three describe regions that are not mounted.
  */
  it('heads the panel with the open tab, not with all four', async () => {
    renderView({ tab: 'activity' });

    await waitFor(() => {
      const h2s = screen.getAllByRole('heading', { level: 2 });
      expect(h2s.map((h) => h.textContent)).toEqual(['Conversation', 'Activity']);
    });
  });

  /*
    REVIEW FOLLOW-UP. The load-error branch replaces the whole pane — header,
    agent name and Back button included — so it was the one AgentView state
    still rendering nothing at all after the fix. It is also the state a reader
    is most likely to be hunting for their bearings in, and unlike the loading
    tick it is terminal: someone can sit on it indefinitely.
  */
  it('still has an h1 when the agent will not load', async () => {
    agentMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill', 500));
    renderView();

    await waitFor(() => expect(headingOutlineProblems()).toEqual([]));

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    // The sentence IS the heading here, the same call `WorkspaceShell` makes on
    // its own board-read failure. The exit stays a button, not a heading.
    expect(h1s[0]?.textContent).toMatch(/We could not load this agent/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  /*
    REVIEW FOLLOW-UP, and it pins the claim the `sr-only` rail heading rests on:
    below `md` the rail is a `Sheet` whose `SheetTitle` ALREADY renders an `h2`
    saying "Agent details". The new heading went on the desktop `<aside>` alone
    precisely so the compact branch does not announce it twice — an assertion
    that is only worth anything with a compact viewport actually installed,
    which jsdom does not give you for free.
  */
  it('says "Agent details" once below md, not twice', async () => {
    setViewport(true);
    renderView({ tab: 'chat' });

    // The compact rail lives behind a trigger; open it so its tree exists.
    fireEvent.click(await screen.findByRole('button', { name: 'Agent details' }));
    await screen.findByRole('heading', { name: 'Conversations' });

    const named = screen
      .getAllByRole('heading')
      .filter((h) => h.textContent === 'Agent details');
    expect(named).toHaveLength(1);
    expect(named[0]?.tagName).toBe('H2');
    // And the sheet's sections still hang off it rather than off the page title.
    expect(headingOutlineProblems()).toEqual([]);
  });
});

/*
  TASK-547 — the "Loading…" pane is focusable and named (TASK-539), and it is
  the same pane on every tab: it renders before the agent read, whatever the
  URL's tab says. It used to be called "Loading conversation" everywhere,
  which is wrong on Activity, Files and Memory.

  VACUITY: against the unfixed code every iteration fails — no region named
  "Loading agent" exists. The read is held forever so the pane is what is on
  screen when the assertion runs.
*/
describe('AgentView loading pane name', () => {
  for (const tab of ['chat', 'activity', 'files', 'memory'] as const) {
    it(`names the ${tab} tab's loading pane "Loading agent"`, () => {
      agentMock.mockReturnValue(new Promise<AgentDetail>(() => {}));
      renderView({ tab });

      expect(screen.getByRole('region', { name: 'Loading agent' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /conversation/i })).toBeNull();
    });
  }
});

/*
  The loading pane is a blank pane with a small spinner, not skeleton bubbles.
  An agent switch remounts AgentView, so this pane flashes by on every switch;
  #829's two skeletons (a short bar and a tall block, laid out in a row) read
  as two chat bubbles on one line for a few milliseconds. jsdom has no CSS, so
  this pins the markup — no `animate-pulse` placeholders, one decorative
  spinner — not pixels or timing.

  VACUITY: against #829's pane both assertions fail (two pulse blocks, no spin).
*/
describe('AgentView loading pane contents', () => {
  it('shows a spinner rather than placeholder bubbles', () => {
    agentMock.mockReturnValue(new Promise<AgentDetail>(() => {}));
    renderView({ tab: 'chat' });

    const pane = screen.getByRole('region', { name: 'Loading agent' });
    expect(pane.querySelectorAll('.animate-pulse')).toHaveLength(0);
    const spinners = pane.querySelectorAll('svg.animate-spin');
    expect(spinners).toHaveLength(1);
    expect(spinners[0]).toHaveAttribute('aria-hidden', 'true');
  });
});
