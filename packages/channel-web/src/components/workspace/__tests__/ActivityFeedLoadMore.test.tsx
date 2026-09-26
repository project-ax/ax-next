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
import { useLayoutEffect, useRef } from 'react';
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
}

const frames: Frame[] = [];

const ERROR_SENTENCE = /could not load the older entries/i;

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
