import { useEffect, useState } from 'react';
import { Trash2, Pencil, Plus, FileCode } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  listSkills,
  getSkill,
  deleteSkill,
  checkSkillForUpdates,
  refreshSkillFromSource,
  setSkillDefaultAttached,
  type CheckUpdateResult,
  type CatalogSkillSummary,
} from '@/lib/skills';
import { BundleFileView } from './BundleFileView';
import { reconstructSkillMd } from '@/lib/bundle-diff';
import { SkillEditor } from './SkillEditor';

export function CatalogTab() {
  const [skills, setSkills] = useState<CatalogSkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [viewingFiles, setViewingFiles] = useState<{
    id: string;
    files: { path: string; contents: string }[];
  } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<
    Record<string, CheckUpdateResult>
  >({});
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const items = await listSkills();
      setSkills(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Surface an empty list alongside the alert so the render branch
      // doesn't stay stuck on "Loading…" (which keys off skills === null).
      setSkills([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Fire `checkSkillForUpdates` for every skill that declares a sourceUrl.
  // Best-effort: a broken URL on one skill must not poison the whole tab,
  // so we swallow per-skill errors silently. The error Alert is reserved
  // for `listSkills` / `deleteSkill` / `refreshSkillFromSource` failures
  // (where the user took explicit action and deserves explicit feedback).
  useEffect(() => {
    if (!skills) return;
    let cancelled = false;
    for (const s of skills) {
      if (!s.sourceUrl) continue;
      void (async () => {
        try {
          const result = await checkSkillForUpdates(s.id);
          if (cancelled) return;
          setUpdateInfo((prev) => ({ ...prev, [s.id]: result }));
        } catch {
          // Silent — see comment above.
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [skills]);

  async function handleDelete(skillId: string) {
    try {
      await deleteSkill(skillId);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
    }
  }

  async function handleViewFiles(skillId: string) {
    try {
      const detail = await getSkill(skillId);
      setViewingFiles({
        id: skillId,
        files: [
          { path: 'SKILL.md', contents: reconstructSkillMd(detail.manifestYaml, detail.bodyMd) },
          ...detail.files,
        ],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleDefault(skillId: string, next: boolean) {
    try {
      await setSkillDefaultAttached(skillId, next);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpdate(skillId: string) {
    setRefreshingId(skillId);
    try {
      await refreshSkillFromSource(skillId);
      // Clear cached "available" state for this id so the badge disappears
      // immediately on success; the post-refresh `listSkills` will re-trigger
      // the check effect, which will populate fresh state if still relevant.
      setUpdateInfo((prev) => {
        const next = { ...prev };
        delete next[skillId];
        return next;
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Catalog</CardTitle>
        <Dialog open={showNew} onOpenChange={setShowNew}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-3.5 w-3.5 mr-1" />
              New skill
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Install a new skill</DialogTitle>
            </DialogHeader>
            <SkillEditor
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
                <TableHead>Tier</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Connectors</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[160px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skills.map((s) => {
                const update = updateInfo[s.id];
                const updateAvailable = update?.available === true;
                return (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">
                    {s.id}
                    {updateAvailable && (
                      <Badge variant="secondary" className="ml-2 text-xs">
                        Update available: v{update?.latestVersion}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{s.description}</TableCell>
                  <TableCell>
                    {s.tier ? (
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {s.tier}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* TASK-100 — a skill declares no credentials, so it can
                        always be default-attached (instruction-only). */}
                    <Checkbox
                      checked={s.defaultAttached}
                      onCheckedChange={(v) => void handleToggleDefault(s.id, v === true)}
                      aria-label={`Default for ${s.id}`}
                    />
                  </TableCell>
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
                    {updateAvailable && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleUpdate(s.id)}
                        disabled={refreshingId === s.id}
                        aria-label={`Update ${s.id} to v${update?.latestVersion}`}
                      >
                        Update
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleViewFiles(s.id)}
                      aria-label={`View files for ${s.id}`}
                    >
                      <FileCode className="h-3.5 w-3.5" />
                    </Button>
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
                );
              })}
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
                <DialogTitle>Edit skill: {editingId}</DialogTitle>
              </DialogHeader>
              <SkillEditor
                skillId={editingId}
                onSaved={() => {
                  setEditingId(null);
                  void refresh();
                }}
                onCancel={() => setEditingId(null)}
              />
            </DialogContent>
          </Dialog>
        )}

        {viewingFiles !== null && (
          <Dialog
            open
            onOpenChange={(o) => {
              if (!o) setViewingFiles(null);
            }}
          >
            <DialogContent className="max-w-4xl">
              <DialogHeader>
                <DialogTitle>Bundle files: {viewingFiles.id}</DialogTitle>
              </DialogHeader>
              <BundleFileView files={viewingFiles.files} />
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
      </CardContent>
    </Card>
  );
}
