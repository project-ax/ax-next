/**
 * State for the connector editor's "Tool permissions" section (TASK-737).
 *
 * The editor owns this hook so its Save can PUT the changed rows after the
 * connector PATCH succeeds; the section component just renders it. Edits are
 * kept apart from the loaded data so a "Check again" reload doesn't wipe what
 * the person already picked.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectorRouteBase } from './connectors';
import {
  changedRows,
  getToolPermissions,
  initialVerdicts,
  savedVerdicts,
  ToolPermissionsError,
  type ToolPermissions,
  type ToolVerdict,
  type VerdictChange,
} from './connector-tool-permissions';

export type ToolPermissionsLoad =
  /** Nothing to show: a new connector, or one this person can't edit (403). */
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: ToolPermissions };

export interface ToolPermissionsState {
  load: ToolPermissionsLoad;
  verdicts: ReadonlyMap<string, ToolVerdict>;
  setVerdict: (toolKey: string, verdict: ToolVerdict) => void;
  /** Reload; `refresh` asks the server to check the connector again. */
  reload: (refresh?: boolean) => void;
  /** Rows to PUT on Save — empty unless the section has loaded. */
  changes: VerdictChange[];
  /** Tools still showing the untouched prefill: no saved default, and the
   *  person hasn't picked a choice for them. Save writes these too, so the
   *  section marks them "Suggested" until then (TASK-764). */
  suggested: ReadonlySet<string>;
}

export function useToolPermissions(
  connectorId: string | undefined,
  base: ConnectorRouteBase,
): ToolPermissionsState {
  const [load, setLoad] = useState<ToolPermissionsLoad>(
    connectorId ? { kind: 'loading' } : { kind: 'hidden' },
  );
  const [edits, setEdits] = useState<ReadonlyMap<string, ToolVerdict>>(new Map());
  const [request, setRequest] = useState({ n: 0, refresh: false });

  useEffect(() => {
    if (!connectorId) {
      setLoad({ kind: 'hidden' });
      return;
    }
    let stale = false;
    setLoad({ kind: 'loading' });
    void getToolPermissions(connectorId, base, { refresh: request.refresh }).then(
      (data) => {
        if (!stale) setLoad({ kind: 'ready', data });
      },
      (err: unknown) => {
        if (stale) return;
        setLoad(
          err instanceof ToolPermissionsError && err.status === 403
            ? { kind: 'hidden' }
            : { kind: 'error' },
        );
      },
    );
    return () => {
      stale = true;
    };
  }, [connectorId, base, request]);

  const data = load.kind === 'ready' ? load.data : null;
  const verdicts = useMemo(() => {
    const out = new Map(data ? initialVerdicts(data) : []);
    // An edit only applies to a row the current load still shows.
    for (const [k, v] of edits) if (out.has(k)) out.set(k, v);
    return out;
  }, [data, edits]);
  const changes = useMemo(
    () => (data ? changedRows(savedVerdicts(data), verdicts) : []),
    [data, verdicts],
  );
  const suggested = useMemo(() => {
    if (!data) return new Set<string>();
    const saved = new Set(data.defaults.map((d) => d.toolKey));
    return new Set(
      data.tools
        .map((t) => t.toolKey)
        .filter((k) => !saved.has(k) && !edits.has(k)),
    );
  }, [data, edits]);
  const setVerdict = useCallback((toolKey: string, verdict: ToolVerdict) => {
    setEdits((current) => new Map(current).set(toolKey, verdict));
  }, []);
  const reload = useCallback((refresh = false) => {
    setRequest((r) => ({ n: r.n + 1, refresh }));
  }, []);

  return { load, verdicts, setVerdict, reload, changes, suggested };
}
