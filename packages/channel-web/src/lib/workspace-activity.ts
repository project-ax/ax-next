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
import { workspaceApi } from './workspace-api';
import type { ActivityEvent } from './workspace-types';

export interface ActivityFeedState {
  events: ActivityEvent[];
  loading: boolean;
  /** Separate from an empty `events`: "we could not read it" is not "there is nothing". */
  error: string | null;
  hasMore: boolean;
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
          setError(e instanceof Error ? e.message : String(e));
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
    fetchPage(nextBefore, false);
  }, [fetchPage, nextBefore]);

  return { events, loading, error, hasMore: nextBefore !== null, loadMore };
}
