import { useEffect, useRef, useState } from 'react';
import { EllipsisVertical, Plus, Search, X } from 'lucide-react';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { conversationControls } from '@/lib/conversation-controls';
import { filterChatsByTitle, type SidebarChatList } from '@/lib/sidebar-chats';
import { cn } from '@/lib/utils';

interface Props {
  agentId: string;
  chats: SidebarChatList | null;
  /** The read behind `chats` failed (only the shell's own read can). */
  error: boolean;
  /** Draw the open chat as selected — only true on the agent's own route. */
  showSelection: boolean;
  onOpen: (pastId: string | null) => void;
  onNew: () => Promise<void>;
  onChanged: () => void;
  onNavigate?: (() => void) | undefined;
  /** Mount with the search box already open (the collapsed rail's Search). */
  startSearching?: boolean;
}

// The right padding opens only while the row's ⋮ is showing (hover, focus,
// always on touch), so a title is never drawn underneath it.
const ROW =
  'h-9 w-full justify-start gap-2 rounded-sm px-2 text-[13px] font-normal group-hover:pr-9 group-focus-within:pr-9 max-md:h-11 max-md:pr-11';

/** New chat, Search, and the selected agent's chats — the expanded sidebar. */
export function SidebarChats({
  agentId,
  chats,
  error,
  showSelection,
  onOpen,
  onNew,
  onChanged,
  onNavigate,
  startSearching = false,
}: Props) {
  const [searching, setSearching] = useState(startSearching);
  const [query, setQuery] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    kind: 'rename' | 'delete';
  } | null>(null);
  const [title, setTitle] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  // A search typed for one agent is not a search of the next one's chats.
  const searchedAgent = useRef(agentId);
  useEffect(() => {
    if (searchedAgent.current === agentId) return;
    searchedAgent.current = agentId;
    setQuery('');
    setSearching(false);
  }, [agentId]);
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  async function act(action: () => Promise<void>) {
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
    } catch {
      setActionError('We couldn’t finish that just now. Please try again.');
    } finally {
      setActionBusy(false);
    }
  }
  function closeSearch() {
    setQuery('');
    setSearching(false);
    // The input is about to unmount; put the keyboard back where it came from.
    requestAnimationFrame(() => searchButtonRef.current?.focus());
  }

  const busy = actionBusy || chats?.busy === true;
  const filtering = query.trim() !== '';
  const past = chats ? filterChatsByTitle(chats.past, query) : [];
  const openPastId = showSelection ? (chats?.openPastId ?? null) : undefined;

  function menu(id: string, name: string) {
    return (
      // Not modal: Delete opens a dialog whose action removes this row, and the
      // menu with it; a modal menu would leave <body> unclickable.
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Options for ${name}`}
            className="absolute right-0 top-0 size-9 rounded-sm text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 max-md:size-11 max-md:opacity-100"
            disabled={busy}
          >
            <EllipsisVertical aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="shadow-popover">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onSelect={() => {
                setEditing({ id, title: name, kind: 'rename' });
                setTitle(name);
                setActionError(null);
              }}
            >
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void act(() => conversationControls.export(agentId, id))}
            >
              Export as text
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                setEditing({ id, title: name, kind: 'delete' });
                setActionError(null);
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <>
      <div className="flex shrink-0 flex-col gap-0.5">
        <Button
          variant="navigation"
          disabled={busy}
          onClick={() => {
            void act(async () => {
              await onNew();
              onNavigate?.();
            });
          }}
          className="h-10 w-full gap-2.5 px-2 max-md:min-h-11"
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          New chat
        </Button>
        {searching ? (
          <InputGroup className="h-10 max-md:h-11">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              // `text`, not `search`: the browser's own clear glyph would sit
              // beside ours, two X's for one action.
              type="text"
              role="searchbox"
              aria-label="Search chats by title"
              placeholder="Search chats"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              className="text-[13.5px]"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Close search"
                onClick={closeSearch}
              >
                <X aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ) : (
          <Button
            ref={searchButtonRef}
            variant="navigation"
            onClick={() => setSearching(true)}
            className="h-10 w-full gap-2.5 px-2 max-md:min-h-11"
          >
            <Search data-icon="inline-start" aria-hidden="true" />
            Search
          </Button>
        )}
      </div>

      <section aria-label="Chats" className="mt-4 flex min-h-0 flex-1 flex-col">
        <h2 className="mb-1 shrink-0 px-2 text-[11.5px] font-medium text-muted-foreground">
          Chats
        </h2>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-3">
          {actionError && !editing && (
            <Alert variant="destructive" className="mb-2">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {error && chats === null && (
            <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground">
              We couldn’t load these chats just now.
            </p>
          )}
          {chats !== null && (
            <ul className="flex flex-col gap-0.5">
              {!filtering && (
                <li className="group relative flex h-9 items-center rounded-sm max-md:h-11">
                  <Button
                    variant="ghost"
                    disabled={chats.busy}
                    aria-current={openPastId === null ? 'page' : undefined}
                    onClick={() => {
                      onOpen(null);
                      onNavigate?.();
                    }}
                    className={cn(ROW, openPastId === null && 'bg-primary-soft text-primary')}
                  >
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
                    <span className="min-w-0 flex-1 text-left">Current conversation</span>
                  </Button>
                  {chats.conversationId && menu(chats.conversationId, 'Current conversation')}
                </li>
              )}
              {past.map((c) => (
                <li key={c.id} className="group relative flex min-h-9 items-center rounded-sm">
                  <Button
                    variant="ghost"
                    disabled={chats.busy}
                    aria-label={c.title}
                    aria-current={openPastId === c.id ? 'page' : undefined}
                    onClick={() => {
                      onOpen(c.id);
                      onNavigate?.();
                    }}
                    className={cn(ROW, openPastId === c.id && 'bg-primary-soft text-primary')}
                  >
                    <span
                      className="conversation-title-fade min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left"
                      title={c.title}
                    >
                      {c.title}
                    </span>
                  </Button>
                  {menu(c.id, c.title)}
                </li>
              ))}
            </ul>
          )}
          {chats !== null && filtering && past.length === 0 && (
            <p role="status" className="px-2 py-1.5 text-[12.5px] text-muted-foreground">
              No chat titles match “{query.trim()}”.
            </p>
          )}
        </div>
      </section>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing?.kind === 'delete' ? 'Delete conversation?' : 'Rename conversation'}
            </DialogTitle>
            <DialogDescription>
              {editing?.kind === 'delete'
                ? 'This removes the conversation from your workspace.'
                : 'Give it a name that’s easy to find later.'}
            </DialogDescription>
          </DialogHeader>
          {editing?.kind === 'rename' && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="conversation-title">Name</FieldLabel>
                <Input
                  id="conversation-title"
                  value={title}
                  maxLength={256}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
            </FieldGroup>
          )}
          {actionError && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={actionBusy} onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant={editing?.kind === 'delete' ? 'destructive' : 'default'}
              disabled={actionBusy || (editing?.kind === 'rename' && !title.trim())}
              onClick={() => {
                if (!editing) return;
                const target = editing;
                void act(async () => {
                  if (target.kind === 'rename')
                    await conversationControls.rename(target.id, title.trim());
                  else {
                    await conversationControls.delete(target.id);
                    if (chats?.openPastId === target.id) onOpen(null);
                  }
                  setEditing(null);
                  onChanged();
                });
              }}
            >
              {actionBusy ? 'Saving…' : editing?.kind === 'delete' ? 'Delete' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
