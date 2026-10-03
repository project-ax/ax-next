/**
 * The Connectors tab's list, as state (TASK-739, connectors-rail slice 6).
 *
 * Never optimistic, same rule as the ability switches: a row leaves the list
 * only after the server re-read says it is gone. A list that dropped a row on
 * click and then quietly kept the connector would be this surface claiming
 * less reach than the agent really has.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpError, logRequestFailure } from './http';
import { workspaceApi } from './workspace-api';
import type { AgentConnectorHealth, AgentConnectorRow } from './workspace-types';

export type AgentConnectorsStatus = 'loading' | 'ok' | 'unavailable' | 'failed';

export type RemoveOutcome = 'removed' | 'removed-partial' | 'failed';

/** What Retry found (TASK-741), or that the check itself could not run. */
export type RetryOutcome = AgentConnectorHealth | 'failed';

export interface AgentConnectorsState {
  connectors: AgentConnectorRow[] | null;
  status: AgentConnectorsStatus;
  /** Connector ids with a remove in flight. */
  removing: ReadonlySet<string>;
  remove: (connectorId: string) => Promise<RemoveOutcome>;
  /** The agent is a team agent (Reconnect asks before signing in for everyone). */
  shared: boolean;
  /**
   * TASK-761 — false when this agent's runner gets no connector tools at all
   * (aisdk), so the tab says so instead of offering setup that can't apply.
   */
  connectorsSupported: boolean;
  /** Connector ids with a Retry in flight (TASK-741). */
  retrying: ReadonlySet<string>;
  /** One fresh check of one connector; the row takes the health it answers. */
  retry: (connectorId: string) => Promise<RetryOutcome>;
  refresh: () => void;
}

export function useAgentConnectors(agentId: string): AgentConnectorsState {
  const [connectors, setConnectors] = useState<AgentConnectorRow[] | null>(null);
  const [status, setStatus] = useState<AgentConnectorsStatus>('loading');
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [shared, setShared] = useState(false);
  const [connectorsSupported, setConnectorsSupported] = useState(true);
  // Only the newest read for the newest agent lands — switching agents fast
  // must never paint one agent's connectors under another's name.
  const scope = useRef(0);
  const agentScope = useRef(0);

  const load = useCallback(
    (fresh: boolean) => {
      const id = ++scope.current;
      if (fresh) {
        agentScope.current = id;
        setConnectors(null);
        setStatus('loading');
        setRemoving(new Set());
        setRetrying(new Set());
        setShared(false);
        setConnectorsSupported(true);
      }
      void (async () => {
        try {
          const out = await workspaceApi.connectors(agentId);
          if (scope.current !== id) return;
          setConnectors(out.connectors);
          setShared(out.shared === true);
          // Only an explicit false hides setup: an older server that never
          // sent the flag keeps today's behaviour.
          setConnectorsSupported(out.connectorsSupported !== false);
          setStatus('ok');
        } catch (e) {
          if (scope.current !== id) return;
          logRequestFailure(e, 'agent-connectors');
          // A failed read drops the list: an old list beside a failure reads
          // as the current one.
          setConnectors(null);
          setStatus(e instanceof HttpError && e.status === 503 ? 'unavailable' : 'failed');
        }
      })();
    },
    [agentId],
  );

  useEffect(() => load(true), [load]);

  const remove = useCallback(
    async (connectorId: string): Promise<RemoveOutcome> => {
      const agentAtStart = agentScope.current;
      setRemoving((prev) => new Set(prev).add(connectorId));
      try {
        const out = await workspaceApi.removeConnector(agentId, connectorId);
        if (agentScope.current === agentAtStart) load(false);
        return out.cleanup === 'complete' ? 'removed' : 'removed-partial';
      } catch (e) {
        logRequestFailure(e, 'agent-connectors');
        return 'failed';
      } finally {
        if (agentScope.current === agentAtStart) {
          setRemoving((prev) => {
            const next = new Set(prev);
            next.delete(connectorId);
            return next;
          });
        }
      }
    },
    [agentId, load],
  );

  const retry = useCallback(
    async (connectorId: string): Promise<RetryOutcome> => {
      const agentAtStart = agentScope.current;
      setRetrying((prev) => new Set(prev).add(connectorId));
      try {
        const out = await workspaceApi.retryConnector(agentId, connectorId);
        if (agentScope.current === agentAtStart) {
          setConnectors((prev) =>
            prev === null
              ? prev
              : prev.map((r) => {
                  if (r.id !== connectorId) return r;
                  // TASK-756 — whose sign-in expired comes with the answer;
                  // an absent flag must clear one the row carried before.
                  const { sharedSignIn: _was, ...rest } = r;
                  return {
                    ...rest,
                    health: out.health,
                    ...(out.sharedSignIn === true ? { sharedSignIn: true as const } : {}),
                  };
                }),
          );
        }
        return out.health;
      } catch (e) {
        logRequestFailure(e, 'agent-connectors');
        return 'failed';
      } finally {
        if (agentScope.current === agentAtStart) {
          setRetrying((prev) => {
            const next = new Set(prev);
            next.delete(connectorId);
            return next;
          });
        }
      }
    },
    [agentId],
  );

  const refresh = useCallback(() => load(false), [load]);

  return {
    connectors,
    status,
    removing,
    remove,
    shared,
    connectorsSupported,
    retrying,
    retry,
    refresh,
  };
}
