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
import { Trash2, Pencil, Plus, Share2 } from 'lucide-react';
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
import { Separator } from '@/components/ui/separator';
import {
  listUserSkills,
  listAuthoredSkills,
  getUserSkill,
  createUserSkill,
  updateUserSkill,
  deleteUserSkill,
  shareUserSkill,
} from '@/lib/user-skills';
import type { SkillSummary, AuthoredSkillListing } from '@ax/skills';
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
  // Agent-authored skills (TASK-85): surfaced read-only alongside catalog skills
  // so authored/approved work doesn't read as "No skills installed".
  const [authored, setAuthored] = useState<AuthoredSkillListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Share-to-catalog flow: the skill id awaiting submit confirmation, whether a
  // submit is in flight, and a one-shot result banner ('submitted' | 'pending').
  const [pendingShare, setPendingShare] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<
    { kind: 'submitted' | 'pending'; skillId: string } | null
  >(null);

  async function refresh() {
    setError(null);
    // Fetch catalog + authored skills together. Authored is a soft surface — a
    // failure there must not blank out the catalog list, so it's caught
    // independently (an absent @ax/agents already returns [] without erroring).
    try {
      const items = await listUserSkills();
      setSkills(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSkills([]);
    }
    try {
      const items = await listAuthoredSkills();
      setAuthored(items);
    } catch {
      setAuthored([]);
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

  async function handleShare(skillId: string) {
    setSharing(true);
    setError(null);
    try {
      const out = await shareUserSkill(skillId);
      setPendingShare(null);
      // `created:false` means a request for this skill is already pending admin
      // review (dedup) — not an error, just a different banner.
      setShareResult({ kind: out.created ? 'submitted' : 'pending', skillId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingShare(null);
    } finally {
      setSharing(false);
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

            {shareResult && (
              <Alert>
                <AlertDescription>
                  {shareResult.kind === 'submitted' ? (
                    <>
                      <code className="font-mono">{shareResult.skillId}</code> was
                      submitted for admin review. Once admitted, it ships to
                      everyone and your editable copy is retired.
                    </>
                  ) : (
                    <>
                      <code className="font-mono">{shareResult.skillId}</code> is
                      already submitted and pending admin review.
                    </>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {skills === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : skills.length === 0 &&
              (authored === null || authored.length === 0) ? (
              <p className="text-sm text-muted-foreground">
                No skills installed. Click "New skill" to add one.
              </p>
            ) : skills.length === 0 ? null : (
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
                          onClick={() => {
                            setShareResult(null);
                            setPendingShare(s.id);
                          }}
                          aria-label={`Share ${s.id} to catalog`}
                        >
                          <Share2 className="h-3.5 w-3.5" />
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

            {/* Agent-authored skills (TASK-85) — read-only here; these are
                authored in chat, "My Skills" only surfaces them. */}
            {authored !== null && authored.length > 0 && (
              <div className="flex flex-col gap-2">
                {skills !== null && skills.length > 0 && <Separator />}
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">Authored by your agents</h3>
                  <p className="text-sm text-muted-foreground">
                    Skills your agents created. Pending ones are waiting on your
                    approval before they go live.
                  </p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {authored.map((s) => (
                      <TableRow key={`${s.agentId}/${s.skillId}`}>
                        <TableCell className="font-mono text-xs">
                          {s.skillId}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {s.agentId}
                        </TableCell>
                        <TableCell className="text-sm">{s.description}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              s.status === 'active' ? 'secondary' : 'outline'
                            }
                            className="text-xs"
                          >
                            {s.status === 'active' ? 'active' : 'pending review'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
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

      {/* Share-to-catalog confirmation dialog */}
      {pendingShare !== null && (
        <Dialog
          open={true}
          onOpenChange={(v) => {
            if (!v && !sharing) setPendingShare(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Submit to catalog?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Submit <code className="font-mono">{pendingShare}</code> for
              org-wide use. An admin reviews the skill before it goes live.
              Once admitted, it ships to everyone read-only and your editable
              copy is retired — to change it later, you'd author a new skill and
              re-submit.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setPendingShare(null)}
                disabled={sharing}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleShare(pendingShare)}
                disabled={sharing}
              >
                {sharing ? 'Submitting…' : 'Submit'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
