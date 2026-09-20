/**
 * The agent pane's tab set, as ASSISTIVE TECH sees it (TASK-437).
 *
 * The defect this pins, measured against the commit before the fix: the four
 * triggers carried **four `aria-controls` attributes pointing at ids that do not
 * exist**, and the document contained **zero** elements with `role="tabpanel"`.
 * `AgentView` imported `Tabs`, `TabsList` and `TabsTrigger` and never
 * `TabsContent`, so the panels the triggers advertise were simply not there.
 *
 * A dangling `aria-controls` is worse than none: it promises a relationship the
 * DOM does not keep, so a reader who follows it lands nowhere, and without the
 * panel role there is no "tab 2 of 4" and no way into the panel's content.
 *
 * WHY THREE OF THE FOUR PANELS ARE EMPTY, and why that is the fix rather than a
 * shortcut — read out of `@radix-ui/react-tabs@1.1.21`:
 *
 *   - `TabsTrigger` sets `aria-controls={contentId}` UNCONDITIONALLY. There is no
 *     branch on whether the matching content is mounted.
 *   - `TabsContent` renders inside `<Presence present={forceMount || isSelected}>`,
 *     which renders NOTHING when its tab is inactive.
 *
 * So the obvious composition — one `TabsContent` for the open tab — would still
 * leave three ids dangling while looking fixed. `forceMount` keeps all four panel
 * elements present; supplying `children` only for the open tab keeps the other
 * three EMPTY, so nothing extra mounts and nothing extra reads.
 *
 * jsdom has no CSS, so nothing here claims anything about how any of this LOOKS.
 * The accessibility tree, `role`, id resolution, `hidden` and
 * `document.activeElement` are real in jsdom, and they are the whole subject.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { workspaceApi, type AgentDetail, type WorkspaceAgent } from '@/lib/workspace-api';
import { WORKSPACE_AGENT_TABS } from '@/lib/workspace-route';
import { AgentView } from '../AgentView';
import { rail as railFixture } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
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

/**
 * The tabs, in DOM order.
 *
 * `hidden: true` because three of the four PANELS are hidden and Testing
 * Library's default role query drops hidden elements — the tabs themselves are
 * visible either way, but every query in this file uses the same setting so a
 * count on one side can be compared with a count on the other.
 */
function tabs(): HTMLElement[] {
  return screen.getAllByRole('tab', { hidden: true });
}

function panels(): HTMLElement[] {
  return screen.getAllByRole('tabpanel', { hidden: true });
}

beforeEach(() => {
  agentMock.mockReset();
  agentMock.mockResolvedValue(detail());
  vi.mocked(workspaceApi.rail).mockClear();
});

