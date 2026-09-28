import { useEffect, useRef, useState } from 'react';
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
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { AgentMemory, RulesEditor, RulesWithoutEditor } from './AgentMemory';
import { MemoryFixDialog, MemoryForgetDialog, useMemoryReceipt } from './MemoryCorrection';
import {
  MEMORY_CLOSURE_BADGE,
  MEMORY_FIX,
  MEMORY_FORGET,
  MEMORY_HISTORY_TOGGLE,
  MEMORY_HISTORY_TOGGLE_HELPER,
  MEMORY_OVERRIDDEN_NOTE,
  MEMORY_PERSONAL_NOTICE,
  MEMORY_REPLACED_BY_UNKNOWN,
  MEMORY_TEAM_NOTICE,
  memoryFixLabel,
  memoryForgetLabel,
  memoryReplacedBy,
  memorySlotText,
  memoryStatementText,
  type MemoryVisibility,
} from './memory-copy';

export interface MemorySurfaceProps {
  agentId: string;
  agentName: string;
  memory: AgentMemoryRead;
  onSaveRules?: (body: string) => Promise<string>;
  onRetry?: () => void;
}

export function MemorySurface(props: MemorySurfaceProps) {
  return props.memory.factsAvailable === true ? (
    <FactsMemory key={props.agentId} {...props} />
  ) : (
    <AgentMemory {...props} />
  );
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
  if (row.kind === 'world' || row.kind === 'experience') return 'Fact';
  if (row.kind === 'observation') return 'Observation';
  if (row.kind === 'opinion') return 'Opinion';
  if (row.savedBy === 'person') return 'Saved by a person';
  if (row.savedBy === 'agent') return 'Agent note';
  return 'Older memory';
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

function sortOldestFirst(rows: readonly FactMemoryStatement[]): FactMemoryStatement[] {
  return [...rows].sort((a, b) => a.when.localeCompare(b.when) || a.id.localeCompare(b.id));
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
      <AlertTitle>Memory is paused</AlertTitle>
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

function HistoryToggle({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{MEMORY_HISTORY_TOGGLE}</FieldLabel>
        <FieldDescription>{MEMORY_HISTORY_TOGGLE_HELPER}</FieldDescription>
      </FieldContent>
    </Field>
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

function FactsMemory({ agentId, agentName, memory, onSaveRules, onRetry }: MemorySurfaceProps) {
  const { rules } = memory;
  const visibility =
    memory.factsVisibility === 'team' || memory.factsVisibility === 'personal'
      ? memory.factsVisibility
      : undefined;
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);
  const [fixTarget, setFixTarget] = useState<FactMemoryStatement | null>(null);
  const [forgetTarget, setForgetTarget] = useState<FactMemoryStatement | null>(null);
  const receipt = useMemoryReceipt(agentId, bump);
  const extractionPaused = memory.factsExtraction === 'paused';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-6">
      {extractionPaused && <ExtractionPausedNotice />}
      {rules.status === 'ok' && rules.doc !== null ? (
        <RulesEditor
          agentName={agentName}
          initial={rules.doc.body}
          {...(onSaveRules ? { onSave: onSaveRules } : {})}
        />
      ) : (
        <RulesWithoutEditor
          agentName={agentName}
          status={rules.status === 'ok' ? 'failed' : rules.status}
          {...(onRetry ? { onRetry } : {})}
        />
      )}
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
      <ProfileCard
        agentId={agentId}
        refresh={refresh}
        visibility={visibility}
        extractionPaused={extractionPaused}
        onFix={setFixTarget}
        onForget={setForgetTarget}
      />
      <SearchCard agentId={agentId} refresh={refresh} onForget={setForgetTarget} />
      {receipt.element}
      <MemoryFixDialog
        target={fixTarget}
        agentId={agentId}
        visibility={visibility}
        onClose={() => setFixTarget(null)}
        onSaved={(_reason, saved) => {
          if (fixTarget !== null) receipt.updated({ row: fixTarget, ...saved });
          setFixTarget(null);
          bump();
        }}
      />
      <MemoryForgetDialog
        target={forgetTarget}
        agentId={agentId}
        visibility={visibility}
        onClose={() => setForgetTarget(null)}
        onForgotten={(row) => {
          setForgetTarget(null);
          receipt.forgotten(row);
          bump();
        }}
      />
    </div>
  );
}

function ProfileCard({
  agentId,
  refresh,
  visibility,
  extractionPaused = false,
  onFix,
  onForget,
}: {
  agentId: string;
  refresh: number;
  visibility: MemoryVisibility;
  extractionPaused?: boolean;
  onFix: (row: FactMemoryStatement) => void;
  onForget: (row: FactMemoryStatement) => void;
}) {
  const [history, setHistory] = useState(false);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<ReadState>({ status: 'loading' });
  const request = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const sequence = ++request.current;
    setState({ status: 'loading' });
    workspaceApi.recallMemory(agentId, { profile: true, history }).then(
      (data) => {
        if (!cancelled && sequence === request.current) setState({ status: 'ready', data });
      },
      () => {
        if (!cancelled && sequence === request.current) setState({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, history, refresh, tick]);

  const rows = state.status === 'ready' ? state.data.statements : [];
  const active = rows.filter(isCurrent);
  const closed = sortOldestFirst(rows.filter((r) => !isCurrent(r)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        {visibility === 'team' && (
          <CardDescription>
            These details are about you and are visible to the team.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <HistoryToggle id="profile-history" checked={history} onChange={setHistory} />
        {state.status === 'loading' && <LoadingMemories />}
        {state.status === 'failed' && <FailedRead onRetry={() => setTick((t) => t + 1)} />}
        {state.status === 'ready' && (
          <>
            {state.data.degraded.length > 0 && <DegradedNotice />}
            {rows.length === 0 && extractionPaused ? (
              // Paused: the notice above explains why; don't promise what won't happen.
              <EmptyMemories>No profile memories yet.</EmptyMemories>
            ) : rows.length === 0 ? (
              <EmptyMemories>
                No profile memories yet. Details we remember from your conversations will
                appear here.
              </EmptyMemories>
            ) : (
              <ul className="flex flex-col gap-3">
                {active.map((row) => (
                  <li key={row.id} className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">
                        <span className="text-muted-foreground">
                          {memorySlotText(row)}:
                        </span>{' '}
                        {row.value}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        Noted {row.whenText ?? row.when}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={memoryFixLabel(row.value)}
                        onClick={() => onFix(row)}
                      >
                        {MEMORY_FIX}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={memoryForgetLabel(row.value)}
                        onClick={() => onForget(row)}
                      >
                        {MEMORY_FORGET}
                      </Button>
                    </div>
                  </li>
                ))}
                {closed.map((row) => (
                  <li key={row.id} className="flex flex-col gap-0.5">
                    <span className="text-sm">
                      <span className="text-muted-foreground">
                        {memorySlotText(row)}:
                      </span>{' '}
                      <RowValue row={row}>{row.value}</RowValue>
                    </span>
                    <ClosureNote row={row} page={state.data} />
                  </li>
                ))}
              </ul>
            )}
            {history && state.data.statements.length === 100 && (
              <p className="text-sm text-muted-foreground">
                Showing 100 memories. There may be more.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SearchCard({
  agentId,
  refresh,
  onForget,
}: {
  agentId: string;
  refresh: number;
  onForget: (row: FactMemoryStatement) => void;
}) {
  const compact = useIsCompact();
  const [draft, setDraft] = useState('');
  const [committed, setCommitted] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<ReadState | { status: 'idle' }>({ status: 'idle' });
  const request = useRef(0);

  useEffect(() => {
    if (committed === null) return;
    let cancelled = false;
    const sequence = ++request.current;
    setState({ status: 'loading' });
    workspaceApi.recallMemory(agentId, { query: committed, history }).then(
      (data) => {
        if (!cancelled && sequence === request.current) setState({ status: 'ready', data });
      },
      () => {
        if (!cancelled && sequence === request.current) setState({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, committed, history, refresh, tick]);

  // The ENGINE's own order — best match first. Re-sorting by date here was
  // the bug (card item 5): it made a relevance-ranked list look unfiltered,
  // as if it had simply dumped every match by age.
  const rows = state.status === 'ready' ? state.data.statements : [];

  function renderRow(row: FactMemoryStatement) {
    const isClosed = !isCurrent(row);
    const label = memoryStatementText(row);
    const actions = !isClosed && (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={memoryForgetLabel(label)}
        onClick={() => onForget(row)}
      >
        {MEMORY_FORGET}
      </Button>
    );
    if (compact) {
      return (
        <li key={row.id}>
          <Card>
            <CardContent className="flex flex-col gap-1 p-3">
              <span className="text-sm">
                <RowValue row={row}>{label}</RowValue>
              </span>
              <span className="text-sm text-muted-foreground">
                {kindLabel(row)} · {row.whenText ?? row.when}
              </span>
              {isClosed && state.status === 'ready' && (
                <ClosureNote row={row} page={state.data} />
              )}
              {actions}
            </CardContent>
          </Card>
        </li>
      );
    }
    return (
      <TableRow key={row.id}>
        <TableCell>{kindLabel(row)}</TableCell>
        <TableCell>{row.whenText ?? row.when}</TableCell>
        <TableCell>
          <RowValue row={row}>{label}</RowValue>
          {isClosed && state.status === 'ready' && (
            <ClosureNote row={row} page={state.data} />
          )}
        </TableCell>
        <TableCell>{actions}</TableCell>
      </TableRow>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search memories</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = draft.trim();
            if (q !== '') {
              setCommitted(q);
              setTick((t) => t + 1);
            }
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="memory-search">Search memories</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="memory-search"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button type="submit" disabled={draft.trim() === ''}>
                  Search
                </Button>
              </div>
            </Field>
          </FieldGroup>
        </form>
        <HistoryToggle id="search-history" checked={history} onChange={setHistory} />
        {state.status === 'idle' && (
          <EmptyMemories>Search memories from your conversations.</EmptyMemories>
        )}
        {state.status === 'loading' && <LoadingMemories />}
        {state.status === 'failed' && <FailedRead onRetry={() => setTick((t) => t + 1)} />}
        {state.status === 'ready' && (
          <>
            {state.data.degraded.length > 0 && <DegradedNotice />}
            {state.data.statements.length === 0 ? (
              <EmptyMemories>
                No memories match that. Try a different word or phrase.
              </EmptyMemories>
            ) : compact ? (
              <ul className="flex flex-col gap-2">{rows.map(renderRow)}</ul>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>When (UTC)</TableHead>
                    <TableHead>Statement</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>{rows.map(renderRow)}</TableBody>
              </Table>
            )}
            {state.data.statements.length > 0 && (
              <p className="text-sm text-muted-foreground">Best matches first.</p>
            )}
            {state.data.statements.length === 40 && (
              <p className="text-sm text-muted-foreground">
                Showing up to 40 matches. There may be more.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
