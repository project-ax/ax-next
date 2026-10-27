import { useEffect, useRef, useState } from 'react';
import { Pencil, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Field, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import {
  routineApi,
  RoutineApiError,
  type Routine,
  type Fire,
} from '@/lib/routines';
import { useAgentStore } from '@/lib/agent-store';
import { RoutineEditor } from './RoutineEditor';
import { FireNowControl } from './FireNowControl';
import { FireRowsTable } from './FireRowsTable';
import { TriggerChip } from './TriggerChip';
import { CredentialSlotRow } from '../credentials/CredentialSlotRow';

function rowKey(row: Pick<Routine, 'agentId' | 'routineId'>): string {
  return JSON.stringify([row.agentId, row.routineId]);
}

export interface RoutinesListProps {
  agentId?: string | undefined;
  agentName?: string | undefined;
  refreshKey?: number;
  onFired: () => void;
  isAdmin?: boolean;
  origin?: 'authored' | 'default';
  /** Bumped by a parent-owned "New routine" button to open the create dialog. */
  createRequest?: number;
  /** The parent draws the "New routine" button, so the list doesn't. */
  hideCreateAction?: boolean;
}
export function RoutinesList({
  agentId,
  agentName,
  refreshKey = 0,
  onFired,
  origin = 'authored',
  createRequest = 0,
  hideCreateAction = false,
}: RoutinesListProps) {
  const { agents, agentsStatus } = useAgentStore();
  const ids = agentId ? [agentId] : agents.map((a) => a.id);
  const idKey = ids.join('\0');
  const [list, setList] = useState<Routine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [editorPending, setEditorPending] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fires, setFires] = useState<Fire[] | null>(null);
  const [firesError, setFiresError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const [fireProtected, setFireProtected] = useState(false);
  const fireProtectedRef = useRef(false);
  function protectFire(pending: boolean) {
    fireProtectedRef.current = pending;
    setFireProtected(pending);
  }
  const flight = useRef(false);
  const previousCreateRequest = useRef(createRequest);
  useEffect(() => {
    if (createRequest !== previousCreateRequest.current && agentId) setCreating(agentId);
    previousCreateRequest.current = createRequest;
  }, [createRequest, agentId]);
  const operation = useRef<{
    key: string;
    requestId: string;
    row: Routine;
    kind: 'enabled' | 'delete';
  } | null>(null);
  useEffect(() => {
    // Preserve the child and its exact retry identity. A changed refresh key is
    // picked up when the operation is confirmed or explicitly refused.
    if (fireProtectedRef.current) return;
    let active = true;
    setList(null);
    setError(null);
    if (!agentId && agentsStatus === 'loading') return;
    if (!agentId && agentsStatus === 'error') {
      setError('We couldn’t load your agents.');
      return;
    }
    void Promise.all(ids.map((id) => routineApi.list(id)))
      .then((rows) => {
        if (active) setList(rows.flat().filter((r) => r.origin === origin));
      })
      .catch(() => {
        if (active) setError('We couldn’t load routines.');
      });
    return () => {
      active = false;
    };
  }, [idKey, agentsStatus, version, refreshKey, fireProtected, origin]);
  useEffect(() => {
    const row = list?.find((r) => rowKey(r) === expanded);
    if (!row) return;
    let active = true;
    setFires(null);
    setFiresError(false);
    void routineApi
      .recentFires({
        agentId: row.agentId,
        routineId: row.routineId,
        limit: 20,
      })
      .then((rows) => {
        if (active) setFires(rows);
      })
      .catch(() => {
        if (active) setFiresError(true);
      });
    return () => {
      active = false;
    };
  }, [expanded, refreshKey, list]);
  const nameFor = (id: string) =>
    agentId === id && agentName
      ? agentName
      : (agents.find((a) => a.id === id)?.name ?? 'This agent');
  function saved() {
    setEditorPending(false);
    setEditing(null);
    setCreating(null);
    setVersion((n) => n + 1);
  }
  async function mutate(row: Routine, kind: 'enabled' | 'delete') {
    if (flight.current || fireProtectedRef.current) return;
    const key = JSON.stringify([row.agentId, row.routineId, row.revision, kind]);
    if (operation.current && operation.current.key !== key) {
      setError('Retry the unconfirmed change before making another change.');
      return;
    }
    operation.current ??= { key, requestId: crypto.randomUUID(), row, kind };
    flight.current = true;
    setBusy(row.routineId);
    setError(null);
    try {
      const identity = {
        agentId: row.agentId,
        routineId: row.routineId,
        expectedRevision: row.revision,
        requestId: operation.current.requestId,
      };
      if (kind === 'delete') {
        await routineApi.remove(identity);
        setDeleting(null);
      } else
        await routineApi.update({
          ...identity,
          patch: { enabled: !row.enabled },
        });
      operation.current = null;
      setUncertain(false);
      setVersion((n) => n + 1);
    } catch (e) {
      setError(
        e instanceof RoutineApiError
          ? e.message
          : 'We couldn’t confirm this change. Try again.',
      );
      if (e instanceof RoutineApiError && e.status > 0 && e.status < 500) {
        operation.current = null;
        setUncertain(false);
      } else setUncertain(true);
    } finally {
      flight.current = false;
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {origin === 'default' ? 'Run workspace defaults and inspect their recent runs.' : 'Work that runs when its trigger fires.'}
        </p>
        {origin === 'authored' && !hideCreateAction && (agentId ? (
          <Button
            disabled={busy !== null || uncertain || fireProtected}
            onClick={() => setCreating(agentId)}
          >
            New routine
          </Button>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <Button
                key={a.id}
                variant="outline"
                disabled={busy !== null || uncertain || fireProtected}
                onClick={() => setCreating(a.id)}
              >
                New routine for {a.name}
              </Button>
            ))}
          </div>
        ))}
      </div>
      {error && (
        <Alert
          variant="destructive"
          className="bg-destructive-soft text-destructive"
          data-testid="routines-list-error"
        >
          <AlertDescription>
            {error}
            <Button
              variant="ghost"
              disabled={fireProtected}
              onClick={() => setVersion((n) => n + 1)}
            >
              Refresh
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {uncertain && (
        <Alert>
          <AlertDescription>
            We couldn’t confirm this change. Retry sends the same change.
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                const pending = operation.current;
                if (pending) void mutate(pending.row, pending.kind);
              }}
            >
              Retry change
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {list === null && !error ? (
        <Skeleton aria-label="Loading routines" className="h-28 w-full" />
      ) : list?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{origin === 'default' ? 'No active default routines' : 'No routines yet'}</EmptyTitle>
            <EmptyDescription>
              {origin === 'default' ? 'Enabled workspace defaults appear here.' : `Create a routine to schedule work for ${agentName ?? 'an agent'}.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        list?.map((row) => (
          <div key={rowKey(row)} className="min-w-0">
            <div className="flex flex-wrap items-center gap-3 py-3">
              <Button
                variant="ghost"
                aria-label={`Recent runs for ${row.name}`}
                aria-expanded={expanded === rowKey(row)}
                disabled={fireProtected}
                onClick={() => {
                  if (!fireProtectedRef.current)
                    setExpanded((v) =>
                      v === rowKey(row) ? null : rowKey(row),
                    );
                }}
              >
                <ChevronRight data-icon="inline-start" />
              </Button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <TriggerChip schedule={row.schedule} webhook={row.webhook} />
                {row.delivery !== null && row.delivery !== undefined && row.delivery.waiting > 0 && (
                  <p role="status" className="text-sm text-muted-foreground">{row.delivery.waiting} app {row.delivery.waiting === 1 ? 'update' : 'updates'} waiting.</p>
                )}
                {!agentId && (
                  <p className="text-xs text-muted-foreground">
                    {nameFor(row.agentId)}
                  </p>
                )}
              </div>
              {row.origin === 'authored' && <Field orientation="horizontal" className="w-auto">
                <FieldLabel htmlFor={`routine-${row.routineId}`}>
                  {row.enabled ? 'On' : 'Off'}
                </FieldLabel>
                <Switch
                  id={`routine-${row.routineId}`}
                  aria-label={`Enabled for ${row.name}`}
                  checked={row.enabled}
                  disabled={
                    busy !== null || uncertain || fireProtected || !(row.enabled ? row.permissions.stop : row.permissions.edit)
                  }
                  onCheckedChange={() => void mutate(row, 'enabled')}
                />
              </Field>}
              {row.permissions.edit && (
                <Button
                  variant="ghost"
                  aria-label={`Edit ${row.name}`}
                  disabled={busy !== null || uncertain || fireProtected}
                  onClick={() => setEditing(row)}
                >
                  <Pencil data-icon="inline-start" />
                </Button>
              )}
            </div>
            {expanded === rowKey(row) && (
              <div className="flex flex-col gap-3 pb-4">
                {row.description && (
                  <p className="text-sm text-muted-foreground">
                    {row.description}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {row.permissions.fire && (
                    <FireNowControl
                      routine={row}
                      onFired={onFired}
                      onPendingChange={protectFire}
                    />
                  )}
                  {row.permissions.stop && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null || uncertain || fireProtected}
                      onClick={() => setDeleting(row)}
                    >
                      Delete routine
                    </Button>
                  )}
                </div>
                {row.lastError && (
                  <Alert variant="destructive">
                    <AlertDescription>{row.lastError}</AlertDescription>
                  </Alert>
                )}
                {row.webhook !== null &&
                  row.webhook.hmac &&
                  row.permissions.manageSecret && (
                    <CredentialSlotRow
                      destination={{
                        kind: 'routine-hmac',
                        agentId: row.agentId,
                        routineId: row.routineId,
                      }}
                      slot={{ label: 'Webhook HMAC secret', kind: 'api-key' }}
                      scope={{ scope: 'agent', ownerId: row.agentId }}
                    />
                  )}
                {firesError ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      Recent runs are unavailable.
                    </AlertDescription>
                  </Alert>
                ) : fires === null ? (
                  <Skeleton
                    aria-label="Loading recent runs"
                    className="h-12 w-full"
                  />
                ) : fires.length ? (
                  <FireRowsTable fires={fires} />
                ) : (
                  <p className="text-sm text-muted-foreground">No runs yet.</p>
                )}
              </div>
            )}
            <Separator />
          </div>
        ))
      )}
      {(editing || creating) && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !editorPending) {
              setEditing(null);
              setCreating(null);
            }
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[688px]">
            <DialogHeader>
              <DialogTitle>
                {editing ? 'Edit routine' : 'New routine'}
              </DialogTitle>
              <DialogDescription>
                Set the trigger and the work this agent should do.
              </DialogDescription>
            </DialogHeader>
            <RoutineEditor
              mode={editing ? 'edit' : 'create'}
              agentId={editing?.agentId ?? creating!}
              agentName={nameFor(editing?.agentId ?? creating!)}
              routine={editing ?? undefined}
              onPendingChange={setEditorPending}
              onSaved={saved}
              onCancel={() => {
                setEditing(null);
                setCreating(null);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !flight.current && !uncertain) setDeleting(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {deleting.name}?</DialogTitle>
              <DialogDescription>
                This stops future runs. Existing Activity remains available.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy !== null || uncertain || fireProtected}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void mutate(deleting, 'delete')}
              >
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
