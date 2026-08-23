/**
 * The single activity collection, fetched a page at a time.
 *
 * ONE hook backs both the global Activity page and a per-agent "What it did"
 * tab — the difference is only the `agentId` passed in. Two fetchers over the
 * same collection would drift the moment one grew a feature the other did
 * not, which is exactly the shape design §7 calls out.
 *
 * Scope changes (mount, or `agentId` changing as the reader switches tabs)
 * RESET the accumulated list before the new page lands. Appending Quill's
 * rows onto Tern's tab because a slow response arrived late is the worst bug
 * this hook could ship — a stale-request guard below exists solely to stop
 * exactly that.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { userFacingMessage } from './http';
import { workspaceApi } from './workspace-api';
import type { ActivityEvent } from './workspace-types';

export interface ActivityFeedState {
  events: ActivityEvent[];
  loading: boolean;
  /** Separate from an empty `events`: "we could not read it" is not "there is nothing". */
  error: string | null;
  hasMore: boolean;
  /**
   * How far back the fetched window provably reaches: the instant of the
   * oldest row the server CONSIDERED, exclusive — or `null` once there is
   * nothing older left to ask for.
   *
   * `hasMore` says only WHETHER another page exists; this says WHERE the
   * window we already hold ends, which is what a caller needs before it can
   * turn `events` into a claim about a span of time. Today's "N done today"
   * is that caller: the feed is newest-first, so once this cursor has passed
   * local midnight (or gone `null`) every one of today's rows is already in
   * `events` and the count is true.
   *
   * "Considered", not "rendered": a silenced fire takes a slot in the page and
   * moves the cursor without producing an event, so this can sit older than
   * the last row on screen. See `ActivityResponse` in
   * `server/routes-workspace.ts`.
   */
  nextBefore: string | null;
  loadMore: () => void;
}

export function useActivityFeed(agentId?: string): ActivityFeedState {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);

  /**
   * Bumped on every scope change and every fetch kicked off. A response is
   * applied only if it is still the most recent request in flight — a ref
   * rather than a boolean because a THIRD request can land while a stale
   * SECOND one is still outstanding, and a boolean can't tell those apart.
   */
  const requestId = useRef(0);

  const fetchPage = useCallback(
    (before: string | undefined, reset: boolean) => {
      const id = ++requestId.current;
      setLoading(true);
      void (async () => {
        try {
          const page = await workspaceApi.activity({
            ...(agentId !== undefined ? { agentId } : {}),
            ...(before !== undefined ? { before } : {}),
          });
          if (requestId.current !== id) return; // superseded — drop it
          setEvents((prev) => (reset ? page.events : [...prev, ...page.events]));
          setNextBefore(page.nextBefore);
          setError(null);
        } catch (e) {
          if (requestId.current !== id) return;
          // Its two siblings (`workspace-rail`, `workspace-files`) already go
          // through this; leaving one raw is how `Failed to fetch` reaches a
          // reader from the one path nobody converted.
          setError(userFacingMessage(e, 'workspace-activity'));
        } finally {
          if (requestId.current === id) setLoading(false);
        }
      })();
    },
    [agentId],
  );

  useEffect(() => {
    setEvents([]);
    setNextBefore(null);
    setError(null);
    fetchPage(undefined, true);
    // `fetchPage` is recreated only when `agentId` changes, so this also
    // covers the mount fetch without a separate effect.
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (nextBefore === null) return;
    // Already fetching: a second call would supersede the first (same `before`,
    // so no page is skipped) but buys the same rows twice. The button is
    // `disabled` while loading; this guards the programmatic caller too.
    if (loading) return;
    fetchPage(nextBefore, false);
  }, [fetchPage, loading, nextBefore]);

  return {
    events,
    loading,
    error,
    hasMore: nextBefore !== null,
    nextBefore,
    loadMore,
  };
}
