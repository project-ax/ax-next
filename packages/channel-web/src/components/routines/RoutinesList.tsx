/**
 * RoutinesList — row-style list mirroring CredentialsList, with each row
 * collapsible to show recent fires.
 *
 * Phase D shape only. Fetches `await routines.list()` (no agent filter
 * — most users have one or two agents; the agent label per row keeps
 * the noise low). Each row's "expanded" body fetches fires lazily via
 * `routines.recentFires({ agentId, path, limit: 20 })` so we don't pay
 * for the full audit trail until the operator asks.
 *
 * The list and the expanded fires both go through React's default
 * escaping. Rendered prompts are font-mono + truncated + show-more,
 * matching the existing "subtitle" treatment in CredentialsList for
 * fixed-width strings.
 */
import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaneStatus } from '../PaneStatus';
import { routines, type Routine, type Fire } from '../../lib/routines';
import { TriggerChip } from './TriggerChip';
import { StatusChip } from './StatusChip';
import { FireRowsTable } from './FireRowsTable';
import { FireNowControl } from './FireNowControl';

export interface RoutinesListProps {
  refreshKey?: number;
  onFired: () => void;
}

function relativeTime(d: Date | null): string {
  if (d === null) return 'never';
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1_000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function RoutinesList({ refreshKey = 0, onFired }: RoutinesListProps) {
  const [list, setList] = useState<Routine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Keyed by `agentId::path` so flipping between rows doesn't drop the
  // cached fires when an operator re-opens the same row.
  const [fires, setFires] = useState<Record<string, Fire[] | undefined>>({});
  const [firesError, setFiresError] = useState<Record<string, string | undefined>>({});

  async function reload(): Promise<void> {
    setError(null);
    try {
      setList(await routines.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void reload();
  }, [refreshKey]);

  async function loadFires(agentId: string, path: string): Promise<void> {
    const key = `${agentId}::${path}`;
    setFiresError((m) => ({ ...m, [key]: undefined }));
    try {
      const rows = await routines.recentFires({ agentId, path, limit: 20 });
      setFires((m) => ({ ...m, [key]: rows }));
    } catch (err) {
      setFiresError((m) => ({ ...m, [key]: err instanceof Error ? err.message : String(err) }));
    }
  }

  function toggle(agentId: string, path: string): void {
    const key = `${agentId}::${path}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (fires[key] === undefined) void loadFires(agentId, path);
  }

  if (list === null && error === null) {
    return <PaneStatus variant="loading">Loading…</PaneStatus>;
  }
  if (list === null && error !== null) {
    return <PaneStatus variant="error">Error: {error}</PaneStatus>;
  }

  return (
    <>
      {error !== null && (
        <div
          role="alert"
          className="px-3 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive flex items-center gap-2 mb-3"
        >
          <span className="flex-1">Error: {error}</span>
          <Button variant="ghost" size="sm" aria-label="Dismiss error" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {list!.length === 0 ? (
        <PaneStatus variant="empty">
          No routines yet. Routines live in <code className="font-mono">.ax/routines/*.md</code> in
          the agent's workspace — create one via chat or git.
        </PaneStatus>
      ) : (
        <div className="flex flex-col">
          {list!.map((r) => {
            const key = `${r.agentId}::${r.path}`;
            const isOpen = expanded === key;
            return (
              <div key={key} className="border-b border-rule-soft last:border-b-0">
                <div className="py-[1.125rem] flex items-center gap-3.5">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? `Collapse ${r.name}` : `Expand ${r.name}`}
                    onClick={() => toggle(r.agentId, r.path)}
                    className="w-8 h-8 rounded-md bg-muted inline-flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronRight
                      className="h-3.5 w-3.5 transition-transform duration-150"
                      style={{ transform: isOpen ? 'rotate(90deg)' : undefined }}
                      strokeWidth={1.4}
                      aria-hidden="true"
                    />
                  </button>
                  <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <span className="text-[15px] font-medium tracking-[-0.01em] truncate">
                      {r.name}
                    </span>
                    <span className="text-[12.5px] text-muted-foreground font-mono tracking-[0.02em] truncate">
                      {r.agentId} · {r.path}
                    </span>
                  </span>
                  <TriggerChip trigger={r.trigger} />
                  <StatusChip status={r.lastStatus} />
                  <span className="text-[12px] text-muted-foreground tabular-nums w-[5.5rem] text-right shrink-0">
                    {relativeTime(r.lastRunAt)}
                  </span>
                  <FireNowControl
                    routine={r}
                    onFired={() => {
                      onFired();
                      // Re-pull fires for this row immediately so the new
                      // row appears at the top without waiting for the
                      // collapse/expand cycle.
                      if (isOpen) void loadFires(r.agentId, r.path);
                    }}
                  />
                </div>
                {isOpen && (
                  <div className="pb-4 pl-[2.875rem] pr-2 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                    {firesError[key] !== undefined ? (
                      <div className="text-[12.5px] text-destructive">Error: {firesError[key]}</div>
                    ) : fires[key] === undefined ? (
                      <div className="text-[12.5px] text-muted-foreground">Loading fires…</div>
                    ) : fires[key]!.length === 0 ? (
                      <div className="text-[12.5px] text-muted-foreground">No fires yet.</div>
                    ) : (
                      <FireRowsTable fires={fires[key]!} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
