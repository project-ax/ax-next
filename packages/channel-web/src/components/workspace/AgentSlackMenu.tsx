/**
 * The one ⋯ menu on an agent's Slack card (TASK-1187): the card's own
 * (Rename, Change picture, Remove from Slack, Cancel request).
 *
 * Two things here are load-bearing:
 * - It is not modal. An item's dialog can re-read the status and unmount this
 *   trigger, and a modal menu then leaves the page unclickable (production,
 *   2026-10-19).
 * - An item runs only after the menu has closed, with focus back on the ⋯, so
 *   a dialog it opens returns focus here on Cancel.
 */
import { useRef } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface AgentSlackMenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

export function AgentSlackMenu({
  label,
  items,
  disabled = false,
}: {
  label: string;
  items: readonly AgentSlackMenuItem[];
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const chosen = useRef<(() => void) | null>(null);
  // Nothing to offer: no ⋯ that opens onto an empty menu (items are hidden, never drawn disabled).
  if (items.length === 0) return null;
  const pick = (item: AgentSlackMenuItem) => () => {
    chosen.current = item.onSelect;
  };
  const plain = items.filter((i) => i.destructive !== true);
  const takeAway = items.filter((i) => i.destructive === true);
  return (
    // Not modal: an item's dialog can re-read the status and unmount this trigger (2026-10-19 freeze).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={label}
          disabled={disabled}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="shadow-popover"
        // Run the item once the menu has closed, with focus back on the ⋯, so a dialog it opens returns focus here.
        onCloseAutoFocus={(e) => {
          const run = chosen.current;
          chosen.current = null;
          if (run === null) return;
          e.preventDefault();
          trigger.current?.focus();
          setTimeout(run, 0);
        }}
      >
        {plain.length > 0 && (
          <DropdownMenuGroup>
            {plain.map((i) => (
              <DropdownMenuItem key={i.label} onSelect={pick(i)}>
                {i.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {plain.length > 0 && takeAway.length > 0 && <DropdownMenuSeparator />}
        {takeAway.length > 0 && (
          <DropdownMenuGroup>
            {takeAway.map((i) => (
              <DropdownMenuItem key={i.label} className="text-destructive focus:text-destructive" onSelect={pick(i)}>
                {i.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
