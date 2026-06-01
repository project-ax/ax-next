/**
 * SkillsAppStore — the Settings "Skills" surface as an app-store (TASK-126,
 * settings-unified epic, design card 3). Replaces the flat "My Skills" list
 * (UserSkillsPanelBody) with two shelves:
 *
 *   INSTALLED (n)                      — skills active on the CURRENT agent:
 *                                        🏢 admin defaults + agent-global +
 *                                        the user's own user-scoped attachments.
 *                                        Per-row Remove (only removable / user
 *                                        source). Your own PRIVATE skills also
 *                                        get Edit / Delete / Submit-to-workspace.
 *   NOT INSTALLED · available (n)      — the workspace's vetted GLOBAL catalog
 *                                        NOT yet installed on this agent.
 *                                        Searchable. Per-row Install (with a
 *                                        capability-consent card). THIS SHELF IS
 *                                        THE OLD CATALOG (invariant #4: the
 *                                        catalog renders in exactly one place).
 *
 * Admin curation folds inline (gated on `isAdmin`), reusing the CatalogTab /
 * AdmitQueueTab logic — there is NO separate Catalog / Awaiting-review nav
 * surface anymore (TASK-125 dropped them):
 *   - per NOT-INSTALLED row: ⚙ set-as-default · remove-from-workspace · edit
 *   - section: "+ Add to workspace" · "Awaiting review (n)" approve/reject
 *
 * INSTALLED is per-(user, agent) — exactly the existing `/api/chat/connections/
 * :agentId` union (source: default|agent|user + removable). An agent selector
 * (like ConnectorsTab's allowed-sites switcher) scopes both shelves.
 *
 * SECURITY: the access gate is entirely server-side — every /admin/* curation
 * route is role-gated regardless of what this shell shows (`isAdmin` here is UX
 * convenience). Self-install posts to the server-forced, catalog-validated
 * attach route. Untrusted skill text (id / description / connector ids) renders
 * through React text nodes (auto-escaped) — never raw HTML.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Trash2,
  Pencil,
  Plus,
  Share2,
  Search,
  Star,
  XCircle,
  Building2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
import { listChatAgents, type ChatAgentSummary } from '@/lib/agents';
import {
  getConnections,
  detachConnectionSkill,
  listCatalogSkills,
  type ConnectionSkill,
  type CatalogSkillListing,
} from '@/lib/connections';
import {
  listUserSkills,
  listAuthoredSkills,
  getUserSkill,
  createUserSkill,
  updateUserSkill,
  deleteUserSkill,
  shareUserSkill,
  adoptAuthoredSkill,
} from '@/lib/user-skills';
import {
  setSkillDefaultAttached,
  deleteSkill as deleteCatalogSkill,
} from '@/lib/skills';
import type { SkillSummary, AuthoredSkillListing } from '@ax/skills';
import { SkillEditor } from '@/components/admin/SkillEditor';
import type { SkillEditorApi } from '@/components/admin/SkillEditor';
import { SkillInstallConsentDialog } from './SkillInstallConsentDialog';
import { AwaitingReviewSection } from './AwaitingReviewSection';

/** Stable user-route api for the SkillEditor (own private skills). */
const userSkillsApi: SkillEditorApi = {
  getSkill: getUserSkill,
  upsertSkill: createUserSkill,
  updateSkill: updateUserSkill,
};

type EditorTarget =
  | { mode: 'create-user' }
  | { mode: 'edit-user'; skillId: string }
  | { mode: 'create-admin' }
  | { mode: 'edit-admin'; skillId: string };

