import { useState } from 'react';
import { Check, ChevronsUpDown, EllipsisVertical, Plus, Settings, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { deleteAgent } from '@/lib/admin';
import { NEW_AGENT_OPENER_ATTR } from '@/lib/new-agent-return-focus';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { AgentTile, StateDot, StateDotSlot, stateWord } from './bits';
import { IconTooltip } from './IconTooltip';

interface Props {
  agents: WorkspaceAgent[];
  /** The agent the sidebar is about. `null` only when there are no agents. */
  selected: WorkspaceAgent | null;
  onSelect: (id: string) => void;
  onCreateAgent?: (() => void) | undefined;
  onOpenSettings?: ((id: string) => void) | undefined;
  /** Called after the server confirmed the delete. */
  onDeleted?: ((id: string) => void) | undefined;
  collapsed?: boolean;
  onNavigate?: (() => void) | undefined;
}

/**
 * Which agent the sidebar — and its chat list — is about, plus that agent's
 * own menu.
 *
 * THE ⋮ SITS BESIDE THE SWITCHER, NOT INSIDE ITS ROWS. A button nested in a
 * `menuitem` is a control inside a control: screen readers announce one or the
 * other, and arrow keys skip it. So the agent menu acts on the SELECTED agent,
 * and acting on another one is "switch to it first" — one extra click, and a
 * menu every keyboard can reach.
 */
export function AgentSwitcher({
  agents,
  selected,
  onSelect,
  onCreateAgent,
  onOpenSettings,
  onDeleted,
  collapsed = false,
  onNavigate,
}: Props) {
  const [pendingDelete, setPendingDelete] = useState<WorkspaceAgent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const go = (act: () => void) => () => {
    act();
    onNavigate?.();
  };

  if (selected === null) {
    // No agents yet: a menu with nothing to pick is a worse version of the
    // one action that is actually available.
    if (!onCreateAgent) return null;
    return collapsed ? (
      <IconTooltip label="New agent" side="right">
        <Button
          variant="ghost"
          size="icon"
          aria-label="New agent"
          onClick={go(onCreateAgent)}
          {...{ [NEW_AGENT_OPENER_ATTR]: '' }}
        >
          <Plus aria-hidden="true" />
        </Button>
      </IconTooltip>
    ) : (
      <Button
        variant="outline"
        onClick={go(onCreateAgent)}
        className="h-10 w-full justify-start gap-2.5 px-2.5 max-md:min-h-11"
        {...{ [NEW_AGENT_OPENER_ATTR]: '' }}
      >
        <Plus data-icon="inline-start" aria-hidden="true" />
        Create your first agent
      </Button>
    );
  }

  /*
    Another agent waiting on you is the one thing the old always-open roster
    showed at a glance that a closed menu would hide. One dot on the trigger
    keeps it; Today's badge is still the count.
  */
  const othersWaiting = agents.some(
    (a) => a.id !== selected.id && a.state === 'waiting',
  );
  const switcherLabel = `${selected.name}, ${stateWord(selected.state).toLowerCase()}. Switch agent`;

  const trigger = collapsed ? (
    <Button
      variant="ghost"
      size="icon"
      aria-label={switcherLabel}
      className="relative rounded-sm"
      {...{ [NEW_AGENT_OPENER_ATTR]: '' }}
    >
      <AgentTile agent={selected} size={24} />
      {othersWaiting && (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 size-1.5 rounded-full bg-warning"
        />
      )}
    </Button>
  ) : (
    <Button
      variant="ghost"
      aria-label={switcherLabel}
      className="h-10 min-w-0 flex-1 justify-start gap-2.5 rounded-sm px-2 font-normal hover:bg-accent data-[state=open]:bg-accent max-md:min-h-11"
      // The new-agent flow replaces the whole workspace, so its own row (in
      // this menu) is gone on return; the switcher is the control on screen
      // that leads back to it.
      {...{ [NEW_AGENT_OPENER_ATTR]: '' }}
    >
      <AgentTile agent={selected} size={24} />
      <span className="min-w-0 flex-1 truncate text-left text-[14px] font-medium" title={selected.name}>
        {selected.name}
      </span>
      {othersWaiting && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-warning"
        />
      )}
      <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </Button>
  );

  return (
    <>
      <div className={cn('flex items-center gap-0.5', collapsed && 'justify-center')}>
        <DropdownMenu>
          {collapsed ? (
            <IconTooltip label="Switch agent" side="right">
              <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            </IconTooltip>
          ) : (
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          )}
          <DropdownMenuContent
            align="start"
            side={collapsed ? 'right' : 'bottom'}
            sideOffset={4}
            className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 max-w-72 p-1.5 shadow-popover"
          >
            <DropdownMenuGroup className="max-h-[50vh] overflow-y-auto">
              {agents.map((a) => (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={go(() => onSelect(a.id))}
                  className="min-h-9 gap-2.5 px-2 text-[13.5px]"
                >
                  <StateDotSlot>
                    <StateDot state={a.state} />
                  </StateDotSlot>
                  <span className="min-w-0 flex-1 truncate" title={a.name}>
                    {a.name}
                  </span>
                  <span className="sr-only">, {stateWord(a.state).toLowerCase()}</span>
                  {a.id === selected.id && (
                    <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {onCreateAgent && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={go(onCreateAgent)}
                  className="min-h-9 gap-2.5 px-2 text-[13.5px]"
                >
                  <Plus aria-hidden="true" />
                  New agent
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {!collapsed && (onOpenSettings || onDeleted) && (
          // Not modal: Delete opens a dialog, and a modal menu closing into a
          // modal dialog leaves <body> unclickable (same as the chat rows).
          <DropdownMenu modal={false}>
            <IconTooltip label={`${selected.name} options`} side="bottom">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Options for ${selected.name}`}
                  className="size-8 shrink-0 rounded-sm text-muted-foreground data-[state=open]:bg-accent max-md:size-11"
                >
                  <EllipsisVertical aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </IconTooltip>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-48 shadow-popover">
              {onOpenSettings && (
                <DropdownMenuItem onSelect={go(() => onOpenSettings(selected.id))}>
                  <Settings aria-hidden="true" />
                  Agent settings
                </DropdownMenuItem>
              )}
              {onOpenSettings && onDeleted && <DropdownMenuSeparator />}
              {onDeleted && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => {
                    setDeleteError(null);
                    setPendingDelete(selected);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Delete agent…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent?</DialogTitle>
            {/* Same claim as the admin list's dialog (TASK-718): every item
                named here really is deleted. Data loss — plain, no jokes. */}
            <DialogDescription>
              Delete{' '}
              <span className="font-medium text-foreground">{pendingDelete?.name}</span>?
              We will delete its conversations, the files in them, the files it
              saved and its routines along with it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                const target = pendingDelete;
                if (!target) return;
                setDeleting(true);
                setDeleteError(null);
                deleteAgent(target.id)
                  .then(() => {
                    setPendingDelete(null);
                    onDeleted?.(target.id);
                    onNavigate?.();
                  })
                  .catch(() => {
                    setDeleteError(
                      'We couldn’t delete this agent just now, so nothing was removed. Please try again.',
                    );
                  })
                  .finally(() => setDeleting(false));
              }}
            >
              {deleting ? 'Deleting…' : 'Delete agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
