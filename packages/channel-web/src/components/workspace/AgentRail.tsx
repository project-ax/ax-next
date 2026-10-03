import { useState } from 'react';
import {
  Activity,
  Folder,
  Lightbulb,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Plug,
  Plus,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CompactSurfaceContext } from '@/lib/use-compact';
import { cn } from '@/lib/utils';
import { conversationControls } from '@/lib/conversation-controls';
import { conversationDate } from '@/lib/workspace-time';
import { useAgentRail } from '@/lib/workspace-rail';
import { WORKSPACE_AGENT_TABS, type AgentTab } from '@/lib/workspace-route';
import type { AgentRailData, AgentDetail, GrantRow } from '@/lib/workspace-api';
import {
  AgentTile,
  Elapsed,
  SectionLabel,
  StateDot,
  stateWord,
} from './bits';
import { ConnectorsTab } from './ConnectorsTab';
import { IconTooltip } from './IconTooltip';

export const RAIL_TABS = {
  activity: { label: 'Activity', Icon: Activity },
  chat: { label: 'Conversations', Icon: MessageSquare },
  memory: { label: 'Memory', Icon: Lightbulb },
  files: { label: 'Files', Icon: Folder },
  connectors: { label: 'Connectors', Icon: Plug },
} satisfies Record<AgentTab, { label: string; Icon: typeof Activity }>;

interface Props {
  detail: AgentDetail;
  learned?: React.ReactNode;
  openPastId: string | null;
  onOpenPast: (id: string | null) => void;
  tab?: AgentTab;
  onTab?: (tab: AgentTab) => void;
  collapsed?: boolean;
  onCollapse?: () => void;
  mobile?: boolean;
  panels?: Partial<Record<AgentTab, React.ReactNode>>;
  onChanged?: () => void;
  onNew?: () => Promise<void>;
  busy?: boolean;
  counts?: { memory: number | null; files: number | null };
}

export function AgentRail(props: Props) {
  return (
    <aside
      aria-label="Agent details"
      className={cn(
        'flex min-h-0 shrink-0 flex-col border-l border-border',
        props.collapsed ? 'w-[52px]' : 'w-[296px]',
      )}
    >
      <AgentRailContent {...props} />
    </aside>
  );
}

