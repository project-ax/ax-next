/**
 * The connector details view's tool list, as state (TASK-742, connectors-rail
 * slice 9).
 *
 *   GET …/agents/:id/connectors/:cid/tools[?refresh=1] → AgentConnectorToolsRead
 *   PUT …/agents/:id/connectors/:cid/tool-verdicts {toolKey, verdict}
 *     → AgentToolVerdictSaved (the store's re-read state for that one tool)
 *
 * Never optimistic, same rule as the ability switches: a segment shows what
 * the server re-read after writing, never what it asked for. A control that
 * showed "Deny" while the store still said "Allow" would be this surface
 * claiming less reach than the agent really has.
 *
 * One narrow exception (TASK-757): when the store ACCEPTED the write but its
 * read-back failed, the server answers `unconfirmed` with the verdict it
 * wrote. The store refuses anything looser than the ceiling, so an accepted
 * write is what it now holds; the row shows it and the view says to reload.
 * Showing the old verdict — or "Nothing changed" — would be the wrong claim.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpError, logRequestFailure } from './http';
import { workspaceApi } from './workspace-api';
import type {
  AgentConnectorTool,
  AgentConnectorToolsRead,
  AgentToolVerdict,
} from './workspace-types';

/** Loosest first. */
export const VERDICT_ORDER: readonly AgentToolVerdict[] = ['allow', 'hold', 'deny'];

/** The words a person reads for each verdict — the segments' aria-labels. */
export const VERDICT_LABEL: Record<AgentToolVerdict, string> = {
  allow: 'Allow',
  hold: 'Ask first',
  deny: 'Deny',
};

/** True when `verdict` would let the agent do more than `ceiling` allows. */
export function isLooserThan(verdict: AgentToolVerdict, ceiling: AgentToolVerdict): boolean {
  return VERDICT_ORDER.indexOf(verdict) < VERDICT_ORDER.indexOf(ceiling);
}

/** Why a segment is off-limits, or null when the person may pick it. */
export function ceilingReason(
  option: AgentToolVerdict,
  ceiling: AgentToolVerdict,
): string | null {
  return isLooserThan(option, ceiling)
    ? `Your admin set this to ${VERDICT_LABEL[ceiling]}.`
    : null;
}

export interface ToolGroups {
  /** The server says it only reads (`readOnly === true`). */
  looksUp: AgentConnectorTool[];
  /** Everything else — including tools that never said. */
  makesChanges: AgentConnectorTool[];
}

/**
 * Grouping follows the server's own hints, which are UNTRUSTED. They decide
 * where a row sits, never what it may do: a tool that claims to only read
 * still gets exactly the verdict the store holds. Unknown → "Makes changes",
 * the cautious side.
 */
export function groupTools(tools: readonly AgentConnectorTool[]): ToolGroups {
  return {
    looksUp: tools.filter((t) => t.readOnly === true),
    makesChanges: tools.filter((t) => t.readOnly !== true),
  };
}

export type ConnectorToolsStatus = 'loading' | 'ok' | 'unavailable' | 'failed';

/**
 * `saved-unconfirmed`: the store accepted it but we could not read it back
 * (TASK-757). The row shows what was written; the view says to reload.
 */
export type SetVerdictOutcome = 'saved' | 'saved-unconfirmed' | 'refused' | 'failed';

export interface ConnectorToolsState {
  data: AgentConnectorToolsRead | null;
  status: ConnectorToolsStatus;
  /** Tool keys with a write in flight. */
  pending: ReadonlySet<string>;
  setVerdict: (toolKey: string, verdict: AgentToolVerdict) => Promise<SetVerdictOutcome>;
  /** Re-read; `refresh` asks the server to check the connector again. */
  reload: (refresh?: boolean) => void;
}

export function useConnectorTools(agentId: string, connectorId: string): ConnectorToolsState {
  const [data, setData] = useState<AgentConnectorToolsRead | null>(null);
  const [status, setStatus] = useState<ConnectorToolsStatus>('loading');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // Only the newest read lands: switching connectors fast must never paint
  // one connector's tools under another's name.
  const scope = useRef(0);

  const load = useCallback(
    (refresh: boolean, quiet: boolean) => {
      const id = ++scope.current;
      if (!quiet) {
        setData(null);
        setStatus('loading');
      }
      void (async () => {
        try {
          const out = await workspaceApi.connectorTools(agentId, connectorId, refresh);
          if (scope.current !== id) return;
          setData(out);
          setStatus('ok');
        } catch (e) {
          if (scope.current !== id) return;
          logRequestFailure(e, 'connector-tools');
          // A failed read drops the list: old verdicts beside a failure read
          // as the current ones.
          setData(null);
          setStatus(e instanceof HttpError && e.status === 503 ? 'unavailable' : 'failed');
        }
      })();
    },
    [agentId, connectorId],
  );

  useEffect(() => {
    setPending(new Set());
    load(false, false);
  }, [load]);

  const setVerdict = useCallback(
    async (toolKey: string, verdict: AgentToolVerdict): Promise<SetVerdictOutcome> => {
      const atStart = scope.current;
      setPending((prev) => new Set(prev).add(toolKey));
      try {
        const out = await workspaceApi.setToolVerdict(agentId, connectorId, toolKey, verdict);
        if (scope.current === atStart) {
          setData((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  tools: prev.tools.map((t) =>
                    t.toolKey !== out.tool.toolKey
                      ? t
                      : out.unconfirmed === true
                        ? // No ceiling came back; keep the one we have.
                          { ...t, verdict: out.tool.verdict }
                        : { ...t, verdict: out.tool.verdict, ceiling: out.tool.ceiling },
                  ),
                },
          );
        }
        if (out.unconfirmed === true) {
          console.warn('[connector-tools] verdict saved but the server could not read it back');
          return 'saved-unconfirmed';
        }
        return out.tool.verdict === verdict ? 'saved' : 'refused';
      } catch (e) {
        logRequestFailure(e, 'connector-tools');
        // A 409 is the store refusing (most often: the admin tightened this
        // tool since the list was read). Re-read so the row shows the real
        // verdict and ceiling instead of the stale ones.
        if (e instanceof HttpError && e.status === 409) {
          load(false, true);
          return 'refused';
        }
        return 'failed';
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(toolKey);
          return next;
        });
      }
    },
    [agentId, connectorId, load],
  );

  const reload = useCallback((refresh = false) => load(refresh, false), [load]);

  return { data, status, pending, setVerdict, reload };
}
