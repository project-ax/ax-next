/**
 * A failed "Load more" must not un-render the rows that loaded fine.
 *
 * Page 1 landed, the reader is reading it, page 2's request fails. The hook
 * (`useActivityFeed`) keeps page 1 in `events` and sets `error` — the rows are
 * still in hand. The bug was the component: its error branch returned an
 * `Alert` INSTEAD of the rows, so the feed blanked to one sentence because the
 * part the reader had not asked for yet could not be read. On a surface whose
 * whole job is "here is what your agent did", that reads as "it did nothing".
 *
 * WHY THIS RECORDS EVERY COMMIT instead of asking `screen.*` once at the end —
 * the same lesson as `WorkspaceShellActivityScope.test.tsx` (TASK-453): `act`
 * flushes before any query runs, so a frame that exists for one commit is
 * invisible to an end-state assertion. The harness reads the committed DOM in
 * a layout effect on every render (a parent's layout effect runs after its
 * children commit, before paint) and the test asserts an INVARIANT over all of
 * those frames: once page 1 is on screen, it never leaves.
 *
 * Row provenance comes from the fixture map `PAGE_OF`, keyed by row text —
 * never from anything on the event itself.
 *
 * Driven through the REAL hook and the REAL component, with only the network
 * call mocked, so this is what the reader would actually see.
 *
 * TASK-501.
 */
import { Profiler, useLayoutEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import type { ActivityEvent, WorkspaceAgent } from '@/lib/workspace-api';
import { useActivityFeed } from '@/lib/workspace-activity';
import { ActivityFeed } from '../ActivityFeed';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return {
    ...actual,
    workspaceApi: { activity: vi.fn() },
  };
});

const activityMock = vi.mocked(workspaceApi.activity);

const AGENTS: WorkspaceAgent[] = [
  {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  },
];

const PAGE_1_TEXT = ['Morning inbox sweep', 'Filed the receipts'];
const PAGE_2_TEXT = ['Last week’s digest'];

/** Which page each row came from — the fixture's word, not the event's. */
const PAGE_OF = new Map<string, 1 | 2>([
  ...PAGE_1_TEXT.map((t) => [t, 1] as const),
  ...PAGE_2_TEXT.map((t) => [t, 2] as const),
]);

function row(text: string, i: number): ActivityEvent {
  return {
    id: `a-quill|row|${text}`,
    agentId: 'a-quill',
    at: new Date(Date.now() - i * 60_000).toISOString(),
    text,
    kind: 'done',
    detail: null,
    tag: null,
    decisionId: null,
  };
}

interface Frame {
  /** Page of every row visible in this commit, in order. */
  pagesOnScreen: (1 | 2 | undefined)[];
  /** Text of the load-more failure, or null when none is showing. */
  errorText: string | null;
  /** Whether the polite region the failure is announced through is mounted. */
  announcerMounted: boolean;
  /** ANY failure copy on screen, in any shape — the vacuity guard's signal. */
  anyFailureShown: boolean;
  /** Everything the polite region says in this commit, or null when it is not mounted. */
  announcerText: string | null;
  /**
   * The region's DOM node itself. "Empty, then filled" only helps a screen
   * reader if it is the SAME node both times — a remount is a fresh region.
   */
  announcerNode: Element | null;
}

/** Every frame that had a region had the same one. */
function oneRegionNode(fs: Frame[]): boolean {
  const nodes = fs.map((f) => f.announcerNode).filter((n) => n !== null);
  return nodes.length > 0 && nodes.every((n) => n === nodes[0]);
}

const frames: Frame[] = [];

const ERROR_SENTENCE = /could not load the older entries/i;
const PAGE_1_FAILURE = /could not load the record/i;

