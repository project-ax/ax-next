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

/**
 * What a Remove answered. Slice 3 — Remove deletes this agent's own sign-in
 * and keys, never a person's, so there is no "signed you out" outcome.
 */
export type RemoveOutcome = 'removed' | 'removed-partial' | 'failed';

export interface AgentConnectorsState {
  connectors: AgentConnectorRow[] | null;
  status: AgentConnectorsStatus;
  /** Connector ids with a remove in flight. */
  removing: ReadonlySet<string>;
  remove: (connectorId: string) => Promise<RemoveOutcome>;
  /** The agent is a team agent (signing in on it asks first: everyone acts as the signer). */
  shared: boolean;
  /**
   * TASK-798 — this person may add and remove its connectors (always on
   * their own agent; on a team agent only its owner or a workspace admin).
   * False until the list is read, and whenever the server didn't say:
   * offering what the server would refuse is worse than briefly offering
   * nothing.
   */
  manageable: boolean;
  /**
   * TASK-813 — this person may sign in, or add a team key, ON this team
   * agent: only an admin of the team that owns it (a workspace admin who
   * isn't one may not). Always false on a personal agent. Same "false until
   * the server said so" rule as `manageable`.
   */
  sharedCredentials: boolean;
  /**
   * Slice 3 — this person may choose the account the agent acts as: Sign in
   * again and Add key. A personal agent's owner (a personal agent's list is
   * only readable by its owner), or a team agent's team admin
   * (`sharedCredentials`). False until the list is read, like the others;
   * the server decides again on every write.
   */
  canSetAccount: boolean;
  /**
   * TASK-761 — false when this agent's runner gets no connector tools at all
   * (a runner that doesn't load connectors: an allow-list in
   * `runnerLoadsConnectors`), so the tab says so instead of offering setup that can't apply.
   */
  connectorsSupported: boolean;
  refresh: () => void;
}

export function useAgentConnectors(agentId: string): AgentConnectorsState {
  const [connectors, setConnectors] = useState<AgentConnectorRow[] | null>(null);
  const [status, setStatus] = useState<AgentConnectorsStatus>('loading');
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [shared, setShared] = useState(false);
  const [manageable, setManageable] = useState(false);
  const [sharedCredentials, setSharedCredentials] = useState(false);
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
        setShared(false);
        setManageable(false);
        setSharedCredentials(false);
        setConnectorsSupported(true);
      }
      void (async () => {
        try {
          const out = await workspaceApi.connectors(agentId);
          if (scope.current !== id) return;
          setConnectors(out.connectors);
          setShared(out.shared === true);
          setManageable(out.manageable === true);
          setSharedCredentials(out.sharedCredentials === true);
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

  const refresh = useCallback(() => load(false), [load]);

  return {
    connectors,
    status,
    removing,
    remove,
    shared,
    manageable,
    sharedCredentials,
    canSetAccount: status === 'ok' && (!shared || sharedCredentials),
    connectorsSupported,
    refresh,
  };
}
