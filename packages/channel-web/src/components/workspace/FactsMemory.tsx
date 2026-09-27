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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  workspaceApi,
  type AgentMemoryRead,
  type FactMemoryPage,
  type FactMemoryStatement,
} from '@/lib/workspace-api';
import { AgentMemory, RulesEditor, RulesWithoutEditor } from './AgentMemory';

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

function words(v: string): string {
  return v.replace(/_/g, ' ');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function subjectText(row: FactMemoryStatement): string {
  if (row.aboutText === 'you') return 'You';
  if (row.aboutText !== undefined) return capitalize(row.aboutText);
  return capitalize(words(row.about));
}

function statementText(row: FactMemoryStatement): string {
  return `${subjectText(row)} — ${words(row.relation)}: ${row.value}`;
}

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
        <FieldLabel htmlFor={id}>Show history</FieldLabel>
        <FieldDescription>
          Include memories that were replaced or forgotten.
        </FieldDescription>
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
        <Badge variant="secondary">Overridden</Badge> — another memory is used
        instead
      </span>
    );
  }
  if (row.until === undefined) return null;
  return (
    <span className="text-sm text-muted-foreground">
      {row.closure === 'forgotten' ? (
        <Badge variant="secondary">Forgotten</Badge>
      ) : (
        <Badge variant="secondary">Replaced</Badge>
      )}{' '}
      {row.until.slice(0, 10)}
      {row.closure === 'replaced' &&
        (row.closedBy !== undefined
          ? (() => {
              const replacement = page.statements.find((s) => s.id === row.closedBy);
              return ` — Replaced by: ${replacement !== undefined ? replacement.value : 'a newer memory'}`;
            })()
          : ' — Replaced by a newer memory')}
    </span>
  );
}

interface MutationTarget {
  row: FactMemoryStatement;
}

function FactsMemory({ agentId, agentName, memory, onSaveRules, onRetry }: MemorySurfaceProps) {
  const { rules } = memory;
  const visibility =
    memory.factsVisibility === 'team' || memory.factsVisibility === 'personal'
      ? memory.factsVisibility
      : undefined;
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);
  const [editTarget, setEditTarget] = useState<MutationTarget | null>(null);
  const [forgetTarget, setForgetTarget] = useState<MutationTarget | null>(null);
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
          <AlertDescription>
            Memories saved with this shared agent are visible to its team. Team members
            can correct or forget them.
          </AlertDescription>
        </Alert>
      )}
      {visibility === 'personal' && (
        <Alert>
          <AlertDescription>
            Memories saved with this personal agent are private to you.
          </AlertDescription>
        </Alert>
      )}
      <ProfileCard
        agentId={agentId}
        refresh={refresh}
        visibility={visibility}
        extractionPaused={extractionPaused}
        onEdit={(row) => setEditTarget({ row })}
        onForget={(row) => setForgetTarget({ row })}
      />
      <SearchCard
        agentId={agentId}
        refresh={refresh}
        onForget={(row) => setForgetTarget({ row })}
      />
      <EditDialog
        target={editTarget}
        agentId={agentId}
        visibility={visibility}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          bump();
        }}
      />
      <ForgetDialog
        target={forgetTarget}
        agentId={agentId}
        visibility={visibility}
        onClose={() => setForgetTarget(null)}
        onForgotten={() => {
          setForgetTarget(null);
          bump();
        }}
      />
    </div>
  );
}

type FactsVisibility = 'personal' | 'team' | undefined;

function ProfileCard({
  agentId,
  refresh,
  visibility,
  extractionPaused = false,
  onEdit,
  onForget,
}: {
  agentId: string;
  refresh: number;
  visibility: FactsVisibility;
  extractionPaused?: boolean;
  onEdit: (row: FactMemoryStatement) => void;
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
                          {words(row.slot ?? row.relation)}:
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
                        aria-label={`Edit: ${row.value}`}
                        onClick={() => onEdit(row)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Forget: ${row.value}`}
                        onClick={() => onForget(row)}
                      >
                        Forget
                      </Button>
                    </div>
                  </li>
                ))}
                {closed.map((row) => (
                  <li key={row.id} className="flex flex-col gap-0.5">
                    <span className="text-sm">
                      <span className="text-muted-foreground">
                        {words(row.slot ?? row.relation)}:
                      </span>{' '}
                      {row.value}
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
    const label = statementText(row);
    const actions = !isClosed && (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Forget: ${label}`}
        onClick={() => onForget(row)}
      >
        Forget
      </Button>
    );
    if (compact) {
      return (
        <li key={row.id}>
          <Card>
            <CardContent className="flex flex-col gap-1 p-3">
              <span className="text-sm">{label}</span>
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
          {label}
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

function EditDialog({
  target,
  agentId,
  visibility,
  onClose,
  onSaved,
}: {
  target: MutationTarget | null;
  agentId: string;
  visibility: FactsVisibility;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (target !== null) {
      setValue(target.row.value);
      setError(false);
      setPending(false);
    }
  }, [target]);

  async function save() {
    if (target === null || pending || value.trim() === '') return;
    setPending(true);
    setError(false);
    try {
      await workspaceApi.rememberMemory(agentId, {
        about: target.row.about,
        relation: target.row.relation,
        value,
      });
      onSaved();
    } catch {
      setPending(false);
      setError(true);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit remembered detail</DialogTitle>
          <DialogDescription>
            {visibility === 'team'
              ? 'Saving replaces the current value for the team. The earlier memory stays in History.'
              : 'Saving replaces the current value. The earlier memory stays in History.'}
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="memory-edit-value">What we should remember</FieldLabel>
            <Input
              id="memory-edit-value"
              value={value}
              disabled={pending}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              We could not save this detail. Your changes are still here.
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || value.trim() === ''}
            onClick={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ForgetDialog({
  target,
  agentId,
  visibility,
  onClose,
  onForgotten,
}: {
  target: MutationTarget | null;
  agentId: string;
  visibility: FactsVisibility;
  onClose: () => void;
  onForgotten: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (target !== null) {
      setPending(false);
      setError(false);
    }
  }, [target]);

  async function forget() {
    if (target === null || pending) return;
    setPending(true);
    setError(false);
    try {
      await workspaceApi.forgetMemory(agentId, [target.row.id]);
      onForgotten();
    } catch {
      setPending(false);
      setError(true);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Forget this memory?</DialogTitle>
          <DialogDescription>
            {visibility === 'team'
              ? 'This memory will be removed from active results for the team. It stays in History, and past conversations do not change.'
              : 'This memory will be removed from active results. It stays in History, and past conversations do not change.'}
          </DialogDescription>
        </DialogHeader>
        {target !== null && <p className="text-sm">{statementText(target.row)}</p>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              We could not forget this memory. Try again.
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void forget()}
          >
            Forget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