function Harness() {
  const feed = useActivityFeed();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current!;
    const text = root.textContent ?? '';
    const pagesOnScreen = [...PAGE_OF.keys()]
      .filter((t) => text.includes(t))
      .map((t) => PAGE_OF.get(t));
    const announcer = root.querySelector('[data-activity-announcer]');
    const m = announcer?.textContent?.match(ERROR_SENTENCE);
    frames.push({
      pagesOnScreen,
      errorText: m ? announcer!.textContent : null,
      announcerMounted: announcer !== null,
      anyFailureShown: /could not load/i.test(text),
      announcerText: announcer === null ? null : (announcer.textContent ?? ''),
      announcerNode: announcer,
    });
  });
  return (
    <div ref={ref}>
      <ActivityFeed
        events={feed.events}
        agents={AGENTS}
        loading={feed.loading}
        error={feed.error}
        hasMore={feed.hasMore}
        onLoadMore={feed.loadMore}
      />
    </div>
  );
}

beforeEach(() => {
  frames.length = 0;
  activityMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('a failed Load more (TASK-501)', () => {
  async function landPage1ThenFailPage2() {
    activityMock.mockResolvedValueOnce({
      events: PAGE_1_TEXT.map(row),
      nextBefore: '2026-09-20T00:00:00.000Z',
    });
    let rejectPage2!: (e: unknown) => void;
    activityMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectPage2 = reject;
        }),
    );

    render(<Harness />);
    await screen.findByText(PAGE_1_TEXT[0]!);

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await act(async () => {
      rejectPage2(new Error('network down'));
    });
    await waitFor(() => {
      expect(activityMock).toHaveBeenCalledTimes(2);
    });
  }

  it('never takes page 1 off screen, on any commit, once it has landed', async () => {
    await landPage1ThenFailPage2();

    const firstWithRows = frames.findIndex((f) => f.pagesOnScreen.includes(1));
    expect(firstWithRows).toBeGreaterThanOrEqual(0);
    const after = frames.slice(firstWithRows);
    // The failure must actually have been reached, or the invariant is vacuous.
    expect(after.some((f) => f.anyFailureShown)).toBe(true);
    for (const f of after) {
      expect(f.pagesOnScreen.filter((p) => p === 1)).toHaveLength(
        PAGE_1_TEXT.length,
      );
      // Nothing from the page that failed is ever invented.
      expect(f.pagesOnScreen).not.toContain(2);
    }
  });

  it('shows the failure alongside the rows and offers another go', async () => {
    await landPage1ThenFailPage2();

    for (const t of PAGE_1_TEXT) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(screen.getByText(ERROR_SENTENCE)).toBeInTheDocument();
    // The whole-feed failure copy is for "we have nothing"; it is not true here.
    expect(screen.queryByText(/could not load the record/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('announces the failure through a region that was mounted before it', async () => {
    /*
      A live region created and filled in the same commit is announced
      inconsistently (VoiceOver often skips it). The reader who pressed Load
      more gets no other sign it failed — focus is on the button, the rows did
      not change — so this one has to be heard.
    */
    await landPage1ThenFailPage2();

    const firstError = frames.findIndex((f) => f.errorText !== null);
    expect(firstError).toBeGreaterThan(0);
    expect(frames[firstError - 1]!.announcerMounted).toBe(true);
    expect(frames[firstError - 1]!.errorText).toBeNull();

    const announcer = document.querySelector('[data-activity-announcer]');
    expect(announcer).not.toBeNull();
    expect(announcer!.getAttribute('aria-live')).toBe('polite');
    expect(within(announcer as HTMLElement).getByText(ERROR_SENTENCE)).toBeInTheDocument();
  });

  it('clears the failure and appends page 2 when the retry works', async () => {
    await landPage1ThenFailPage2();
    activityMock.mockResolvedValueOnce({
      events: PAGE_2_TEXT.map((t, i) => row(t, i + 10)),
      nextBefore: null,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(PAGE_2_TEXT[0]!);

    expect(screen.queryByText(ERROR_SENTENCE)).toBeNull();
    for (const t of PAGE_1_TEXT) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });
});

/*
  TASK-541. Two ways a failure used to go unheard, both about WHEN the text
  lands in the live region relative to the region itself.
*/
describe('every failure is announced (TASK-541)', () => {
  /** How many times the region went from not saying `match` to saying it. */
  function announcements(match: RegExp): number {
    let n = 0;
    let prev = false;
    for (const f of frames) {
      const now = f.announcerText !== null && match.test(f.announcerText);
      if (now && !prev) n += 1;
      prev = now;
    }
    return n;
  }

  it('announces a second identical Try again failure too', async () => {
    /*
      The hook keeps `error` set through the retry and sets the SAME string
      when it fails again, so a region that renders on "error !== null" alone
      never changes and a screen reader has nothing to report: the reader
      pressed Try again and heard silence. The region empties while the retry
      is in flight and refills when it fails — two real commits, a network
      round trip apart.
    */
    activityMock.mockResolvedValueOnce({
      events: PAGE_1_TEXT.map(row),
      nextBefore: '2026-09-20T00:00:00.000Z',
    });
    activityMock.mockRejectedValueOnce(new Error('network down'));
    let rejectRetry!: (e: unknown) => void;
    activityMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectRetry = reject;
        }),
    );

    render(<Harness />);
    await screen.findByText(PAGE_1_TEXT[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText(ERROR_SENTENCE);
    expect(announcements(ERROR_SENTENCE)).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      rejectRetry(new Error('network down'));
    });
    await screen.findByText(ERROR_SENTENCE);

    expect(activityMock).toHaveBeenCalledTimes(3);
    expect(announcements(ERROR_SENTENCE)).toBe(2);
    // The region itself never left: the refill is a change INSIDE it, and the
    // rows stay put across the whole retry.
    const firstRows = frames.findIndex((f) => f.pagesOnScreen.includes(1));
    expect(firstRows).toBeGreaterThanOrEqual(0);
    for (const f of frames.slice(firstRows)) {
      expect(f.announcerMounted).toBe(true);
      expect(f.pagesOnScreen.filter((p) => p === 1)).toHaveLength(PAGE_1_TEXT.length);
    }
    expect(oneRegionNode(frames)).toBe(true);
  });

  it('announces a page-1 failure through a region that was there before it', async () => {
    /*
      Page 1 failing used to swap the whole feed for a fresh `role="alert"`
      Alert, created and filled in one commit — which many screen readers
      skip. It now lands in the same polite region, mounted empty from the
      feed's first frame (alongside the placeholder).
    */
    let rejectPage1!: (e: unknown) => void;
    activityMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectPage1 = reject;
        }),
    );

    render(<Harness />);
    expect(screen.getByText('Reading the record…')).toBeInTheDocument();
    await act(async () => {
      rejectPage1(new Error('network down'));
    });
    await screen.findByText(PAGE_1_FAILURE);

    const first = frames.findIndex(
      (f) => f.announcerText !== null && PAGE_1_FAILURE.test(f.announcerText),
    );
    expect(first).toBeGreaterThan(0);
    for (const f of frames.slice(0, first)) {
      expect(f.announcerMounted).toBe(true);
      expect(f.announcerText).toBe('');
    }
    // The same node from the placeholder frame to the failure frame — not a
    // fresh region that happens to start out empty.
    expect(oneRegionNode(frames)).toBe(true);
    // Announced once, by the region — not a second time by an alert role.
    expect(screen.queryByRole('alert')).toBeNull();
    const announcer = document.querySelector('[data-activity-announcer]')!;
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(within(announcer as HTMLElement).getByText(PAGE_1_FAILURE)).toBeInTheDocument();
  });
});

