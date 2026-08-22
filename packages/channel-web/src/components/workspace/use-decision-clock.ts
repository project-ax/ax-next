/**
 * The clock a decision row reads.
 *
 * Two things on a resolved row are TIME-DEPENDENT, and both of them are claims:
 *
 *   - the undo affordance, which must disappear when the window closes rather
 *     than when someone happens to refetch, and
 *   - whether a deferred irreversible action has actually gone ahead yet. For
 *     those ten seconds the row says "it is about to go ahead", and the instant
 *     it IS ahead that sentence stops being true.
 *
 * Neither can wait for the next fetch, because there is no next fetch: the
 * queue is read once and updated by the responses to a person's own clicks. A
 * row left on "about to go ahead" would keep saying so for as long as the tab
 * stayed open, which is the stale-surface failure design H7 names — the screen
 * stops receiving updates and does not change what it says.
 *
 * So this ticks while anything on the row is still moving and STOPS when
 * nothing is. Rows spend almost all of their life in the stopped state (an open
 * decision has no clock at all, and a resolved one runs for ten seconds once),
 * so a queue of thirty rows is not thirty live timers.
 */
import { useEffect, useState } from 'react';
import type { Decision } from '@/lib/workspace-api';
import { isAboutToHappen, undoSecondsLeft } from './decision-copy';

/** How often the row re-reads the clock. Twice a second is a smooth countdown. */
const TICK_MS = 500;

/** Is anything about this row still going to change on its own? */
function isTicking(d: Decision, at: number): boolean {
  return undoSecondsLeft(d, at) > 0 || isAboutToHappen(d, at);
}

/**
 * The instant this row should be rendered against. Every time-dependent read on
 * the row takes it, so the countdown, the undo button and the outcome sentence
 * can never disagree about what time it is.
 */
export function useDecisionClock(d: Decision): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isTicking(d, Date.now())) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      // Last tick: the window has closed and the row is final from here.
      if (!isTicking(d, at)) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [d]);

  return now;
}
