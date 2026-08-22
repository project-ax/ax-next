/**
 * The right-hand rail, fetched on its own.
 *
 * Separate from `agent()` because it is separately refreshable: revoking a
 * grant has to change what the rail says immediately, and re-reading a whole
 * conversation transcript to find that out would be absurd.
 *
 * `error` is kept apart from an empty rail for the same reason every list on
 * this surface does it: "we could not read it" is not "there is nothing", and
 * on THIS surface the difference is a security claim.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi } from './workspace-api';
import type { AgentRailData, GrantRef } from './workspace-types';

export interface AgentRailState {
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
  /** Re-read from the server. Used after a revoke lands. */
  refresh: () => void;
  /**
   * Take back one grant, then re-read.
   *
   * Resolves to what actually happened, so a caller can say "already gone"
   * rather than pretending a no-op succeeded. It never removes the row
   * optimistically: this list is the answer to "what may it reach", and a row
   * that vanished on click without the server agreeing would be the surface
   * lying in the most expensive place it could.
   */
  revoke: (ref: GrantRef) => Promise<'revoked' | 'already-gone' | 'failed'>;
}

export function useAgentRail(agentId: string | null): AgentRailState {
  const [rail, setRail] = useState<AgentRailData | null>(null);
  const [loading, setLoading] = useState(agentId !== null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Bumped on every scope change and every fetch. A response is applied only if
   * it is still the newest request — otherwise switching agents quickly can
   * paint one agent's permissions under another agent's name, which on this
   * surface is the worst bug in the file.
   */
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (agentId === null) {
      requestId.current += 1;
      setRail(null);
      setLoading(false);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    void (async () => {
      try {
        const next = await workspaceApi.rail(agentId);
        if (requestId.current !== id) return;
        setRail(next);
        setError(null);
      } catch (e) {
        if (requestId.current !== id) return;
        // The rail is dropped, not kept: stale permissions rendered beside a
        // failure notice read as current ones.
        setRail(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    })();
  }, [agentId]);

  useEffect(load, [load]);

  const revoke = useCallback(
    async (ref: GrantRef): Promise<'revoked' | 'already-gone' | 'failed'> => {
      if (agentId === null) return 'failed';
      try {
        const out = await workspaceApi.revokeGrant(agentId, ref);
        load();
        return out.revoked ? 'revoked' : 'already-gone';
      } catch {
        return 'failed';
      }
    },
    [agentId, load],
  );

  return { rail, loading, error, refresh: load, revoke };
}