export function SkillsAppStore({ isAdmin }: { isAdmin: boolean }) {
  // Agent selector (the app-store is per-agent). `agentsLoaded` distinguishes
  // "still fetching the agent list" from "fetched, and there are none" so a
  // zero-agent account doesn't get stuck on a permanent INSTALLED spinner.
  const [agents, setAgents] = useState<ChatAgentSummary[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentId, setAgentId] = useState<string>('');

  const [installed, setInstalled] = useState<ConnectionSkill[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkillListing[] | null>(null);
  // The user's own private skill DEFINITIONS (a side-lookup so an installed
  // user-source row can expose Edit / Delete / Submit). Keyed by id.
  const [ownSkills, setOwnSkills] = useState<Map<string, SkillSummary>>(new Map());
  const [authored, setAuthored] = useState<AuthoredSkillListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Dialog / confirmation state.
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ skillId: string; scope: 'user' | 'workspace' } | null>(null);
  const [pendingShare, setPendingShare] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<{ kind: 'submitted' | 'pending'; skillId: string } | null>(null);
  const [installing, setInstalling] = useState<CatalogSkillListing | null>(null);
  // The authored draft currently being adopted (its `agentId/skillId` key), so
  // its Edit button shows an in-flight state and can't be double-clicked.
  const [adopting, setAdopting] = useState<string | null>(null);

  // ---- data loads -------------------------------------------------------

  const refreshInstalled = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const r = await getConnections(id);
      setInstalled(r.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setInstalled([]);
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    try {
      setCatalog(await listCatalogSkills());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCatalog([]);
    }
  }, []);

  const refreshOwn = useCallback(async () => {
    // Soft surfaces — a failure here must not blank the shelves.
    try {
      const items = await listUserSkills();
      setOwnSkills(new Map(items.filter((s) => s.scope === 'user').map((s) => [s.id, s])));
    } catch {
      setOwnSkills(new Map());
    }
    try {
      setAuthored(await listAuthoredSkills());
    } catch {
      setAuthored([]);
    }
  }, []);

  // Load the agent list once; default to the first agent.
  useEffect(() => {
    let cancelled = false;
    listChatAgents()
      .then((a) => {
        if (cancelled) return;
        setAgents(a);
        setAgentsLoaded(true);
        if (a[0]) setAgentId(a[0].agentId);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setAgentsLoaded(true);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    void refreshCatalog();
    void refreshOwn();
    return () => {
      cancelled = true;
    };
  }, [refreshCatalog, refreshOwn]);

  // (Re)load installed whenever the selected agent changes.
  useEffect(() => {
    void refreshInstalled(agentId);
  }, [agentId, refreshInstalled]);

  // ---- derived ----------------------------------------------------------

  const installedIds = useMemo(
    () => new Set((installed ?? []).map((s) => s.skillId)),
    [installed],
  );

  // NOT-INSTALLED = catalog minus what's already installed on this agent, then
  // filtered by the search box (id or description).
  const notInstalled = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (catalog ?? [])
      .filter((c) => !installedIds.has(c.skillId))
      .filter(
        (c) =>
          q.length === 0 ||
          c.skillId.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      );
  }, [catalog, installedIds, search]);

  // ---- actions ----------------------------------------------------------

  async function handleRemove(skillId: string): Promise<void> {
    try {
      await detachConnectionSkill(agentId, skillId);
      await refreshInstalled(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(skillId: string, scope: 'user' | 'workspace'): Promise<void> {
    try {
      if (scope === 'user') {
        await deleteUserSkill(skillId);
      } else {
        await deleteCatalogSkill(skillId);
      }
      setPendingDelete(null);
      await Promise.all([refreshInstalled(agentId), refreshCatalog(), refreshOwn()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
    }
  }

  async function handleShare(skillId: string): Promise<void> {
    setSharing(true);
    setError(null);
    try {
      const out = await shareUserSkill(skillId);
      setPendingShare(null);
      setShareResult({ kind: out.created ? 'submitted' : 'pending', skillId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingShare(null);
    } finally {
      setSharing(false);
    }
  }

  async function handleSetDefault(skillId: string, next: boolean): Promise<void> {
    try {
      await setSkillDefaultAttached(skillId, next);
      await Promise.all([refreshCatalog(), refreshInstalled(agentId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Adopt-&-edit (TASK-134): copy an agent-authored draft into the user's own
   * editable user-scoped skill, then open the form-first editor on the copy. The
   * server copies manifest + body + extra files and marks the draft adopted (so
   * it drops off the authored list on the next refresh). On success we refresh
   * and open `edit-user` on the returned skill id; on failure (e.g. the draft is
   * no longer adoptable) we surface the error and leave the list as-is.
   */
  async function handleAdopt(a: AuthoredSkillListing): Promise<void> {
    const key = `${a.agentId}/${a.skillId}`;
    setAdopting(key);
    setError(null);
    try {
      const out = await adoptAuthoredSkill(a.agentId, a.skillId);
      // The copy now lives in the user's own skills; refresh both the authored
      // list (the draft drops off) and the installed/own surfaces, then open the
      // editor on the adopted copy for further editing.
      await refreshOwn();
      setEditor({ mode: 'edit-user', skillId: out.skillId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdopting(null);
    }
  }

  function editorApiFor(target: EditorTarget): SkillEditorApi | undefined {
    // The admin variant uses the SkillEditor's default (admin /admin/skills*)
    // api; the user variant injects the /settings/skills* api.
    return target.mode === 'create-user' || target.mode === 'edit-user'
      ? userSkillsApi
      : undefined;
  }

  async function onEditorSaved(): Promise<void> {
    setEditor(null);
    await Promise.all([refreshInstalled(agentId), refreshCatalog(), refreshOwn()]);
  }

  // ---- render -----------------------------------------------------------

  const installedCount = installed?.length ?? 0;
  const notInstalledCount = notInstalled.length;

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-5 max-h-[72vh] overflow-y-auto pr-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            What your assistant can do. Install skills from your workspace, or
            create your own.
          </p>
          {agents.length > 1 && (
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.agentId} value={a.agentId}>
                    {a.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
                  submitted for admin review. Once admitted, it ships to everyone
                  and your editable copy is retired.
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

        {/* ============================ INSTALLED ========================= */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              {installed !== null ? `Installed (${installedCount})` : 'Installed'}
            </h3>
            <Button size="sm" onClick={() => setEditor({ mode: 'create-user' })}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Create
            </Button>
          </div>

          {agentsLoaded && agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No assistant yet — create one to install skills.
            </p>
          ) : installed === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : installed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No skills installed yet. Install one from your workspace below, or
              create your own.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
              {installed.map((s) => {
                const own = ownSkills.get(s.skillId);
                const isOwn = s.source === 'user' && own !== undefined;
                return (
                  <div
                    key={s.skillId}
                    data-testid={`installed-${s.skillId}`}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm truncate">
                          {s.description || s.skillId}
                        </span>
                        {s.source === 'default' && (
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            <Building2 className="h-3 w-3 mr-1" />
                            default
                          </Badge>
                        )}
                        {isOwn && (
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            your own
                          </Badge>
                        )}
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">
                        {s.skillId}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isOwn && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditor({ mode: 'edit-user', skillId: s.skillId })}
                            aria-label={`Edit ${s.skillId}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setShareResult(null);
                              setPendingShare(s.skillId);
                            }}
                            aria-label={`Submit ${s.skillId} to workspace`}
                          >
                            <Share2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPendingDelete({ skillId: s.skillId, scope: 'user' })}
                            aria-label={`Delete ${s.skillId}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      {s.removable ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRemove(s.skillId)}
                          aria-label={`Remove ${s.skillId}`}
                        >
                          Remove
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground pl-1">
                          {s.source === 'default' ? 'from workspace' : 'set by admin'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Authored-by-your-agents — skills an agent wrote in its workspace.
              "Edit" adopts the draft into your OWN editable copy (TASK-134),
              replacing the old approve-only affordance: it copies the draft
              (manifest + body + files) into your installed skills and opens the
              editor on the copy. */}
          {authored.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h4 className="text-xs font-medium text-muted-foreground">
                Authored by your agents
              </h4>
              <p className="text-xs text-muted-foreground">
                Skills your agents drafted. Edit one to make an editable copy you
                own.
              </p>
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {authored.map((a) => {
                  const key = `${a.agentId}/${a.skillId}`;
                  const isAdopting = adopting === key;
                  return (
                    <div
                      key={key}
                      data-testid={`authored-${a.skillId}`}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <span className="text-sm truncate">{a.description}</span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {a.skillId} · {a.agentId}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge
                          variant={a.status === 'active' ? 'secondary' : 'outline'}
                          className="text-xs"
                        >
                          {a.status === 'active' ? 'active' : 'pending review'}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={adopting !== null}
                          onClick={() => void handleAdopt(a)}
                          aria-label={`Edit ${a.skillId}`}
                        >
                          {isAdopting ? 'Adopting…' : 'Edit'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <Separator />

        {/* ========================= NOT INSTALLED ======================= */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-foreground">
              {catalog !== null &&
              agentsLoaded &&
              (installed !== null || agents.length === 0)
                ? `Not installed · available in your workspace (${notInstalledCount})`
                : 'Not installed · available in your workspace'}
            </h3>
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditor({ mode: 'create-admin' })}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add to workspace
              </Button>
            )}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the workspace catalog…"
              className="pl-8"
              aria-label="Search the workspace catalog"
            />
          </div>

          {catalog === null ||
          !agentsLoaded ||
          (agents.length > 0 && installed === null) ? (
            // Wait for the catalog, the agent list, and — when there's an agent —
            // the installed set, so we never flash an already-installed skill as
            // "installable" before the exclusion lands. With no agent, the catalog
            // is browsable (Install is disabled until an agent exists).
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : notInstalled.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {search.trim().length > 0
                ? 'No matching skills in your workspace.'
                : 'Nothing left to install — everything in your workspace is already on this assistant.'}
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
              {notInstalled.map((c) => (
                <div
                  key={c.skillId}
                  data-testid={`catalog-${c.skillId}`}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm truncate">{c.description || c.skillId}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {c.skillId}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isAdmin && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleSetDefault(c.skillId, !c.defaultAttached)}
                          aria-label={
                            c.defaultAttached
                              ? `Unset ${c.skillId} as default`
                              : `Set ${c.skillId} as default`
                          }
                        >
                          <Star
                            className={
                              'h-3.5 w-3.5' + (c.defaultAttached ? ' fill-current' : '')
                            }
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditor({ mode: 'edit-admin', skillId: c.skillId })}
                          aria-label={`Edit ${c.skillId} definition`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPendingDelete({ skillId: c.skillId, scope: 'workspace' })
                          }
                          aria-label={`Remove ${c.skillId} from workspace`}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      onClick={() => setInstalling(c)}
                      disabled={agentId === ''}
                    >
                      Install
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Admin-only: the folded admit queue (the old "Skills awaiting
              review" surface, now an inline affordance). */}
          {isAdmin && (
            <AwaitingReviewSection
              onReviewed={() => {
                void refreshCatalog();
              }}
            />
          )}
        </section>
      </div>

      {/* ---------------------------- dialogs --------------------------- */}

      {editor !== null && (
        <Dialog open onOpenChange={(o) => { if (!o) setEditor(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editor.mode === 'create-user' && 'Create a skill'}
                {editor.mode === 'edit-user' && `Edit skill: ${editor.skillId}`}
                {editor.mode === 'create-admin' && 'Add a skill to the workspace'}
                {editor.mode === 'edit-admin' && `Edit workspace skill: ${editor.skillId}`}
              </DialogTitle>
            </DialogHeader>
            {(() => {
              // Build the optional props as a single object so
              // exactOptionalPropertyTypes is happy (a `key: undefined` spread
              // would otherwise violate it). The admin variant omits `api`
              // entirely → SkillEditor's default admin (/admin/skills*) api.
              const editorProps: {
                skillId?: string;
                api?: SkillEditorApi;
              } = {};
              if (editor.mode === 'edit-user' || editor.mode === 'edit-admin') {
                editorProps.skillId = editor.skillId;
              }
              const api = editorApiFor(editor);
              if (api !== undefined) editorProps.api = api;
              return (
                <SkillEditor
                  {...editorProps}
                  onSaved={() => void onEditorSaved()}
                  onCancel={() => setEditor(null)}
                />
              );
            })()}
          </DialogContent>
        </Dialog>
      )}

      {pendingDelete !== null && (
        <Dialog open onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {pendingDelete.scope === 'user'
                  ? 'Delete skill?'
                  : 'Remove from workspace?'}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {pendingDelete.scope === 'user' ? (
                <>
                  Delete <code className="font-mono">{pendingDelete.skillId}</code>?
                  This cannot be undone. If it's attached to any agent, the delete
                  will fail and you'll need to remove it first.
                </>
              ) : (
                <>
                  Remove <code className="font-mono">{pendingDelete.skillId}</code>{' '}
                  from the workspace catalog? It will no longer be available for
                  anyone to install.
                </>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() =>
                  void handleDelete(pendingDelete.skillId, pendingDelete.scope)
                }
              >
                {pendingDelete.scope === 'user' ? 'Delete' : 'Remove'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {pendingShare !== null && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o && !sharing) setPendingShare(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Submit to workspace?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Submit <code className="font-mono">{pendingShare}</code> for org-wide
              use. An admin reviews it before it goes live. Once admitted, it ships
              to everyone read-only and your editable copy is retired.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setPendingShare(null)}
                disabled={sharing}
              >
                Cancel
              </Button>
              <Button onClick={() => void handleShare(pendingShare)} disabled={sharing}>
                {sharing ? 'Submitting…' : 'Submit'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {installing !== null && (
        <SkillInstallConsentDialog
          skill={installing}
          agentId={agentId}
          open
          onOpenChange={(o) => {
            if (!o) setInstalling(null);
          }}
          onInstalled={() => {
            setInstalling(null);
            void refreshInstalled(agentId);
          }}
        />
      )}
    </TooltipProvider>
  );
}
