import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
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

function statementText(row: FactMemoryStatement): string {
  return `${row.aboutText ?? words(row.about)} ${words(row.relation)}: ${row.value}`;
}

function kindLabel(kind: string | undefined): string {
  if (kind === 'world' || kind === 'experience') return 'Fact';
  if (kind === 'observation') return 'Observation';
  if (kind === 'opinion') return 'Opinion';
  return 'Unclassified';
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
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);
  const [editTarget, setEditTarget] = useState<MutationTarget | null>(null);
  const [forgetTarget, setForgetTarget] = useState<MutationTarget | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-6 py-6">
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
      <ProfileCard
        agentId={agentId}
        refresh={refresh}
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
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          bump();
        }}
      />
      <ForgetDialog
        target={forgetTarget}
        agentId={agentId}
        onClose={() => setForgetTarget(null)}
        onForgotten={() => {
          setForgetTarget(null);
          bump();
        }}
      />
    </div>
  );
}

function ProfileCard({
  agentId,
  refresh,
  onEdit,
  onForget,
}: {
  agentId: string;
  refresh: number;
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
  const active = rows.filter((r) => r.until === undefined);
  const closed = sortOldestFirst(rows.filter((r) => r.until !== undefined));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <HistoryToggle id="profile-history" checked={history} onChange={setHistory} />
        {state.status === 'loading' && <LoadingMemories />}
        {state.status === 'failed' && <FailedRead onRetry={() => setTick((t) => t + 1)} />}
        {state.status === 'ready' && (
          <>
            {state.data.degraded.length > 0 && <DegradedNotice />}
            {rows.length === 0 ? (
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

  const rows =
    state.status === 'ready' ? sortOldestFirst(state.data.statements) : [];

  function renderRow(row: FactMemoryStatement) {
    const isHistory = row.until !== undefined;
    const label = statementText(row);
    const actions = !isHistory && (
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
                {kindLabel(row.kind)} · {row.whenText ?? row.when}
              </span>
              {isHistory && state.status === 'ready' && (
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
        <TableCell>{kindLabel(row.kind)}</TableCell>
        <TableCell>{row.whenText ?? row.when}</TableCell>
        <TableCell>
          {label}
          {isHistory && state.status === 'ready' && (
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
  onClose,
  onSaved,
}: {
  target: MutationTarget | null;
  agentId: string;
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
            Saving replaces the current value. The earlier memory stays in History.
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
  onClose,
  onForgotten,
}: {
  target: MutationTarget | null;
  agentId: string;
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
            This memory will be removed from active results. It stays in History, and past
            conversations do not change.
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
