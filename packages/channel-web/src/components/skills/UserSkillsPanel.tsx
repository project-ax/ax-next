/**
 * UserSkillsPanel — modal chrome for the per-user "My Skills" view.
 *
 * Dialog overlay that lets every signed-in user CRUD their own user-scoped
 * skills, talking to `/settings/skills*`. Server forces scope='user' and
 * ownerUserId from the session — the client never sends either.
 *
 * Mirrors RoutinesPanel's Dialog structure and SkillsTab's table UI, minus
 * the admin-only check-update / refresh-from-source actions.
 *
 * SECURITY NOTE — the access gate is entirely server-side. Hiding admin
 * features here is UX convenience only.
 */
import { useEffect, useState } from 'react';
import { Trash2, Pencil, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  listUserSkills,
  getUserSkill,
  createUserSkill,
  updateUserSkill,
  deleteUserSkill,
} from '@/lib/user-skills';
import type { SkillSummary } from '@ax/skills';
import { SkillEditor } from '@/components/admin/SkillEditor';
import type { SkillEditorApi } from '@/components/admin/SkillEditor';

/**
 * Stable API object for SkillEditor. Defined at module level so the
 * reference is stable across renders (avoids re-running the editor's
 * skillId effect on every parent re-render).
 */
const userSkillsApi: SkillEditorApi = {
  getSkill: getUserSkill,
  upsertSkill: createUserSkill,
  updateSkill: updateUserSkill,
};

export function UserSkillsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const items = await listUserSkills();
      setSkills(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSkills([]);
    }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  async function handleDelete(skillId: string) {
    try {
      await deleteUserSkill(skillId);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-[900px] font-sans">
          <DialogHeader>
            <DialogTitle>My Skills</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 mt-2 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Skills you've installed for your own use. Only you can see and use them.
              </p>
              <Button
                size="sm"
                onClick={() => setShowNew(true)}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                New skill
              </Button>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {skills === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No skills installed. Click "New skill" to add one.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Hosts</TableHead>
                    <TableHead>Slots</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skills.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">
                        {s.id}
                        {s.defaultAttached && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            default
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{s.description}</TableCell>
                      <TableCell>
                        {s.capabilities.allowedHosts.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          s.capabilities.allowedHosts.map((h) => (
                            <Badge
                              key={h}
                              variant="secondary"
                              className="text-xs mr-1"
                            >
                              {h}
                            </Badge>
                          ))
                        )}
                      </TableCell>
                      <TableCell>
                        {s.capabilities.credentials.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          s.capabilities.credentials.map((c) => (
                            <Badge
                              key={c.slot}
                              variant="outline"
                              className="text-xs mr-1 font-mono"
                            >
                              {c.slot}
                            </Badge>
                          ))
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(s.updatedAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingId(s.id)}
                          aria-label={`Edit ${s.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDelete(s.id)}
                          aria-label={`Delete ${s.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Create dialog — outside the main Dialog to avoid nested dialog issues */}
      {showNew && (
        <Dialog open={true} onOpenChange={(v) => { if (!v) setShowNew(false); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Install a new skill</DialogTitle>
            </DialogHeader>
            <SkillEditor
              api={userSkillsApi}
              onSaved={() => {
                setShowNew(false);
                void refresh();
              }}
              onCancel={() => setShowNew(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Edit dialog */}
      {editingId !== null && (
        <Dialog
          open={true}
          onOpenChange={(v) => {
            if (!v) setEditingId(null);
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Edit skill: {editingId}</DialogTitle>
            </DialogHeader>
            <SkillEditor
              skillId={editingId}
              api={userSkillsApi}
              onSaved={() => {
                setEditingId(null);
                void refresh();
              }}
              onCancel={() => setEditingId(null)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirmation dialog */}
      {pendingDelete !== null && (
        <Dialog
          open={true}
          onOpenChange={(v) => {
            if (!v) setPendingDelete(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete skill?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Delete <code className="font-mono">{pendingDelete}</code>? This
              cannot be undone. If the skill is attached to any agent, the
              delete will fail and you'll need to detach first.
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
    </>
  );
}
