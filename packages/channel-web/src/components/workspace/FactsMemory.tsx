import { useContext, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Search } from 'lucide-react';
import { MemoryFixesContext } from '@/lib/use-conversation-memory';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useIsCompact } from '@/lib/use-compact';
import { cn } from '@/lib/utils';
import {
  workspaceApi,
  type AgentMemoryRead,
  type FactMemoryPage,
  type FactMemoryStatement,
} from '@/lib/workspace-api';
import {
  MemoryFixDialog,
  MemoryForgetDialog,
  memoryHeadingLanding,
  memoryRowLanding,
  useMemoryReceipt,
} from './MemoryCorrection';
import {
  LEARNED_STATUS_PAUSED,
  MEMORY_CLOSURE_BADGE,
  MEMORY_FIX,
  MEMORY_FORGET,
  MEMORY_OVERRIDDEN_NOTE,
  MEMORY_PERSONAL_NOTICE,
  MEMORY_REPLACED_BY_UNKNOWN,
  MEMORY_TEAM_NOTICE,
  MEMORY_KIND_FACT,
  MEMORY_KIND_PREFERENCE,
  MEMORY_NOTED_TODAY,
  MEMORY_NOTED_YESTERDAY,
  memoryListFooter,
  memoryFixLabel,
  memoryForgetLabel,
  memoryReplacedBy,
  memorySubjectText,
  memorySlotText,
} from './memory-copy';

export interface MemorySurfaceProps {
  agentId: string;
  agentName: string;
  memory: AgentMemoryRead;
  onCount?: (count: number | null) => void;
}

/**
 * The memories list, or nothing at all on a deployment without facts memory.
 *
 * The rules editor used to sit on top of this — and was the WHOLE surface
 * without facts memory. It moved to the settings page's Instructions section
 * (TASK-888), so a deployment with no facts memory now has no list to draw
 * here; callers say so in their own words rather than this drawing an empty
 * frame.
 */
export function MemorySurface(props: MemorySurfaceProps) {
  return props.memory.factsAvailable === true ? (
    <FactsMemory key={props.agentId} {...props} />
  ) : null;
}

type ReadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; data: FactMemoryPage };

/**
 * The row's TYPE label. `kind` wins when the engine classified it; otherwise
 * we say who saved it rather than claim "Unclassified" — a word that reads as
 * a judgment about the memory rather than an honest gap in our own metadata
 * (TASK-526, card item 1).
 */
function kindLabel(row: FactMemoryStatement): string {
  if (row.kind === 'opinion') return MEMORY_KIND_PREFERENCE;
  if (row.kind === 'world' || row.kind === 'experience' || row.kind === 'observation') return MEMORY_KIND_FACT;
  if (row.savedBy === 'person') return 'Saved by a person';
  if (row.savedBy === 'agent') return 'Agent note';
  return 'Older memory';
}

function KindBadge({ row }: { row: FactMemoryStatement }) {
  return <Badge variant={row.kind === 'opinion' ? 'accent' : 'secondary'} size="compact">{kindLabel(row)}</Badge>;
}

/**
 * A row is CURRENT — active, editable, forgettable — iff it has no `until`
 * AND a higher-provenance row does not outrank it. `overridden` marks the
 * second case: an active row a history read still returns, but the engine's
 * own active read would hide (TASK-526, card item 8).
 */
function isCurrent(row: FactMemoryStatement): boolean {
  return row.until === undefined && row.closure !== 'overridden';
}

/**
 * A memory someone fixed with "It was never right" reads struck through in
 * History: it was a mistake, not something that used to be true. The strike
 * is decoration only — the Retracted badge beside it is what a screen reader
 * hears.
 */
function RowValue({ row, children }: { row: FactMemoryStatement; children: string }) {
  return (
    <span className={cn(row.closure === 'retracted' && 'line-through')}>{children}</span>
  );
}

