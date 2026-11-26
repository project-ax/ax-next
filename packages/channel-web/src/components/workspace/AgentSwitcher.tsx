import { useState } from 'react';
import { Check, ChevronsUpDown, EllipsisVertical, Plus, Settings, Trash2 } from 'lucide-react';
import { ConfirmAction, Stack, StatusMark, Text } from '@project-ax/ui';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { deleteAgent } from '@/lib/admin';
import { canDeleteAgent, canManageAgent } from '@/lib/agent-sharing';
import { focusAfterRemoval } from '@/lib/focus-after-removal';
import { personLabel, SHARING_COPY } from '@/lib/sharing-copy';
import { NEW_AGENT_OPENER_ATTR } from '@/lib/new-agent-return-focus';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { AgentTile, STATE_TONE, stateWord } from './bits';
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
  // Someone an agent is only shared with just chats; a co-owner can't delete.
  const canSettings = onOpenSettings !== undefined && canManageAgent(selected);
  const canDelete = onDeleted !== undefined && canDeleteAgent(selected);
  const switcherLabel = `${selected.name}, ${stateWord(selected.state).toLowerCase()}${othersWaiting ? `, another agent is ${stateWord('waiting').toLowerCase()}` : ''}. Switch agent`;

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
        <span className="absolute right-1 top-1">
          <StatusMark tone="warning" />
        </span>
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
        <StatusMark tone="warning" />
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
                  <StatusMark tone={STATE_TONE[a.state]} />
                  {/* A div, not a span: the shared-by row stacks block elements inside it. */}
                  <div className="min-w-0 flex-1 truncate" title={a.name}>
                    {a.sharedBy === undefined ? (
                      a.name
                    ) : (
                      // Who shared it, so two agents with one name aren't a
                      // guess. The name is fenced; `null` reads as "Shared
                      // with you".
                      <Stack gap="none">
                        <Text truncate>{a.name}</Text>
                        <Text role="caption" truncate>
                          {SHARING_COPY.sharedBy(a.sharedBy === null ? null : personLabel(a.sharedBy))}
                        </Text>
                      </Stack>
                    )}
                  </div>
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
        {!collapsed && (canSettings || canDelete) && (
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
              {canSettings && (
                <DropdownMenuItem onSelect={go(() => onOpenSettings(selected.id))}>
                  <Settings aria-hidden="true" />
                  Agent settings
                </DropdownMenuItem>
              )}
              {canSettings && canDelete && <DropdownMenuSeparator />}
              {canDelete && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => {
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
      {/* Same claim as the admin list's dialog (TASK-718): every item
          named here really is deleted. Data loss — plain, no jokes. */}
      <ConfirmAction
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete agent?"
        description={`Delete ${pendingDelete?.name ?? ''}? We will delete its conversations, the files in them, the files it saved and its routines along with it. This cannot be undone.`}
        confirmLabel="Delete agent"
        errorMessage={() => 'We couldn’t delete this agent just now, so nothing was removed. Please try again.'}
        onConfirm={async () => {
          if (pendingDelete === null) return;
          const target = pendingDelete;
          await deleteAgent(target.id);
          onDeleted?.(target.id);
          onNavigate?.();
          // The options menu belonged to the deleted agent; park focus on the agent switcher.
          focusAfterRemoval(`[${NEW_AGENT_OPENER_ATTR}]`);
        }}
      />
    </>
  );
}