/** One panel implementation for the desktop rail and the phone sheet. */
export function AgentRailContent({
  detail,
  learned,
  openPastId,
  onOpenPast,
  tab = 'chat',
  onTab,
  collapsed = false,
  onCollapse,
  mobile = false,
  panels,
  onChanged,
  onNew,
  busy = false,
  counts,
}: Props) {
  const { agent, past } = detail;
  const { rail, loading, error, revoke, refresh } = useAgentRail(agent.id);
  const [localTab, setLocalTab] = useState<AgentTab>(tab);
  const active = onTab ? tab : localTab;
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [editing, setEditing] = useState<{
    id: string;
    title: string;
    kind: 'rename' | 'delete';
  } | null>(null);
  const [title, setTitle] = useState('');

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
  function select(next: AgentTab) {
    if (onTab) onTab(next);
    else setLocalTab(next);
    if (collapsed) onCollapse?.();
  }
  function menu(id: string, name: string) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Options for ${name}`}
            className="absolute right-0 top-0 size-9 rounded-sm opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 max-md:size-11 max-md:opacity-100"
            disabled={actionBusy || busy}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="shadow-popover"
        >
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
              onSelect={() =>
                void act(() => conversationControls.export(agent.id, id))
              }
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
  const count =
    active === 'memory' && counts?.memory != null
        ? `${counts.memory} ${counts.memory === 1 ? 'note' : 'notes'}`
        : active === 'files' && counts?.files != null
          ? `${counts.files} ${counts.files === 1 ? 'file' : 'files'}`
          : null;
  return (
    <Tabs
      value={active}
      onValueChange={(v) => select(v as AgentTab)}
      orientation={collapsed ? 'vertical' : 'horizontal'}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 px-4',
          collapsed && 'justify-center px-0',
          mobile && 'pr-14',
        )}
      >
        {!collapsed && (
          <>
            <AgentTile agent={agent} size={28} />
            <span
              className="min-w-0 truncate font-brand text-[15px] font-semibold"
              title={agent.name}
            >
              {agent.name}
            </span>
          </>
        )}
        {!mobile && onCollapse && (
          <IconTooltip
            label={collapsed ? 'Show agent details' : 'Hide agent details'}
            side="left"
            className={collapsed ? '' : 'ml-auto'}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={onCollapse}
              aria-label={
                collapsed ? 'Show agent details' : 'Hide agent details'
              }
              className={cn(
                'size-7 rounded-sm text-muted-foreground',
                !collapsed && 'ml-auto',
              )}
            >
              <PanelRight aria-hidden="true" />
            </Button>
          </IconTooltip>
        )}
      </div>
      <TabsList
        aria-label="Agent detail tabs"
        className={cn(
          'flex h-[52px] shrink-0 justify-between rounded-none border-b border-border bg-transparent px-2 py-1.5 max-md:h-[56px]',
          collapsed && 'h-auto flex-col gap-1 border-b-0 px-1 py-2',
        )}
      >
        {WORKSPACE_AGENT_TABS.map((value) => {
          const { Icon, label } = RAIL_TABS[value];
          return (
            <IconTooltip
              key={value}
              label={label}
              side={collapsed ? 'left' : 'bottom'}
            >
              <TabsTrigger
                value={value}
                aria-label={label}
                onClick={() => {
                  if (collapsed && value === active) onCollapse?.();
                }}
                className="relative size-10 shrink-0 rounded-sm p-0 text-muted-foreground hover:bg-accent data-[state=active]:bg-primary-soft data-[state=active]:text-primary data-[state=active]:shadow-none max-md:size-11"
              >
                <Icon aria-hidden="true" className="size-4" />
                {value === 'activity' && agent.state === 'working' && (
                  <span
                    aria-hidden="true"
                    className="absolute right-2 top-2 size-1.5 rounded-full bg-primary"
                  />
                )}
              </TabsTrigger>
            </IconTooltip>
          );
        })}
      </TabsList>
      {!collapsed && (
        <TabsContent
          value={active}
          forceMount
          className="mt-0 flex min-h-0 flex-1 flex-col"
        >
          {/*
            The Connectors tab has no visible title (product decision,
            TASK-738): its sections say what they are. The h2 stays for the
            heading outline, so the rail's h3s still hang off it.
          */}
          <div
            className={cn(
              'flex h-12 shrink-0 items-center gap-2 px-4',
              active === 'connectors' && 'h-4',
            )}
          >
            <h2
              className={cn(
                'text-[14px] font-semibold',
                active === 'connectors' && 'sr-only',
              )}
            >
              {RAIL_TABS[active].label}
            </h2>
            {count && (
              <span className="text-[12px] text-muted-foreground">{count}</span>
            )}
            {active === 'chat' && onNew && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || actionBusy}
                onClick={() => void act(onNew)}
                className="ml-auto h-7 rounded-sm px-1.5 text-[12.5px]"
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                New
              </Button>
            )}
          </div>
          <CompactSurfaceContext.Provider value={true}>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
              {actionError && !editing && (
                <Alert variant="destructive" className="mb-3">
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              )}
              {active === 'activity' && (
                <>
                  <SectionLabel>Right now</SectionLabel>
                  <RightNow
                    agent={agent}
                    rail={rail}
                    loading={loading}
                    error={error}
                  />
                  <ThisWeek rail={rail} loading={loading} error={error} />
                  <SectionLabel>Recent activity</SectionLabel>
                  {panels?.activity}
                </>
              )}
              {active === 'chat' && (
                <div className="flex flex-col gap-0.5">
                  <div className="group relative flex h-9 items-center rounded-sm max-md:h-11">
                    <Button
                      variant="ghost"
                      onClick={() => onOpenPast(null)}
                      className={cn(
                        'h-9 w-full justify-start gap-2 rounded-sm px-2 text-[13px] font-normal max-md:h-11',
                        openPastId === null && 'bg-primary-soft text-primary',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                      />
                      <span className="min-w-0 flex-1 text-left">
                        Current conversation
                      </span>
                      <span className="w-[52px] shrink-0 text-right text-[12px] text-muted-foreground group-hover:opacity-0 max-md:opacity-0">
                        Now
                      </span>
                    </Button>
                    {detail.conversationId &&
                      menu(detail.conversationId, 'Current conversation')}
                  </div>
                  {past.map((c) => (
                    <div
                      key={c.id}
                      className="group relative flex min-h-9 items-center rounded-sm"
                    >
                      <Button
                        variant="ghost"
                        aria-label={c.title}
                        aria-description={conversationDate(c.lastActivityAt)}
                        onClick={() => onOpenPast(c.id)}
                        className={cn(
                          'h-9 w-full justify-start gap-2 rounded-sm px-2 text-[13px] font-normal max-md:h-11',
                          openPastId === c.id && 'bg-primary-soft text-primary',
                        )}
                      >
                        <span
                          className="conversation-title-fade min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left"
                          title={c.title}
                        >
                          {c.title}
                        </span>
                        <span className="w-[52px] shrink-0 whitespace-nowrap text-right text-[12px] text-muted-foreground group-hover:opacity-0 max-md:opacity-0">
                          {conversationDate(c.lastActivityAt)}
                        </span>
                      </Button>
                      {menu(c.id, c.title)}
                    </div>
                  ))}

                </div>
              )}
              {active === 'memory' && (
                <>
                  {learned}
                  {panels?.memory}
                  <p className="mt-4 text-[12px] text-muted-foreground">
                    Notes it keeps from your conversations. Edit or remove any
                    of them.
                  </p>
                </>
              )}
              {active === 'files' && panels?.files}
              {active === 'connectors' && (
                <ConnectorsTab
                  agentId={agent.id}
                  name={agent.name}
                  rail={rail}
                  loading={loading}
                  error={error}
                  revoking={revoking}
                  notice={notice}
                  onRevoke={onRevoke}
                  onConnectorsChanged={refresh}
                />
              )}
            </div>
          </CompactSurfaceContext.Provider>
        </TabsContent>
      )}
      {WORKSPACE_AGENT_TABS.filter((v) => collapsed || v !== active).map(
        (v) => (
          <TabsContent key={v} value={v} forceMount hidden className="mt-0" />
        ),
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing?.kind === 'delete'
                ? 'Delete conversation?'
                : 'Rename conversation'}
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
            <Button
              variant="outline"
              disabled={actionBusy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button
              variant={editing?.kind === 'delete' ? 'destructive' : 'default'}
              disabled={
                actionBusy || (editing?.kind === 'rename' && !title.trim())
              }
              onClick={() => {
                if (!editing) return;
                const target = editing;
                void act(async () => {
                  if (target.kind === 'rename')
                    await conversationControls.rename(target.id, title.trim());
                  else {
                    await conversationControls.delete(target.id);
                    if (openPastId === target.id) onOpenPast(null);
                  }
                  setEditing(null);
                  onChanged?.();
                });
              }}
            >
              {actionBusy
                ? 'Saving…'
                : editing?.kind === 'delete'
                  ? 'Delete'
                  : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
/**
 * "Right now" — a phrase, a REAL counter, and how long it has been going.
 *
 * Never a percentage, never an ETA, and never a counter the tool did not report
 * (design H2). When the step stream goes quiet the phrase is REPLACED by the
 * elapsed silence and the counter disappears with it: a hung agent that keeps
 * saying "Reading email" for forty minutes is worse than one that says nothing,
 * and a counter frozen at 29 of 41 is a claim that stopped being true.
 *
 * With no activity to report the line is the state word ALONE — no counter row,
 * no em-dash. An em-dash where a sentence goes reads as "we know something and
 * are not saying"; the truth is that nothing is reporting.
 */
function RightNow({
  agent,
  rail,
  loading,
  error,
}: {
  agent: AgentDetail['agent'];
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
}) {
  const line = rail?.activity.activity ?? null;
  return (
    <>
      <Card className="rounded-md bg-muted shadow-none">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            <StateDot state={agent.state} />
            {stateWord(agent.state)}
          </div>
          <div className="text-[13px]">{line?.phrase ?? ''}</div>
          {line !== null && (
            <div className="flex justify-between text-[12px] text-muted-foreground">
              <span>
                {line.counter
                  ? `${line.counter.done} of ${line.counter.total} ${line.counter.unit}`
                  : ''}
              </span>
              <Elapsed since={line.startedAt} />
            </div>
          )}
          {/*
            A failed read is worth one line here, because the state word above
            it would otherwise pass for an answer. A deployment with no activity
            producer says nothing extra: the state word IS the honest answer
            there, and a notice would be noise on every render forever.
          */}
          {!loading &&
            (error !== null || rail?.activity.status === 'failed') && (
              <p className="text-[11.5px] text-muted-foreground">
                We couldn&apos;t read what it&apos;s doing just now.
              </p>
            )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * "This week" — design §4.4.
 *
 * ONE number ships, and its written definition ships underneath it. The design
 * names three. The other two are ABSENT — not `0`, not an em-dash, not a
 * tooltip admitting we don't know — because nothing produces either one, and
 * the next person to notice the gap should find this note rather than close it
 * with a zero:
 *
 *   - *Handled on its own* — allow-verdict tool calls — would need a
 *     `tool:pre-call` rollup. The hook fires and has two subscribers, and
 *     neither leaves anything to roll up for THESE calls: `@ax/decisions`
 *     returns without writing a row the moment the verdict is `allow` (that is
 *     the point — an allowed call is not a decision), and `@ax/agent-activity`
 *     keeps one in-memory snapshot of the call in flight and deletes it at
 *     `chat:end`. A call the agent handled alone leaves no trace, so the number
 *     would be invented.
 *   - *You overruled it* would need an undo trace in `@ax/decisions`.
 *     `decisions:undo` restores the row to `pending` and clears `resolved_at`,
 *     so an override leaves no record at all. Its zero would not be a true
 *     number that happens to be small — it would be unfalsifiable, which is
 *     the worse of the two failures: "you have never overruled me" is a
 *     statement about someone's own history, made from a read that could not
 *     have found out either way.
 *
 * Building either producer was considered and declined (TASK-265). An undo
 * trace means durably recording that a person changed their mind — a schema
 * change and a privacy question — and that trade should be made deliberately,
 * not as a side effect of filling in a rail. The layout gap is the honest cost.
 *
 * This component renders whatever counter rows it is handed, so the pin that
 * both stay absent lives with their producer: see `readCounters` and
 * `__tests__/server/routes-workspace-rail.test.ts`.
 *
 * The whole block disappears when there is no number to show, rather than
 * standing there empty. A heading over nothing is a promise the surface is not
 * keeping.
 */
function ThisWeek({
  rail,
  loading,
  error,
}: {
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
}) {
  if (rail === null || loading) return null;
  const { status, rows } = rail.counters;
  if (error !== null || status !== 'ok' || rows.length === 0) return null;
  return (
    <>
      <SectionLabel>This week</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-2.5 p-3.5">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px]">{row.label}</span>
                <span className="text-[13px] tabular-nums">{row.value}</span>
              </div>
              {/*
                The definition is rendered, not tucked into a tooltip. This is
                the number a person will quote at somebody, and a number whose
                meaning is one hover away is a number whose meaning drifts.
              */}
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                {row.definition}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