function LoadingMemories() {
  return (
    <div role="status" aria-label="Loading memories" className="flex flex-col gap-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function FailedRead({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>We could not read these memories. Try again.</span>
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function DegradedNotice() {
  return (
    <Alert>
      <AlertDescription>
        Some search features are unavailable. Results may be incomplete.
      </AlertDescription>
    </Alert>
  );
}

function ExtractionPausedNotice() {
  return (
    <Alert>
      <AlertTitle>{LEARNED_STATUS_PAUSED}</AlertTitle>
      <AlertDescription>
        We&apos;re not picking up anything new from your conversations right now, because
        this workspace doesn&apos;t have an OpenRouter key yet. An admin can add one under
        Admin → AI model keys, and memory starts again with the next conversation.
        Anything already saved here still works.
      </AlertDescription>
    </Alert>
  );
}

function EmptyMemories({ children }: { children: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ClosureNote({
  row,
  page,
}: {
  row: FactMemoryStatement;
  page: FactMemoryPage;
}) {
  if (row.closure === 'overridden') {
    // No `until` on this row — it is still active. Must render anyway: the
    // badge is the only thing on screen that says this row is not the one in
    // effect (TASK-526, card item 8).
    return (
      <span className="text-sm text-muted-foreground">
        <Badge variant="secondary">{MEMORY_CLOSURE_BADGE.overridden}</Badge>
        {MEMORY_OVERRIDDEN_NOTE}
      </span>
    );
  }
  if (row.until === undefined) return null;
  const replacement =
    row.closure === 'replaced' && row.closedBy !== undefined
      ? page.statements.find((s) => s.id === row.closedBy)
      : undefined;
  return (
    <span className="text-sm text-muted-foreground">
      <Badge variant="secondary">
        {row.closure === 'forgotten' || row.closure === 'retracted'
          ? MEMORY_CLOSURE_BADGE[row.closure]
          : MEMORY_CLOSURE_BADGE.replaced}
      </Badge>{' '}
      {row.until.slice(0, 10)}
      {row.closure === 'replaced' &&
        (replacement !== undefined
          ? memoryReplacedBy(replacement.value)
          : MEMORY_REPLACED_BY_UNKNOWN)}
    </span>
  );
}

function FactsMemory({ agentId, agentName, memory, onCount }: MemorySurfaceProps) {
  const visibility =
    memory.factsVisibility === 'team' || memory.factsVisibility === 'personal'
      ? memory.factsVisibility
      : undefined;
  const shared = useContext(MemoryFixesContext);
  const forgottenRef = useRef<FactMemoryStatement | null>(null);
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);
  const [fixTarget, setFixTarget] = useState<FactMemoryStatement | null>(null);
  const [forgetTarget, setForgetTarget] = useState<FactMemoryStatement | null>(null);
  const extractionPaused = memory.factsExtraction === 'paused';
  // A save re-reads the list, so the button that opened the dialog is gone;
  // focus lands on the receipt pinned at the bottom instead (TASK-644).
  const rootRef = useRef<HTMLDivElement>(null);
  /*
    When that receipt goes with focus in it (TASK-651): an Undo re-reads the
    list, so focus waits on the Memories heading and moves to the row once it
    is drawn; a receipt that runs out lands on the row, or on the heading when
    the row was forgotten.
  */
  const receipt = useMemoryReceipt(agentId, () => {
    if (forgottenRef.current !== null) shared?.undoForget?.(forgottenRef.current);
    forgottenRef.current = null;
    bump();
  }, { ...(shared ? { onFixUndone: shared.undoFix } : {}), scope: rootRef });

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col gap-6">
      {receipt.announcer}
      {extractionPaused && <ExtractionPausedNotice />}
      {visibility === 'team' && (
        <Alert>
          <AlertDescription>{MEMORY_TEAM_NOTICE}</AlertDescription>
        </Alert>
      )}
      {visibility === 'personal' && (
        <Alert>
          <AlertDescription>{MEMORY_PERSONAL_NOTICE}</AlertDescription>
        </Alert>
      )}
      <MemoriesManager
        agentId={agentId}
        agentName={agentName}
        refresh={refresh}
        extractionPaused={extractionPaused}
        onFix={setFixTarget}
        onForget={setForgetTarget}
        {...(onCount ? { onCount } : {})}
      />
      {receipt.element}
      <MemoryFixDialog
        target={fixTarget}
        agentId={agentId}
        visibility={visibility}
        outcomeScope={rootRef}
        onClose={() => setFixTarget(null)}
        onSaved={(reason, saved) => {
          forgottenRef.current = null;
          if (fixTarget !== null) {
            const fix = { row: fixTarget, ...saved };
            shared?.recordFix(fix, reason);
            receipt.updated(fix);
          }
          setFixTarget(null);
          bump();
        }}
      />
      <MemoryForgetDialog
        target={forgetTarget}
        agentId={agentId}
        visibility={visibility}
        outcomeScope={rootRef}
        onClose={() => setForgetTarget(null)}
        onForgotten={(row) => {
          setForgetTarget(null);
          forgottenRef.current = row;
          shared?.recordForget?.(row);
          receipt.forgotten(row);
          bump();
        }}
      />
    </div>
  );
}

function NotedDate({ when }: { when: string }) {
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return <span>Unknown date</span>;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  // Calendar days, rather than elapsed hours, also work at midnight and across DST.
  const label = date.toDateString() === today.toDateString() ? MEMORY_NOTED_TODAY
    : date.toDateString() === yesterday.toDateString() ? MEMORY_NOTED_YESTERDAY
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <time dateTime={when}>
      {label}
    </time>
  );
}

function MemoryActions({ row, onFix, onForget }: {
  row: FactMemoryStatement;
  onFix: (row: FactMemoryStatement) => void;
  onForget: (row: FactMemoryStatement) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = useRef<((row: FactMemoryStatement) => void) | null>(null);
  // Open the dialog after the menu's focus scope closes. Cancel can then
  // return to the persistent trigger rather than an unmounted menu item.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} type="button" variant="ghost" size="icon" className="size-11 md:size-8" aria-label={`Memory actions: ${row.value}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => {
        const action = selection.current;
        selection.current = null;
        if (action === null) return;
        e.preventDefault();
        trigger.current?.focus();
        setTimeout(() => action(row), 0);
      }}>
        <DropdownMenuGroup>
          <DropdownMenuItem aria-label={memoryFixLabel(row.value)} onSelect={() => { selection.current = onFix; }}>{MEMORY_FIX}</DropdownMenuItem>
          <DropdownMenuItem aria-label={memoryForgetLabel(row.value)} onSelect={() => { selection.current = onForget; }}>{MEMORY_FORGET}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MemoriesManager({ agentId, agentName, refresh, extractionPaused = false, onFix, onForget, onCount }: {
  agentId: string;
  refresh: number;
  agentName: string;
  extractionPaused?: boolean;
  onFix: (row: FactMemoryStatement) => void;
  onForget: (row: FactMemoryStatement) => void;
  onCount?: (count: number | null) => void;
}) {
  const compact = useIsCompact();
  const shared = useContext(MemoryFixesContext);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState(false);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<ReadState>({ status: 'loading' });
  const request = useRef(0);
  const fixes = shared?.fixes;
  const forgotten = shared?.forgotten;

  useEffect(() => {
    let cancelled = false;
    const sequence = ++request.current;
    setState({ status: 'loading' });
    workspaceApi.recallMemory(agentId, { ...(query ? { query } : {}), history }).then(
      (data) => {
        if (!cancelled && sequence === request.current) setState({ status: 'ready', data });
      },
      () => {
        if (!cancelled && sequence === request.current) setState({ status: 'failed' });
      },
    );
    return () => { cancelled = true; };
  }, [agentId, query, history, refresh, tick, fixes, forgotten]);

  // Keep the engine's ordering, particularly its relevance ranking in search.
  const rows = state.status === 'ready' ? state.data.statements : [];
  const count = state.status === 'ready' && query === '' ? rows.filter(isCurrent).length : null;
  useEffect(() => { if (query === '') onCount?.(count); }, [count, onCount, query]);

  function statement(row: FactMemoryStatement) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span {...(isCurrent(row) ? memoryRowLanding(row.id) : {})} className={cn('break-words [overflow-wrap:anywhere]', isCurrent(row) && memoryRowLanding(row.id).className)}>
          <span className="text-muted-foreground"><span>{memorySubjectText(row)} — </span>{memorySlotText(row)}:</span>{' '}
          <RowValue row={row}>{row.value}</RowValue>
        </span>
        {!isCurrent(row) && state.status === 'ready' && <ClosureNote row={row} page={state.data} />}
      </div>
    );
  }

  return (
    <section {...memoryHeadingLanding} role="region" aria-label="Memories" className={cn(memoryHeadingLanding.className, 'flex min-w-0 flex-col gap-4')}>
      <form onSubmit={(e) => {
        e.preventDefault();
        setQuery(draft.trim());
        setTick((t) => t + 1);
      }}>
        <FieldGroup className="flex flex-col gap-3 md:flex-row md:items-center">
          <Field className="min-w-0 md:flex-1">
            <FieldLabel htmlFor="memory-search" className="sr-only">Search memories</FieldLabel>
            <InputGroup>
              <InputGroupInput id="memory-search" placeholder="Search memories" value={draft} onChange={(e) => {
                setDraft(e.target.value);
                if (e.target.value.trim() === '') setQuery('');
              }} />
              <InputGroupAddon align="inline-start">
                <InputGroupButton type="submit" size="icon-sm" aria-label="Search"><Search aria-hidden="true" /></InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>
          <Field orientation="horizontal" className="min-h-11 justify-end md:min-h-0 md:w-auto md:shrink-0">
            <FieldLabel htmlFor="memories-history" className="text-muted-foreground">Show replaced memories</FieldLabel>
            <Switch id="memories-history" checked={history} onCheckedChange={setHistory} />
          </Field>
        </FieldGroup>
      </form>
      {state.status === 'loading' && <LoadingMemories />}
      {state.status === 'failed' && <FailedRead onRetry={() => setTick((t) => t + 1)} />}
      {state.status === 'ready' && <>
        {state.data.degraded.length > 0 && <DegradedNotice />}
        {rows.length === 0 ? (
          <EmptyMemories>{query ? 'No memories match that. Try a different word or phrase.' : extractionPaused ? 'No memories yet.' : 'No memories yet. Notes we remember from your conversations will appear here.'}</EmptyMemories>
        ) : compact ? (
          <ul aria-label="Memories" className="flex flex-col gap-3">
            {rows.map((row) => <li key={row.id}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-3 p-4 pb-2">
                  <CardTitle><KindBadge row={row} /></CardTitle>
                  {isCurrent(row) && <MemoryActions row={row} onFix={onFix} onForget={onForget} />}
                </CardHeader>
                <CardContent className="flex flex-col gap-2 p-4 pt-0">
                  {statement(row)}
                  <CardDescription>Noted <NotedDate when={row.when} /></CardDescription>
                </CardContent>
              </Card>
            </li>)}
          </ul>
        ) : (
          <Card className="overflow-hidden border border-border shadow-none">
            <Table className="min-w-[30rem] table-fixed">
              <TableHeader className="bg-muted">
                <TableRow className="border-border">
                  <TableHead className="h-9 w-32 text-xs">Kind</TableHead>
                  <TableHead className="h-9 text-xs">What {agentName} remembers</TableHead>
                  <TableHead className="h-9 w-28 text-xs">Noted</TableHead>
                  <TableHead className="h-9 w-16"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{rows.map((row) => <TableRow key={row.id} className="border-border">
                <TableCell className="py-3"><KindBadge row={row} /></TableCell>
                <TableCell className="py-3">{statement(row)}</TableCell>
                <TableCell className="py-3 text-muted-foreground"><NotedDate when={row.when} /></TableCell>
                <TableCell className="py-3">{isCurrent(row) && <MemoryActions row={row} onFix={onFix} onForget={onForget} />}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </Card>
        )}
        {query && rows.length > 0 && <p className="text-sm text-muted-foreground">Best matches first.</p>}
        {count !== null && <p className="text-xs text-muted-foreground">{memoryListFooter(count)}</p>}
        {rows.length === 40 && <p className="text-sm text-muted-foreground">Showing 40 memories. Use search to find more.</p>}
      </>}
    </section>
  );
}
