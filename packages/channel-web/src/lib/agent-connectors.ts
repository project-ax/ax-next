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
import type { AgentConnectorRow } from './workspace-types';

export type AgentConnectorsStatus = 'loading' | 'ok' | 'unavailable' | 'failed';

export type RemoveOutcome = 'removed' | 'removed-partial' | 'failed';

export interface AgentConnectorsState {
  connectors: AgentConnectorRow[] | null;
  status: AgentConnectorsStatus;
  /** Connector ids with a remove in flight. */
  removing: ReadonlySet<string>;
  remove: (connectorId: string) => Promise<RemoveOutcome>;
  refresh: () => void;
}

export function useAgentConnectors(agentId: string): AgentConnectorsState {
  const [connectors, setConnectors] = useState<AgentConnectorRow[] | null>(null);
  const [status, setStatus] = useState<AgentConnectorsStatus>('loading');
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
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
      }
      void (async () => {
        try {
          const out = await workspaceApi.connectors(agentId);
          if (scope.current !== id) return;
          setConnectors(out.connectors);
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

  const refresh = useCallback(() => load(false), [load]);

  return { connectors, status, removing, remove, refresh };
}
