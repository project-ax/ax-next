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
import { userFacingMessage } from './http';
import { workspaceApi } from './workspace-api';
import { useOptionalWorkspace } from './workspace-context';
import type { AgentRailData, AgentRunState, GrantRef } from './workspace-types';

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

/**
 * @param detailWord the agent detail's working/resting word (TASK-707), from
 *   the caller's own `GET /api/workspace/agents/:id` read. Optional: outside
 *   the agent view there is no detail to follow, and the roster word below
 *   still applies.
 * @param busy whether the caller has a turn in flight (TASK-818): streaming,
 *   or the finished turn's re-read not yet landed. Optional, like `detailWord`.
 */
export function useAgentRail(
  agentId: string | null,
  detailWord: AgentRunState | null = null,
  busy = false,
): AgentRailState {
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
        setError(userFacingMessage(e, 'workspace-rail'));
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    })();
  }, [agentId]);

  /**
   * The working/resting words this rail follows (TASK-686, TASK-707).
   *
   * The rail's "Right now" line is the same server signal as those words, but
   * this hook used to read it once per agent. A finished reply refreshes the
   * roster — the header pill, the sidebar row and the Today strip all re-read
   * — and the rail kept the "Working on your request" line it read when the
   * turn began. Re-reading whenever a word CHANGES keeps the four surfaces
   * saying the same thing without a poll: one extra read per transition.
   *
   * TWO words, because neither alone sees every transition. The roster word
   * (`null` outside a provider) missed the brand-new-agent flow: the roster
   * read that follows create lands before the server marks the agent working,
   * so it goes resting -> resting and never moves, while the rail mounted
   * mid-turn kept "Working". The agent detail's word is the one the SPA DID
   * see flip — AgentView re-reads it on the done frame — so a change in
   * either one re-reads. When both move they usually land in separate renders
   * (the detail re-read and the roster refresh are two fetches), so a
   * finished turn costs up to two extra reads; one when they land together.
   *
   * And the caller's own turn, because even two words can both sit still
   * (TASK-818). The phone sheet mounts when Details is opened, which can be
   * mid-turn: its mount read says "Working on your request", while the detail
   * was read before the server marked the agent working and is re-read after
   * it stopped (resting -> resting), and so is the roster. Nothing above
   * moved, and the line stayed until a reload. The turn starting and the
   * finished turn's re-read landing (`busy` flipping) are transitions the
   * caller always sees, so each one re-reads: the start so an open panel can
   * pick up the new turn, the finish so it cannot keep a turn that is over.
   */
  const rosterWord =
    useOptionalWorkspace()?.board?.agents.find((a) => a.id === agentId)?.state ?? null;
  const lastWords = useRef({ agentId, rosterWord, detailWord, busy });

  useEffect(load, [load]);

  useEffect(() => {
    const last = lastWords.current;
    lastWords.current = { agentId, rosterWord, detailWord, busy };
    // A new agent is the effect above's read; only a change of word (or of
    // turn) for the SAME agent is this one's.
    if (last.agentId !== agentId) return;
    if (
      last.rosterWord === rosterWord &&
      last.detailWord === detailWord &&
      last.busy === busy
    ) {
      return;
    }
    load();
  }, [agentId, rosterWord, detailWord, busy, load]);

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
