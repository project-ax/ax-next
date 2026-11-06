import { useState } from 'react';
import { Activity, Brain, Folder, Shapes } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CompactSurfaceContext } from '@/lib/use-compact';
import type { GrantRow, GrantRef } from '@/lib/workspace-api';

/**
 * What the side panel can show, each behind one of the chat header's icon
 * toggles. Order here is the order of the icons.
 */
export const RAIL_PANELS = {
  memory: { label: 'Memory', Icon: Brain },
  files: { label: 'Files', Icon: Folder },
  activity: { label: 'Activity', Icon: Activity },
  artifacts: { label: 'Artifacts', Icon: Shapes },
} as const;
export type RailPanel = keyof typeof RAIL_PANELS;
export const RAIL_PANEL_IDS = Object.keys(RAIL_PANELS) as RailPanel[];

export function isRailPanel(value: unknown): value is RailPanel {
  return typeof value === 'string' && (RAIL_PANEL_IDS as string[]).includes(value);
}

interface Props {
  panel: RailPanel;
  /** A muted aside next to the heading — e.g. "3 files". */
  meta?: string | null;
  /** A wider column, for a panel showing something to read (an open artifact). */
  wide?: boolean;
  children: React.ReactNode;
}

/**
 * The revoke state for a connector list: which rows are mid-revoke, and the
 * one sentence saying how the last one went.
 *
 * Owned by the PANEL that draws the list, never by a row — a successful
 * revoke removes the row, and a row-owned notice would unmount with it
 * (TASK-406). Used by the settings page's Connectors section.
 */
export function useGrantRevoke(
  revoke: (ref: GrantRef) => Promise<'revoked' | 'already-gone' | 'failed'>,
) {
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  async function onRevoke(row: GrantRow) {
    setNotice(null);
    setRevoking((prev) => new Set(prev).add(row.source));
    const outcome = await revoke(row.ref);
    setRevoking((prev) => {
      const next = new Set(prev);
      next.delete(row.source);
      return next;
    });
    if (outcome === 'revoked')
      setNotice(
        'Revoked. Anything already running may still have it until it finishes.',
      );
    if (outcome === 'already-gone') setNotice('That one was already gone.');
    if (outcome === 'failed')
      setNotice("We couldn't take that back just now. Nothing changed.");
  }
  return { revoking, notice, onRevoke };
}

/**
 * The desktop side panel. It has no tabs and no collapse control of its own:
 * the chat header's icons open it, switch it, and (pressed again) close it, so
 * there is one place that answers "how do I get this back".
 */
export function AgentRail(props: Props) {
  return (
    <aside
      aria-label={RAIL_PANELS[props.panel].label}
      className={cn(
        'flex min-h-0 shrink-0 flex-col border-l border-border',
        props.wide ? 'w-1/2 min-w-[480px]' : 'w-[320px]',
      )}
    >
      <AgentRailContent {...props} />
    </aside>
  );
}

/** One panel body for the desktop column and the phone/tablet sheet. */
export function AgentRailContent({ panel, meta, children }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4 pr-14 lg:pr-4">
        <h2 className="text-[14px] font-semibold">{RAIL_PANELS[panel].label}</h2>
        {meta && <span className="text-[12px] text-muted-foreground">{meta}</span>}
      </div>
      <CompactSurfaceContext.Provider value={true}>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">{children}</div>
      </CompactSurfaceContext.Provider>
    </div>
  );
}
