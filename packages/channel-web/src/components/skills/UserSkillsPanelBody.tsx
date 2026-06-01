/**
 * UserSkillsPanelBody — the per-user "My Skills" content, sans modal chrome.
 *
 * Extracted from UserSkillsPanel so the SAME content renders in two places
 * (one source of truth, invariant #4):
 *   - `UserSkillsPanel` wraps it in a Dialog (the user-menu "My Skills" entry).
 *   - `SkillsTab` renders it inline as the Settings "Skills" tab body
 *     (connectors-first-class UI/IA reorg).
 *
 * Every signed-in user can CRUD their own user-scoped skills via
 * `/settings/skills*`; the server forces `scope='user'` and ownerUserId from the
 * session — the client never sends either. The JIT early-approval (TASK-83) and
 * authored-skill (TASK-85) affordances live here too.
 *
 * SOURCE BADGE (connectors-first-class): each skill row wears the single
 * "Catalog" tag iff it's admin-curated (`scope === 'global'`); a private copy
 * (`scope === 'user'`) shows none. A solo user with only private skills sees no
 * badge and no "catalog" language.
 *
 * SECURITY NOTE — the access gate is entirely server-side. Hiding admin
 * features here is UX convenience only. Untrusted skill text (id / description)
 * renders through React text nodes (auto-escaped) — never raw HTML.
 */
import { useEffect, useState } from 'react';
import { Trash2, Pencil, Plus, Share2, KeyRound } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SourceBadge, skillSource } from '@/components/SourceBadge';
import {
  listUserSkills,
  listAuthoredSkills,
  getUserSkill,
  createUserSkill,
  updateUserSkill,
  deleteUserSkill,
  shareUserSkill,
  approveAuthoredSkill,
} from '@/lib/user-skills';
import { setDestinationCredential } from '@/lib/credentials';
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

/**
 * @param active — when false the body skips its data fetch (the modal passes
 *   `open`; the tab always passes true). Refetch fires when `active` flips true.
 */