/*
  TASK-545. The hook lives in WorkspaceShell, above the tabs, so leaving
  "What it did" and coming back remounts the feed with `error` still set. A
  region mounted in the same commit as its text is born full — the create-and-
  fill-together shape screen readers skip — so the failure has to arrive in a
  region that already existed, empty, for at least one commit.
*/
describe('a feed that mounts already failed (TASK-545)', () => {
  /*
    Recorded from a `Profiler` rather than the parent's layout effect: the
    move into the region is a state update INSIDE the feed, which re-renders
    the feed alone. A parent layout effect never runs for that commit, so it
    would record the first frame and then miss the one that matters.
    `onRender` fires on every commit under it, with the DOM already written.
  */
  const tabFrames: Frame[] = [];

  function record(root: HTMLElement | null) {
    if (root === null) return;
    const text = root.textContent ?? '';
    const announcer = root.querySelector('[data-activity-announcer]');
    tabFrames.push({
      pagesOnScreen: [...PAGE_OF.keys()]
        .filter((t) => text.includes(t))
        .map((t) => PAGE_OF.get(t)),
      errorText: null,
      announcerMounted: announcer !== null,
      anyFailureShown: /could not load/i.test(text),
      announcerText: announcer === null ? null : (announcer.textContent ?? ''),
      announcerNode: announcer,
    });
  }

  function TabHarness() {
    const feed = useActivityFeed();
    const [onTab, setOnTab] = useState(true);
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div>
        <button type="button" onClick={() => setOnTab((v) => !v)}>
          toggle tab
        </button>
        <div ref={ref}>
          {onTab && (
            <Profiler id="feed" onRender={() => record(ref.current)}>
              <ActivityFeed
                events={feed.events}
                agents={AGENTS}
                loading={feed.loading}
                error={feed.error}
                hasMore={feed.hasMore}
                onLoadMore={feed.loadMore}
              />
            </Profiler>
          )}
        </div>
      </div>
    );
  }

  function announcementsIn(fs: Frame[], match: RegExp): number {
    let n = 0;
    let prev = false;
    for (const f of fs) {
      const now = f.announcerText !== null && match.test(f.announcerText);
      if (now && !prev) n += 1;
      prev = now;
    }
    return n;
  }

  beforeEach(() => {
    tabFrames.length = 0;
  });

  /** Leave the tab and come back; returns only the frames of the new mount. */
  async function tabAwayAndBack(): Promise<Frame[]> {
    const toggle = screen.getByRole('button', { name: 'toggle tab' });
    fireEvent.click(toggle);
    expect(document.querySelector('[data-activity-announcer]')).toBeNull();
    tabFrames.length = 0;
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.querySelector('[data-activity-announcer]')).not.toBeNull();
    });
    return [...tabFrames];
  }

  function expectAnnouncedOnceAfterAnEmptyCommit(fs: Frame[], match: RegExp) {
    // The remount really was born failed — or everything below is vacuous.
    expect(fs.length).toBeGreaterThan(1);
    expect(fs[0]!.anyFailureShown).toBe(true);
    // Its first commit: the region is there, and it says nothing.
    expect(fs[0]!.announcerMounted).toBe(true);
    expect(fs[0]!.announcerText).toBe('');
    // A later commit fills it — once, and in the same node.
    expect(announcementsIn(fs, match)).toBe(1);
    expect(fs[fs.length - 1]!.announcerText).toMatch(match);
    expect(oneRegionNode(fs)).toBe(true);
    // A sighted reader never sees the failure blink out on the way.
    for (const f of fs) expect(f.anyFailureShown).toBe(true);
    // At rest it is said once, by the region — no second copy beside it.
    const all = document.body.textContent ?? '';
    expect(all.match(new RegExp(match.source, 'gi'))).toHaveLength(1);
  }

  it('announces a page-1 failure on the way back to the tab', async () => {
    activityMock.mockRejectedValueOnce(new Error('network down'));
    render(<TabHarness />);
    await screen.findByText(PAGE_1_FAILURE);

    const fs = await tabAwayAndBack();
    expectAnnouncedOnceAfterAnEmptyCommit(fs, PAGE_1_FAILURE);
    expect(screen.queryByRole('alert')).toBeNull();
    // Nothing refetched: the hook's state is what the new mount was born into.
    expect(activityMock).toHaveBeenCalledTimes(1);
  });

  it('announces a failed Load more on the way back, rows and all', async () => {
    activityMock.mockResolvedValueOnce({
      events: PAGE_1_TEXT.map(row),
      nextBefore: '2026-09-20T00:00:00.000Z',
    });
    activityMock.mockRejectedValueOnce(new Error('network down'));
    render(<TabHarness />);
    await screen.findByText(PAGE_1_TEXT[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText(ERROR_SENTENCE);

    const fs = await tabAwayAndBack();
    expectAnnouncedOnceAfterAnEmptyCommit(fs, ERROR_SENTENCE);
    for (const f of fs) {
      expect(f.pagesOnScreen.filter((p) => p === 1)).toHaveLength(PAGE_1_TEXT.length);
    }
  });
});
