import { useEffect, useState } from 'react';
import { Trash2, Pencil, Plus } from 'lucide-react';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  listDefaultRoutines,
  deleteDefaultRoutine,
} from '@/lib/default-routines';
import type { DefaultRoutineSummary } from '@ax/routines';
import { DefaultRoutineEditor } from './DefaultRoutineEditor';

function triggerLabel(t: DefaultRoutineSummary['trigger']): string {
  switch (t.kind) {
    case 'interval':
      return `interval ${t.every}`;
    case 'cron':
      return `cron ${t.expr}`;
    case 'webhook':
      return `webhook ${t.path}`;
  }
}

export function DefaultRoutinesSection() {
  const [defaults, setDefaults] = useState<DefaultRoutineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

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

  async function handleDelete(id: string) {
    try {
      await deleteDefaultRoutine(id);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Default Routines</CardTitle>
        <Dialog open={showNew} onOpenChange={setShowNew}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-3.5 w-3.5 mr-1" />
              New default routine
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create a default routine</DialogTitle>
            </DialogHeader>
            <DefaultRoutineEditor
              onSaved={() => {
                setShowNew(false);
                void refresh();
              }}
              onCancel={() => setShowNew(false)}
            />
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {defaults === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : defaults.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No default routines yet. Click "New default routine" to add one.
          </p>
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
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        disabled
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{d.description}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {triggerLabel(d.trigger)}
                    </Badge>
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingDelete(d.defaultRoutineId)}
                      aria-label={`Delete ${d.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
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
              if (!o) setEditingId(null);
            }}
          >
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Edit default routine: {editingId}</DialogTitle>
              </DialogHeader>
              <DefaultRoutineEditor
                defaultRoutineId={editingId}
                onSaved={() => {
                  setEditingId(null);
                  void refresh();
                }}
                onCancel={() => setEditingId(null)}
              />
            </DialogContent>
          </Dialog>
        )}

        {pendingDelete !== null && (
          <Dialog
            open={true}
            onOpenChange={(o) => {
              if (!o) setPendingDelete(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete default routine?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                Delete <code className="font-mono">{pendingDelete}</code>? This
                cascades to every agent that materialized this template. The
                next tick will not re-create them.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setPendingDelete(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void handleDelete(pendingDelete)}
                >
                  Delete
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
