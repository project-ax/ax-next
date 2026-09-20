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
      // The rail reads its own route — without it the chat tab throws before
      // this file's subject renders at all.
      rail: vi.fn(async () => railFixture()),
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
      learned: { status: 'unavailable', docs: [] },
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
  for (const tab of ['chat', 'did', 'files', 'memory'] as const) {
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
        'h2: Memory',
        'h3: Rules you gave me',
        'h3: What it worked out',
      ]),
    );
  });

  /*
    The tab strip is the panel's visible label, so the panel heading is
    `sr-only` — which is a STYLING decision and lives in `className`. The
    element is a real `h2`: a `div` with `role="heading"` would be the same tree
    with worse support, and leaving it out would leave the rail's `h3`s hanging
    off the page title two levels up.
  */
  it('names the open panel and the rail, and hangs the rail sections off the rail', async () => {
    renderView({ tab: 'chat' });
    // The rail arrives on its own read; wait for one of its sections by TEXT,
    // which is there before the fix as well as after, so the wait itself never
    // becomes the thing under test.
    await screen.findByText('Granted by you');

    expect(headingOutline().slice(0, 3)).toEqual([
      'h1: Quill',
      'h2: Conversation',
      'h2: Agent details',
    ]);
    // The rail's own sections — `SectionLabel`, now an `h3`. At least one, so
    // this cannot pass on a rail that rendered nothing.
    const railSections = screen.getAllByRole('heading', { level: 3 });
    expect(railSections.length).toBeGreaterThan(0);
    expect(railSections.map((h) => h.textContent)).toContain('Granted by you');
  });

  /*
    The panel heading follows the tab, rather than being four headings of which
    three describe regions that are not mounted.
  */
  it('heads the panel with the open tab, not with all four', async () => {
    renderView({ tab: 'did' });

    await waitFor(() => {
      const h2s = screen.getAllByRole('heading', { level: 2 });
      expect(h2s.map((h) => h.textContent)).toEqual(['What it did']);
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
    await screen.findByText('Granted by you');

    const named = screen
      .getAllByRole('heading')
      .filter((h) => h.textContent === 'Agent details');
    expect(named).toHaveLength(1);
    expect(named[0]?.tagName).toBe('H2');
    // And the sheet's sections still hang off it rather than off the page title.
    expect(headingOutlineProblems()).toEqual([]);
  });
});
