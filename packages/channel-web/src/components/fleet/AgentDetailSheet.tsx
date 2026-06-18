/**
 * AgentDetailSheet — the right-side slide-over for one agent.
 *
 * Keeps the wall in view (no navigation). Three stacked regions:
 *   NOW             — the live turn: activity, phase, a tail of the stream,
 *                     and "Stop this turn" (maps to session:terminate).
 *   RECENT ACTIVITY — the agent's recent runs, each a deep link into that thread.
 *   Configuration   — model/tools/connectors, behind a Collapsible (collapsed by
 *                     default — progressive disclosure; monitoring ≠ configuring).
 */
import { useState } from 'react';
import { ArrowRight, ChevronRight, ExternalLink, Pause, Settings2, Square } from 'lucide-react';
import type { FleetActivityItem, FleetAgent } from '../../lib/fleet-data';
import { STATUS_META } from './status-meta';
import { AvatarTile } from '../AvatarTile';
import { Button } from '../ui/button';
import { Sheet, SheetContent } from '../ui/sheet';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { cn } from '@/lib/utils';

export function AgentDetailSheet({
  agent,
  open,
  onOpenChange,
  onEnterChat,
}: {
  agent: FleetAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnterChat: (id: string) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        {agent && <DetailBody agent={agent} onEnterChat={onEnterChat} />}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({ agent, onEnterChat }: { agent: FleetAgent; onEnterChat: (id: string) => void }) {
  const meta = STATUS_META[agent.status];
  const isWorker = agent.kind === 'worker';

  return (
    <>
      {/* Header */}
      <div className="border-b border-border p-5">
        <div className="flex items-center gap-3">
          <AvatarTile size={34}>
            <span
              className="h-2 w-2 rounded-full bg-primary"
              style={agent.color ? { background: agent.color } : undefined}
            />
          </AvatarTile>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] font-medium tracking-[-0.01em] text-foreground">
              {agent.name}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {agent.model} · {agent.toolCount} tools · {agent.connectorCount} connectors
            </div>
          </div>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              meta.badge,
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} aria-hidden="true" />
            {meta.label}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {isWorker ? (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!agent.prNumber}
              onClick={() => agent.prNumber && window.open(`#pr-${agent.prNumber}`, '_blank')}
            >
              Watch PR {agent.prNumber ? `#${agent.prNumber}` : ''} <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="sm" className="gap-1.5" onClick={() => onEnterChat(agent.id)}>
              Enter chat <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
          {agent.status === 'working' && (
            <Button variant="outline" size="sm" className="gap-1.5">
              <Pause className="h-3.5 w-3.5" /> Pause
            </Button>
          )}
          <Button variant="ghost" size="sm" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" /> Configure
          </Button>
        </div>
      </div>

      {/* NOW */}
      <section className="border-b border-border p-5">
        <SectionLabel>{agent.status === 'idle' ? 'Last run' : 'Now'}</SectionLabel>
        <p className="mt-2 text-[14px] text-foreground">{agent.activity}</p>
        {agent.status === 'waiting' && agent.request && (
          <p className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-foreground">
            {agent.name} {agent.request}. Open the chat to approve or decline.
          </p>
        )}
        {agent.status === 'error' && (
          <p className="mt-2 rounded-md bg-destructive-soft px-3 py-2 text-[13px] text-foreground">
            Stopped mid-task — the sandbox went away before the turn finished. Nothing was lost; you can
            pick up right where it left off.
          </p>
        )}
        {agent.phase && agent.status === 'working' && (
          <p className="mt-2 font-mono text-[11.5px] text-muted-foreground">{agent.phase}…</p>
        )}
        {agent.liveTail && agent.liveTail.length > 0 && (
          <div className="mt-3 rounded-md border border-border bg-muted/50 p-3">
            <div className="space-y-1 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
              {agent.liveTail.map((line, i) => (
                <div key={i} className="truncate">
                  <span className="text-ink-ghost">{'> '}</span>
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
        {agent.status === 'working' && (
          <Button variant="outline" size="sm" className="mt-3 gap-1.5">
            <Square className="h-3 w-3" /> Stop this turn
          </Button>
        )}
      </section>

      {/* RECENT */}
      <section className="border-b border-border p-5">
        <SectionLabel>Recent activity</SectionLabel>
        <ul className="mt-2 -mx-2">
          {agent.recent.map((item) => (
            <RecentRow key={item.id} item={item} />
          ))}
        </ul>
      </section>

      {/* CONFIG (collapsed) */}
      <Collapsible className="p-5">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            Configuration
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-2 text-[13px]">
          <ConfigRow label="Model" value={agent.model} />
          <ConfigRow label="Tools" value={`${agent.toolCount} allowed`} />
          <ConfigRow label="Connectors" value={`${agent.connectorCount} attached`} />
          <ConfigRow label="Kind" value={isWorker ? 'Autonomous board worker' : 'Interactive agent'} />
          <p className="pt-1 text-[12px] text-muted-foreground">
            Open <span className="text-foreground">Configure</span> to change the model, tools, or
            connectors. We keep those off this view so monitoring stays calm.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </div>
  );
}

function RecentRow({ item }: { item: FleetActivityItem }) {
  const stateColor =
    item.state === 'working'
      ? 'text-primary'
      : item.state === 'failed'
        ? 'text-destructive'
        : 'text-muted-foreground';
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{item.title}</span>
        <span className={cn('text-[11px]', stateColor)}>{item.state}</span>
        <span className="text-[11px] text-muted-foreground">{item.when}</span>
      </button>
    </li>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}
