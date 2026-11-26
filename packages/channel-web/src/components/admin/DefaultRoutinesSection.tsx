import { useEffect, useState } from 'react';
import { Trash2, Pencil, Plus } from 'lucide-react';
import { AsyncState, ConfirmAction, EmptyState, Notice, StatusBadge } from '@project-ax/ui';
import { focusAfterRemoval } from '@/lib/focus-after-removal';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  listDefaultRoutines,
  deleteDefaultRoutine,
  getDefaultRoutine,
  upsertDefaultRoutine,
  updateDefaultRoutine,
} from '@/lib/default-routines';
import type {
  DefaultRoutineSummary,
} from '@/lib/default-routines';
import {
  RoutineDefinitionSchema,
  type RoutineDefinition,
} from '@ax/routines-contract';
import { DefaultRoutineEditor } from '@/components/routines/RoutineEditor';

function triggerLabel(t: DefaultRoutineSummary['trigger']): string {
  switch (t.kind) {
    case 'interval':
      return `interval ${t.every}`;
  }
}

export function DefaultRoutinesSection() {
  const [defaults, setDefaults] = useState<DefaultRoutineSummary[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [editReadTick, setEditReadTick] = useState(0);
  const [editorPending, setEditorPending] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Load the canonical definition when the editor opens.
  const [editingInitial, setEditingInitial] =
    useState<RoutineDefinition | null>(null);
  const [editLoadError, setEditLoadError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const items = await listDefaultRoutines();
      setDefaults(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Surface an empty list alongside the alert so the render branch
      // doesn't stay stuck on "Loading…" (mirror SkillsTab's posture).
      setDefaults([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Load the routine being edited so the editor opens populated.
  useEffect(() => {
    if (editingId === null) {
      setEditingInitial(null);
      setEditLoadError(null);
      return;
    }
    let cancelled = false;
    setEditingInitial(null);
    setEditLoadError(null);
    getDefaultRoutine(editingId)
      .then((detail) => {
        if (!cancelled) {
          const { defaultRoutineId: _id, updatedAt: _updated, ...definition } = detail;
          setEditingInitial(RoutineDefinitionSchema.parse(definition));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEditLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editingId, editReadTick]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Default Routines</CardTitle>
        <Dialog
          open={showNew}
          onOpenChange={(open) => {
            if (!editorPending) setShowNew(open);
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" data-return-focus="default-routines">
              <Plus className="h-3.5 w-3.5 mr-1" />
              New default routine
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[688px]">
            <DialogHeader>
              <DialogTitle>Create a default routine</DialogTitle>
            </DialogHeader>
            <DefaultRoutineEditor
              onPendingChange={setEditorPending}
              onSave={async (definition) => {
                await upsertDefaultRoutine(definition);
              }}
              onSaved={() => {
                setEditorPending(false);
                setShowNew(false);
                void refresh();
              }}
              onCancel={() => setShowNew(false)}
            />
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Notice tone="danger" action={{ label: 'Try again', onClick: () => void refresh() }}>{error}</Notice>
        )}
        {defaults === null ? (
          <AsyncState status="loading" skeleton="rows" loadingLabel="Loading default routines" />
        ) : defaults.length === 0 ? (
          error ? null : <EmptyState
            title="No default routines yet."
            description={'Click "New default routine" to add one.'}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[120px]">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {defaults.map((d) => (
                <TableRow key={d.defaultRoutineId}>
                  <TableCell className="font-mono text-xs">
                    {d.name}
                    {!d.enabled && (
                      <>
                        {' '}
                        <StatusBadge tone="neutral" dot>disabled</StatusBadge>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{d.description}</TableCell>
                  <TableCell>
                    <StatusBadge tone="neutral">
                      {triggerLabel(d.trigger)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(d.updatedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(d.defaultRoutineId)}
                      aria-label={`Edit ${d.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <ConfirmAction
                      trigger={{ label: `Delete ${d.name}`, intent: 'quiet', size: 'sm', icon: Trash2, iconOnly: true }}
                      title="Delete default routine?"
                      description={`Delete ${d.defaultRoutineId}? This cascades to every agent that materialized this template. The next tick will not re-create them.`}
                      confirmLabel="Delete"
                      errorMessage={(err) => (err instanceof Error ? err.message : String(err))}
                      onConfirm={async () => {
                        await deleteDefaultRoutine(d.defaultRoutineId);
                        await refresh();
                        // The row that opened this is gone; park focus on the list's primary action.
                        focusAfterRemoval('[data-return-focus="default-routines"]');
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {editingId !== null && (
          <Dialog
            open={true}
            onOpenChange={(o) => {
              if (!o && !editorPending) setEditingId(null);
            }}
          >
            <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[688px]">
              <DialogHeader>
                <DialogTitle>Edit default routine: {editingId}</DialogTitle>
              </DialogHeader>
              {editLoadError !== null ? (
                <Notice
                  tone="danger"
                  action={{ label: 'Try again', onClick: () => setEditReadTick((n) => n + 1) }}
                >
                  {editLoadError}
                </Notice>
              ) : editingInitial === null ? (
                <AsyncState status="loading" skeleton="lines" loadingLabel="Loading default routine" />
              ) : (
                <DefaultRoutineEditor
                  onPendingChange={setEditorPending}
                  initial={editingInitial}
                  onSave={async (definition) => {
                    await updateDefaultRoutine(editingId, definition);
                  }}
                  onSaved={() => {
                    setEditorPending(false);
                    setEditingId(null);
                    void refresh();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
