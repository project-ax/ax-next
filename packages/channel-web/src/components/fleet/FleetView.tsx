/**
 * FleetView — the fleet overview "wall".
 *
 * A peer surface to Chat and Settings, opened as a full-pane overlay from the
 * user menu (same pattern as AdminShell). Answers, at a glance: does anything
 * need me, and what's moving? — via a count line and status-grouped cards
 * (needs you → working → stopped → idle). Clicking Details opens the agent
 * detail sheet; Chat / Review request drops into the normal Thread.
 *
 * Data here is mock (see fleet-data.ts). A real build swaps the store's seed for
 * GET /api/fleet + a GET /api/fleet/stream SSE feed; the component layer is
 * unchanged.
 */
import { Search, X } from 'lucide-react';
import {
  fleetStoreActions,
  groupByStatus,
  selectVisibleAgents,
  useFleetStore,
  type FleetFilter,
} from '../../lib/fleet-store';
import { STATUS_META } from './status-meta';
import { FleetCard } from './FleetCard';
import { AgentDetailSheet } from './AgentDetailSheet';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '@/lib/utils';

const FILTERS: Array<{ id: FleetFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'interactive', label: 'Interactive' },
  { id: 'worker', label: 'Workers' },
  { id: 'mine', label: 'Mine' },
];

export function FleetView({
  onClose,
  onEnterChat,
}: {
  onClose: () => void;
  onEnterChat: (agentId: string) => void;
}) {
  const state = useFleetStore();
  const visible = selectVisibleAgents(state);
  const groups = groupByStatus(visible);

  const workingCount = state.agents.filter((a) => a.status === 'working').length;
  const needsYou = state.agents.filter((a) => a.status === 'waiting').length;

  const detailAgent = state.agents.find((a) => a.id === state.detailAgentId) ?? null;

  const handleEnterChat = (id: string): void => {
    fleetStoreActions.closeDetail();
    onEnterChat(id);
  };

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">Fleet</h1>
          <span className="text-[13px] text-muted-foreground">
            {state.agents.length} agents · {workingCount} working now
            {needsYou > 0 && (
              <> · <span className="font-medium text-warning">{needsYou} needs you</span></>
            )}
          </span>
          <Button variant="ghost" size="icon" className="ml-auto h-8 w-8" onClick={onClose} aria-label="Close fleet">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Filter + search */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => fleetStoreActions.setFilter(f.id)}
                data-active={state.filter === f.id || undefined}
                className={cn(
                  'rounded-sm px-2.5 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground',
                  'data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={state.query}
              onChange={(e) => fleetStoreActions.setQuery(e.target.value)}
              placeholder="Search agents or tasks…"
              className="h-9 pl-8"
            />
          </div>
        </div>
      </div>

      {/* Wall */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {groups.length === 0 ? (
          <EmptyState hasAgents={state.agents.length > 0} />
        ) : (
          <div className="space-y-7">
            {groups.map(([status, list]) => (
              <section key={status}>
                <div className="mb-3 flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full', STATUS_META[status].dot)} aria-hidden="true" />
                  <h2 className="text-[13px] font-medium text-foreground">
                    {STATUS_META[status].heading}
                  </h2>
                  <span className="text-[12px] text-muted-foreground">{list.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {list.map((agent) => (
                    <FleetCard
                      key={agent.id}
                      agent={agent}
                      onDetails={fleetStoreActions.openDetail}
                      onEnterChat={handleEnterChat}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <AgentDetailSheet
        agent={detailAgent}
        open={detailAgent !== null}
        onOpenChange={(open) => !open && fleetStoreActions.closeDetail()}
        onEnterChat={handleEnterChat}
      />
    </div>
  );
}

function EmptyState({ hasAgents }: { hasAgents: boolean }) {
  return (
    <div className="mx-auto mt-16 max-w-sm text-center">
      <h2 className="text-[15px] font-medium text-foreground">
        {hasAgents ? 'Nothing matches that filter' : 'No agents yet'}
      </h2>
      <p className="mt-1.5 text-[13px] text-muted-foreground">
        {hasAgents
          ? 'Try a different filter or clear your search.'
          : 'Agents are your standing crew — they keep working while you’re away. Create your first one to see it here.'}
      </p>
    </div>
  );
}