describe('AgentView tab set — the accessibility tree', () => {
  /*
    THE CARD'S HEADLINE DEFECT, asserted on every tab because the bug was on
    every tab. Before the fix `resolved` was `[]` and `dangling` held all four.
  */
  for (const tab of WORKSPACE_AGENT_TABS) {
    it(`resolves every aria-controls to a real tabpanel with the ${tab} tab open`, async () => {
      renderView({ tab });

      await waitFor(() => expect(tabs()).toHaveLength(WORKSPACE_AGENT_TABS.length));

      const dangling: string[] = [];
      const notPanels: string[] = [];
      for (const t of tabs()) {
        const id = t.getAttribute('aria-controls');
        // No `aria-controls` at all would be a lesser bug than a dangling one,
        // but it is still not this fix — the tab/panel pairing is the point.
        expect(id, `${t.textContent} has no aria-controls`).toBeTruthy();
        const target = document.getElementById(id as string);
        if (target === null) {
          dangling.push(`${t.textContent} -> #${id}`);
        } else if (target.getAttribute('role') !== 'tabpanel') {
          notPanels.push(`${t.textContent} -> role=${target.getAttribute('role')}`);
        }
      }
      expect(dangling).toEqual([]);
      expect(notPanels).toEqual([]);

      // Stated as a number as well, so "zero tabpanels" — the shipped state —
      // cannot pass by way of a loop that had nothing to iterate.
      expect(panels()).toHaveLength(WORKSPACE_AGENT_TABS.length);
    });
  }

  /*
    The pairing points BOTH ways. `aria-labelledby` is what lets a reader who
    has landed in the panel hear which tab they are in; Radix sets it from the
    same `baseId`, so this also catches a panel wired to the wrong tab.
  */
  it('labels each panel by its own tab', async () => {
    renderView({ tab: 'memory' });

    await waitFor(() => expect(panels()).toHaveLength(WORKSPACE_AGENT_TABS.length));

    for (const t of tabs()) {
      const panel = document.getElementById(t.getAttribute('aria-controls') as string);
      expect(panel?.getAttribute('aria-labelledby')).toBe(t.getAttribute('id'));
    }
  });

  /*
    ONLY THE OPEN PANEL HOLDS ANYTHING. The three closed ones exist so their ids
    resolve, and that is all they are for: if they carried children, opening the
    agent pane would mount `AgentFiles`, `AgentMemory` and `ActivityFeed`
    together and fire three reads for panels nobody is looking at.
  */
  it('mounts content in the open panel only, and hides the other three', async () => {
    renderView({ tab: 'did' });

    await waitFor(() => expect(panels()).toHaveLength(WORKSPACE_AGENT_TABS.length));

    const open = screen.getByRole('tab', { name: 'What it did' });
    const openId = open.getAttribute('aria-controls');

    for (const panel of panels()) {
      if (panel.id === openId) {
        expect(panel.hasAttribute('hidden')).toBe(false);
        expect(panel.textContent).not.toBe('');
      } else {
        expect(panel.hasAttribute('hidden')).toBe(true);
        // Empty, not merely hidden — an empty panel costs nothing to keep.
        expect(panel.childElementCount).toBe(0);
        expect(panel.textContent).toBe('');
      }
    }
  });

  /*
    THE TRAP THIS PINS, and it is invisible in jsdom as a rendered fact so it is
    pinned structurally instead.

    Tailwind preflight (3.4.19) carries
    `[hidden]:where(:not([hidden="until-found"])) { display: none }`. `:where()`
    adds NOTHING to specificity, so that rule is (0,1,0) — exactly a `flex`
    utility. Ties go to source order and the utilities are emitted last, so
    `<div class="flex" hidden>` renders VISIBLE in a real browser. The open panel
    genuinely needs `flex min-h-0 flex-1 flex-col` to give the conversation its
    height, so the closed ones must carry no display utility at all. jsdom loads
    no CSS and would agree either way, which is exactly why this reads the class
    list rather than the computed style.

    WHAT THIS ONE DOES NOT COVER: it skips any panel without `hidden`, so on its
    own it would go quiet if a regression dropped the attribute entirely. That
    case is covered by `mounts content in the open panel only`, which asserts the
    closed panels DO carry `hidden`. The pair is complete; neither half is.
  */
  it('gives the closed panels no display utility to override [hidden]', async () => {
    renderView({ tab: 'chat' });

    await waitFor(() => expect(panels()).toHaveLength(WORKSPACE_AGENT_TABS.length));

    const display = /(^|\s|:)(flex|grid|block|inline|inline-flex|inline-block|table|contents|flow-root)(\s|$)/;
    for (const panel of panels()) {
      if (!panel.hasAttribute('hidden')) continue;
      expect(
        display.test(panel.className),
        `closed panel "${panel.id}" carries a display class (${panel.className}) that beats [hidden]`,
      ).toBe(false);
    }
  });

  /*
    KEYBOARD, per the WAI-ARIA tabs pattern: the strip is ONE tab stop and the
    arrow keys move within it.

    STATED PLAINLY — THIS ONE PASSES AGAINST THE UNFIXED CODE TOO, and it is the
    only test in this file that does (measured: 8 of 9 fail against the commit
    before the fix, this is the ninth). Radix's roving tabindex lives on
    `TabsList`/`TabsTrigger`, both of which were already here; the missing
    `TabsContent` never affected it. So this is a CHARACTERIZATION test, not a
    guard for this card's defect: it pins the keyboard half of the card's
    acceptance criteria and would catch a later rewrite that replaced the
    primitive with four hand-rolled buttons — four tab stops, no arrow keys.
    It is deliberately not the evidence that this card's fix works; the eight
    above are.
  */
  it('moves between tabs with the arrow keys, not the Tab key', async () => {
    const onTab = vi.fn();
    renderView({ tab: 'chat', onTab });

    await waitFor(() => expect(tabs()).toHaveLength(WORKSPACE_AGENT_TABS.length));
    const [first, second] = tabs();

    /*
      ONE TAB STOP FOR THE WHOLE STRIP — and Radix puts it on the TABLIST, not
      on the selected trigger. Until something inside has been focused its
      roving `currentTabStopId` is null, so every trigger reads `-1` and the
      list itself carries the `0`, handing focus on to the right trigger when it
      receives it. Asserting `0` on the open trigger instead would be asserting
      a different library's design; what matters, and what is checked here, is
      that Tab reaches the strip exactly once rather than four times.
    */
    expect(screen.getByRole('tablist').getAttribute('tabindex')).toBe('0');
    for (const t of tabs()) {
      expect(t.getAttribute('tabindex')).toBe('-1');
    }

    first?.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowRight' });
    /*
      `waitFor`, not a bare assertion: Radix's roving focus defers the actual
      `.focus()` to a `setTimeout`, so the move has not happened yet when
      `fireEvent` returns. Asserting synchronously reads the PREVIOUS focus and
      fails against working code.
    */
    await waitFor(() => expect(document.activeElement).toBe(second));
    // Automatic activation — arrowing onto a tab opens it.
    expect(onTab).toHaveBeenCalledWith(WORKSPACE_AGENT_TABS[1]);
  });

  /*
    AND THE PANEL IS REACHABLE. `tabIndex=0` on the panel is what puts it in the
    tab sequence right after the strip, so Tab out of the tabs lands IN the
    content rather than jumping past it to the next control.
  */
  it('puts the open panel in the tab sequence', async () => {
    renderView({ tab: 'files' });

    await waitFor(() => expect(panels()).toHaveLength(WORKSPACE_AGENT_TABS.length));

    const open = panels().find((p) => !p.hasAttribute('hidden'));
    expect(open?.getAttribute('tabindex')).toBe('0');

    open?.focus();
    expect(document.activeElement).toBe(open);
  });
});
