/**
 * The sidebar. Two destinations and a roster.
 *
 * Note what is NOT here: a conversation list. Conversations moved inside the
 * agent they belong to, which is the structural change the whole refresh is
 * about. The roster is the navigation now.
 *
 * The "New agent…" row at the foot of the nav opens the create-an-agent flow.
 * `App.tsx` supplies the callback, the same thread `onOpenAdminSettings` uses
 * for Settings. The row is prop-gated — rendered only when `onCreateAgent` is
 * passed — because a nav row that does nothing when clicked is worse than one
 * row fewer, and that's still true even now that the flow is reachable.
 */
import { Activity, Bot, ChevronDown, ChevronUp, Inbox, Plus } from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { UserMenu } from '@/components/UserMenu';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { NEW_AGENT_OPENER_ATTR } from '@/lib/new-agent-return-focus';
import { STATE_WORDS, StateDot } from './bits';

interface Props {
  agents: WorkspaceAgent[];
  route: 'today' | 'agent' | 'activity';
  activeAgentId: string | null;
  pendingCount: number;
  rosterOpen: boolean;
  onRoster: (open: boolean) => void;
  onToday: () => void;
  onActivity: () => void;
  onAgent: (id: string) => void;
  /** Opens Settings, via the `UserMenu` at the foot of this rail. */
  onOpenAdminSettings?: (() => void) | undefined;
  /**
   * Opens the create-an-agent flow. Rendered as a "New agent…" row at the
   * foot of the nav, only when supplied.
   */
  onCreateAgent?: (() => void) | undefined;
}

interface NavProps extends Props {
  /**
   * Fired after a destination is chosen. The off-canvas copy of this nav
   * (below `md` — see `WorkspaceShell`) uses it to close itself, because a
   * sheet that stays open over the thing you just asked for is a second tap
   * for no reason. Optional and unused on the desktop path, where the rail is
   * always on screen and there is nothing to close.
   */
  onNavigate?: (() => void) | undefined;
}

/**
 * The rail, minus the rail.
 *
 * Extracted so the same nav can be rendered in two frames: the fixed `<aside>`
 * below, and — below `md`, where 236px of a 390px viewport is most of the
 * screen — a `Sheet` the shell owns (TASK-404). It returns a FRAGMENT rather
 * than a container on purpose: the `<aside>`'s children stay exactly the flex
 * children they were, so the desktop layout does not change shape at all.
 */
export function WorkspaceSidebarNav({
  agents,
  route,
  activeAgentId,
  pendingCount,
  rosterOpen,
  onRoster,
  onToday,
  onActivity,
  onAgent,
  onOpenAdminSettings,
  onCreateAgent,
  onNavigate,
}: NavProps) {
  const row = (active: boolean) =>
    cn(
      'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px]',
      active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60',
    );

  /*
    Every row that MOVES you reports it; the Agents disclosure does not. Opening
    the roster is a step on the way to picking an agent, so closing the sheet on
    it would shut the panel in the middle of the gesture it exists for.
  */
  const go = (act: () => void) => () => {
    act();
    onNavigate?.();
  };

  return (
    <>
      <div className="flex h-14 items-center px-4">
        <BrandMark size="md" />
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        <button type="button" onClick={go(onToday)} className={row(route === 'today')}>
          <Inbox size={14} className="shrink-0" />
          Today
          {pendingCount > 0 && (
            <Badge className="ml-auto h-5 min-w-5 justify-center bg-warning-soft px-1.5 text-[11px] text-warning hover:bg-warning-soft">
              {pendingCount}
            </Badge>
          )}
        </button>

        <button
          type="button"
          onClick={go(onActivity)}
          className={row(route === 'activity')}
        >
          <Activity size={14} className="shrink-0" />
          Activity
        </button>

        <button
          type="button"
          onClick={() => onRoster(!rosterOpen)}
          className={row(route === 'agent')}
        >
          <Bot size={14} className="shrink-0" />
          Agents
          <span className="ml-auto text-[11.5px] text-muted-foreground">
            {agents.length}
          </span>
          {rosterOpen ? (
            <ChevronUp size={12} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={12} className="text-muted-foreground" />
          )}
        </button>

        {rosterOpen &&
          agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={go(() => onAgent(a.id))}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-md pl-8 pr-2.5 text-left text-[13px]',
                route === 'agent' && activeAgentId === a.id
                  ? 'bg-primary-soft text-primary'
                  : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              <StateDot state={a.state} />
              <span className="truncate" title={a.name}>
                {a.name}
              </span>
              {/*
                The dot is the only thing on this row that says the state, and
                it is `aria-hidden` (TASK-485). So the row SAYS it as well,
                after the name — "Ada, waiting on you". Sighted readers get the
                dot's shape as the non-colour channel; `StateDot` explains both.
              */}
              <span className="sr-only">, {STATE_WORDS[a.state].toLowerCase()}</span>
            </button>
          ))}

        {rosterOpen && agents.length === 0 && (
          <p className="px-2.5 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
            No agents yet.
          </p>
        )}

        {/*
          Not gated on `rosterOpen`: a collapsed roster must still have a
          create door, since reachability is the whole point of this row.
        */}
        {onCreateAgent && (
          <button
            type="button"
            onClick={go(onCreateAgent)}
            className={row(false)}
            // TASK-510 — where focus comes back to when the new-agent dialog
            // closes. The dialog replaces the whole workspace, so this node is
            // gone by then; the restore finds its successor by this attribute.
            // See `lib/new-agent-return-focus.ts`.
            {...{ [NEW_AGENT_OPENER_ATTR]: '' }}
          >
            <Plus size={14} className="shrink-0" />
            New agent…
          </button>
        )}
      </nav>

      {/*
        The shipping user menu, not a lookalike: it already owns the theme
        tri-toggle (Light / Dark / System) and the account row, and the whole
        point of the refresh is that this surface shares the app's chrome rather
        than growing a parallel copy of it.

        Rendered bare — it brings its own `border-t` and padding, so a wrapper
        adding either draws a second rule above it.

        `onOpenAdminSettings` is not optional in practice, whatever the type
        says: `UserMenu` renders its Settings entry unconditionally and calls
        `onOpenAdminSettings?.()`, so omitting it leaves a live-looking menu
        item that silently does nothing. This rail was doing exactly that until
        the workspace grew a Settings route.
      */}
      <UserMenu onOpenAdminSettings={onOpenAdminSettings} />
    </>
  );
}

/**
 * The rail itself — the desktop frame around `WorkspaceSidebarNav`.
 *
 * Rendered only at `md` and up now (`WorkspaceShell` branches on
 * `useIsCompact`), which is why `w-[236px] shrink-0` can stay unconditional:
 * the width is only ever asked of a viewport that has room for it.
 */
export function WorkspaceSidebar(props: Props) {
  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-border">
      <WorkspaceSidebarNav {...props} />
    </aside>
  );
}