export function UserSkillsPanelBody({ active }: { active: boolean }) {
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
  // JIT early-approval (TASK-83): the pending cap-skill the user is approving
  // before first use, the per-slot key values they've typed, and approve state.
  const [pendingApprove, setPendingApprove] =
    useState<AuthoredSkillListing | null>(null);
  const [approveValues, setApproveValues] = useState<Record<string, string>>({});
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approveResult, setApproveResult] = useState<string | null>(null);

  // Every non-vaulted slot must be filled before Approve is enabled (a slot
  // already in the user's shared vault counts as filled — no re-entry). Mirrors
  // the in-chat PermissionCard's gating.
  const approveSlots = pendingApprove?.pendingCapabilities?.slots ?? [];
  const allApproveSlotsFilled = approveSlots.every(
    (s) =>
      s.haveExisting === true ||
      (approveValues[s.slot] ?? '').trim().length > 0,
  );

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
    if (!active) return;
    void refresh();
  }, [active]);

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

  function closeApprove(): void {
    setPendingApprove(null);
    setApproveValues({});
    setApproveError(null);
  }

  /**
   * JIT early-approval (TASK-83). The out-of-band twin of the in-chat
   * PermissionCard's Connect: (1) write each entered key straight to the host
   * credential store (never the model/transcript — §10), routing an
   * `account:<svc>` slot to the shared vault and an untagged slot to the
   * per-skill ref the grant re-derives; (2) fire the early-approve grant with
   * the `shown` TOCTOU guard so only the caps the panel displayed get approved.
   * Capability gating stays strict — this still requires the human + the key.
   */
  async function handleApprove(listing: AuthoredSkillListing): Promise<void> {
    const caps = listing.pendingCapabilities;
    if (approving || caps === undefined || !allApproveSlotsFilled) return;
    setApproving(true);
    setApproveError(null);
    try {
      for (const s of caps.slots) {
        if (s.haveExisting === true) continue; // already vaulted — nothing to write
        const payload = (approveValues[s.slot] ?? '').trim();
        if (payload.length === 0) continue;
        const destination =
          s.account !== undefined
            ? ({ kind: 'account', service: s.account } as const)
            : ({ kind: 'skill-slot', skillId: listing.skillId, slot: s.slot } as const);
        await setDestinationCredential({
          destination,
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
      await approveAuthoredSkill({
        agentId: listing.agentId,
        skillId: listing.skillId,
        shown: {
          hosts: caps.hosts,
          slots: caps.slots.map((s) => s.slot),
          npm: caps.packages.npm,
          pypi: caps.packages.pypi,
        },
      });
      closeApprove();
      setApproveResult(listing.skillId);
      await refresh();
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4 mt-2 max-h-[70vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Skills you've installed for your own use. Only you can see and use them.
          </p>
          <Button size="sm" onClick={() => setShowNew(true)}>
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
                <TableHead>Connectors</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skills.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">
                    {s.id}
                    <SourceBadge source={skillSource(s.scope)} />
                    {s.defaultAttached && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        default
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{s.description}</TableCell>
                  <TableCell>
                    {s.connectors.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      s.connectors.map((c) => (
                        <Badge
                          key={c}
                          variant="secondary"
                          className="text-xs mr-1"
                        >
                          {c}
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

        {/* JIT early-approval result banner (TASK-83). */}
        {approveResult !== null && (
          <Alert>
            <AlertDescription>
              <code className="font-mono">{approveResult}</code> is approved
              and live. Your agent can use it on its next turn — no in-chat
              prompt needed.
            </AlertDescription>
          </Alert>
        )}

        {/* Agent-authored skills (TASK-85) — these are authored in chat;
            "My Skills" surfaces them. A pending cap-bearing skill (TASK-83)
            also gets an inline approve + key affordance so it can be
            approved BEFORE the agent's first use. */}
        {authored !== null && authored.length > 0 && (
          <div className="flex flex-col gap-2">
            {skills !== null && skills.length > 0 && <Separator />}
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Authored by your agents</h3>
              <p className="text-sm text-muted-foreground">
                Skills your agents created. A pending skill that needs access
                or a key waits for your approval before it goes live — approve
                it here to skip the in-chat prompt on first use.
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[110px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {authored.map((s) => {
                  const needsApproval =
                    s.status === 'pending' &&
                    s.pendingCapabilities !== undefined;
                  return (
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
                          {s.status === 'active'
                            ? 'active'
                            : needsApproval
                              ? 'needs approval'
                              : 'pending review'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {needsApproval && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setApproveResult(null);
                              setApproveValues({});
                              setApproveError(null);
                              setPendingApprove(s);
                            }}
                            aria-label={`Approve ${s.skillId}`}
                          >
                            <KeyRound className="h-3.5 w-3.5 mr-1" />
                            Approve
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Create dialog — outside the main content to avoid nested dialog issues */}
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
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
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

      {/* JIT early-approval dialog (TASK-83) — the out-of-band twin of the
          in-chat approval card. Shows the hosts the skill reaches + one field
          per credential slot; on Approve the keys post straight to the
          credential store and the early-approve grant fires. */}
      {pendingApprove !== null && pendingApprove.pendingCapabilities && (
        <Dialog
          open={true}
          onOpenChange={(v) => {
            if (!v && !approving) closeApprove();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve {pendingApprove.skillId}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {pendingApprove.description}
            </p>
            <div className="flex flex-col gap-4">
              {pendingApprove.pendingCapabilities.hosts.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs text-muted-foreground">Will access</p>
                  <div className="flex flex-wrap gap-1.5">
                    {pendingApprove.pendingCapabilities.hosts.map((h) => (
                      <Badge key={h} variant="secondary">
                        {h}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {pendingApprove.pendingCapabilities.slots.map((s) =>
                s.haveExisting === true ? (
                  // Already in the user's shared vault — offer it, no re-entry.
                  <div
                    key={s.slot}
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <Badge variant="secondary">{s.account ?? s.slot}</Badge>
                    <span>
                      Using your existing{' '}
                      {(s.account ?? s.slot).charAt(0).toUpperCase() +
                        (s.account ?? s.slot).slice(1)}{' '}
                      key
                    </span>
                  </div>
                ) : (
                  <div key={s.slot} className="grid gap-1.5">
                    <Label htmlFor={`approve-cred-${s.slot}`}>{s.slot}</Label>
                    <Input
                      id={`approve-cred-${s.slot}`}
                      type="password"
                      autoComplete="off"
                      value={approveValues[s.slot] ?? ''}
                      onChange={(e) =>
                        setApproveValues((v) => ({
                          ...v,
                          [s.slot]: e.target.value,
                        }))
                      }
                    />
                  </div>
                ),
              )}
              {(pendingApprove.pendingCapabilities.packages.npm.length > 0 ||
                pendingApprove.pendingCapabilities.packages.pypi.length > 0) && (
                <p className="text-sm text-muted-foreground">
                  {pendingApprove.pendingCapabilities.packages.npm.length > 0 && (
                    <>
                      Installs npm packages → reaches{' '}
                      <code>registry.npmjs.org</code>.{' '}
                    </>
                  )}
                  {pendingApprove.pendingCapabilities.packages.pypi.length > 0 && (
                    <>
                      Installs Python packages → reaches <code>pypi.org</code>,{' '}
                      <code>files.pythonhosted.org</code>.
                    </>
                  )}
                </p>
              )}
              {approveError !== null && (
                <Alert variant="destructive">
                  <AlertDescription>{approveError}</AlertDescription>
                </Alert>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeApprove} disabled={approving}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleApprove(pendingApprove)}
                disabled={approving || !allApproveSlotsFilled}
              >
                {approving ? 'Approving…' : 'Approve'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
