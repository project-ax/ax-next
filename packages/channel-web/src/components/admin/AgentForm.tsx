/**
 * AgentForm — CRUD for agents, in the user "Settings" surface. Agents are
 * owner-scoped, so EVERY user manages their OWN agents here (the `/admin/agents`
 * routes are requireUser + owner-scoped, not admin-gated). `isAdmin` gates the
 * admin-only bits: non-admins read/attach connectors via `/settings/connectors`
 * and may attach only PERSONAL connectors (workspace/shared stay admin-only —
 * enforced server-side); the authored-skill drafts section is admin-only for now.
 *
 * Shape mirrors the real `/admin/agents` wire (camelCase + visibility).
 * The legacy snake_case mock fields (desc/color/tag/owner_type) have no
 * counterpart on the server — we drop them rather than send-and-pray.
 *
 * Two states share the same component:
 *
 *   - List view: every agent the actor can see, with edit + delete
 *     buttons per row, and a "+ New agent" button at the top.
 *   - Form view: opens for "+ New agent" or "edit". Submit POSTs (new)
 *     or PATCHes (edit) and re-fetches the list on success.
 *
 * Visibility radio toggles the team picker. The teams list comes from
 * `/admin/teams`. `allowedTools` stays a dumb comma-separated text field;
 * connectors are attached via a PICKER — a checkbox list over
 * `/admin/connectors`. TASK-107 — selected connector ids are now written to the
 * FIRST-CLASS per-agent connector-attachment store
 * (PATCH /admin/agents/:id/connector-attachments), NOT `mcpConfigIds` (which
 * reverts to MCP-only meaning). The orchestrator's connector union reads that
 * store; the picker save runs AFTER the agent create/PATCH so the agent id
 * exists (mirroring the SkillAttachmentsSection two-step save).
 */
import { useEffect, useState } from 'react';
import {
  listAdminAgents,
  createAgent,
  patchAgent,
  patchAgentConnectorAttachments,
  getAgentIdentity,
  putAgentIdentity,
  deleteAgent,
  listTeams,
  type AdminAgent,
  type AdminAgentInput,
} from '../../lib/admin';
import { listConnectors, getConnector, type ConnectorSummary, type ConnectorRouteBase } from '../../lib/connectors';
import { getOAuthStatus, type OAuthStatus } from '../../lib/connectors-oauth';

/** Sentinel for a status-fetch error (distinct from the API 'not-connected' value). */
const OAUTH_STATUS_ERROR = 'fetch-error' as const;
type OAuthStatusOrError = OAuthStatus | typeof OAUTH_STATUS_ERROR;
import { SkillAttachmentsSection } from './SkillAttachmentsSection';
import { AuthoredSkillsSection } from './AuthoredSkillsSection';
import { ConnectorOAuthConnect } from '../settings/ConnectorOAuthConnect';
import type { Team } from '../../../mock/admin/teams';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RoleCard } from './RoleCard';

const MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
];

type FormState = {
  displayName: string;
  visibility: 'personal' | 'team';
  teamId: string;
  /** The agent's `.ax/` identity files (TASK-142), replacing the old single
   *  "system prompt" field. `identity` ← IDENTITY.md, `soul` ← SOUL.md,
   *  `operating` ← the optional advanced AGENTS.md override. Loaded async on
   *  edit-open via getAgentIdentity; saved via putAgentIdentity. */
  identity: string;
  soul: string;
  operating: string;
  model: string;
  allowedTools: string;
  /** The connectors attached to this agent, by id. Saved to the first-class
   *  per-agent connector-attachment store (TASK-107) after the agent create/PATCH
   *  resolves — NOT written into `mcpConfigIds`. */
  connectorIds: string[];
};

const emptyForm = (): FormState => ({
  displayName: '',
  visibility: 'personal',
  teamId: '',
  identity: '',
  soul: '',
  operating: '',
  model: MODELS[0] ?? 'claude-sonnet-4-6',
  allowedTools: '',
  connectorIds: [],
});

const formFromAgent = (a: AdminAgent): FormState => ({
  displayName: a.displayName,
  visibility: a.visibility,
  teamId: a.visibility === 'team' ? a.ownerId : '',
  // Identity files are loaded separately (getAgentIdentity) once the form
  // opens — start blank and fill them in when the fetch resolves.
  identity: '',
  soul: '',
  operating: '',
  model: a.model || MODELS[0] || 'claude-sonnet-4-6',
  allowedTools: (a.allowedTools ?? []).join(', '),
  connectorIds: a.connectorAttachments ?? [],
});

const splitChips = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Read-only OAuth status hint for a personal agent's connector attachment.
 * The connection lives at user scope and is managed in the Connectors tab —
 * this is purely informational so an attached-but-unconnected connector is
 * legible. No connect button.
 */
function ConnectorOAuthStatusHint({
  status,
}: {
  status: OAuthStatusOrError | undefined;
}) {
  if (status === undefined) {
    return (
      <span className="text-xs text-muted-foreground">
        Checking connection…
      </span>
    );
  }
  if (status === OAUTH_STATUS_ERROR) {
    // M4 — a fetch failure must not be collapsed into "Not connected"
    // (design §8). Show a distinct muted note instead.
    return (
      <span className="text-xs text-muted-foreground">
        Couldn't check the connection.
      </span>
    );
  }
  if (status === 'connected') {
    return <Badge variant="secondary">Connected</Badge>;
  }
  if (status === 'needs-reconnect') {
    return (
      <span className="text-xs text-muted-foreground">
        Sign-in expired — reconnect in the Connectors tab.
      </span>
    );
  }
  // not-connected
  return (
    <span className="text-xs text-muted-foreground">
      Not connected yet — connect it in the Connectors tab.
    </span>
  );
}

export function AgentForm({ isAdmin }: { isAdmin: boolean }) {
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  // `null` = not yet loaded (radio disabled), `[]` = loaded but empty.
  // Distinguishing the two prevents writing an empty `teamId` if the
  // user toggles to `team` before `/admin/teams` resolves.
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [editing, setEditing] = useState<AdminAgent | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the agent's `.ax/` identity files are still loading (edit view).
  // The identity textareas are disabled until the fetch resolves so a save
  // can't race a half-loaded form and blank a file the user never saw.
  const [identityLoading, setIdentityLoading] = useState(false);
  // The agent awaiting delete confirmation (null = no dialog). Styled-confirm
  // pattern (TASK-117: project-wide styled Dialog) — no OS `window.confirm`.
  const [pendingDelete, setPendingDelete] = useState<AdminAgent | null>(null);
  // OAuth-capable connectors among those attached to the agent being edited.
  // Only populated when editing an existing agent (not 'new'). Keyed by
  // connector id; value carries the service name for the affordance label.
  const [oauthConnectors, setOauthConnectors] = useState<
    Map<string, { serviceName: string }>
  >(new Map());
  // Per-connector OAuth status for personal agents (read-only hint). Keyed by
  // connector id → the fetched OAuthStatus or the OAUTH_STATUS_ERROR sentinel
  // (undefined while loading).
  const [personalOauthStatus, setPersonalOauthStatus] = useState<
    Map<string, OAuthStatusOrError>
  >(new Map());

  const refresh = async () => {
    try {
      const list = await listAdminAgents();
      setAgents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Teams + connectors are only needed once the form actually opens — they
  // feed the team picker and the connector picker. Defer fetching until then
  // so the list view stays a single round-trip. Both lookups are best-effort:
  // if either fails or returns a shape we can't read, fall back to empty
  // arrays — the form still submits.
  useEffect(() => {
    if (editing === null) return;
    void listTeams()
      .then((t) => setTeams(t ?? []))
      .catch(() => setTeams([]));
    // A non-admin reads/writes their OWN connectors via /settings/connectors and
    // may only attach PERSONAL ones (their own key) — workspace/shared connectors
    // are admin-only to attach (the server enforces this; filtering the picker is
    // the friendly front for it). Admins curate via /admin/connectors and see all.
    void listConnectors(isAdmin ? '/admin/connectors' : '/settings/connectors')
      .then((c) => setConnectors((c ?? []).filter((conn) => isAdmin || conn.keyMode === 'personal')))
      .catch(() => setConnectors([]));
  }, [editing, isAdmin]);

  // TASK-142 — load the agent's `.ax/` identity files when editing an existing
  // agent. A new agent has no files yet (its workspace is seeded on first save),
  // so we skip the fetch for 'new'. The `cancelled` guard drops a stale resolve
  // if the user navigates away (or to another agent) before it lands, so we
  // never splice one agent's identity into another's form.
  useEffect(() => {
    if (editing === null || editing === 'new') return;
    const agentId = editing.id;
    let cancelled = false;
    setIdentityLoading(true);
    void getAgentIdentity(agentId)
      .then((files) => {
        if (cancelled) return;
        setForm((f) => ({
          ...f,
          identity: files.identity,
          soul: files.soul,
          operating: files.operating,
        }));
      })
      .catch(() => {
        // Best-effort: a load failure leaves the fields blank (editable). The
        // save still works — it just writes what's on screen.
      })
      .finally(() => {
        if (!cancelled) setIdentityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editing]);

  // For each attached connector, fetch the full record (which carries
  // capabilities.credentials) to determine which ones have an oauth slot.
  // Only runs when editing an existing agent — 'new' has no agent id and the
  // connector section still renders, but there's nothing to connect yet.
  // Uses a `cancelled` guard (same pattern as the identity effect above) so
  // a stale resolve from a previous agent doesn't bleed into the current one.
  const connectorBase: ConnectorRouteBase = isAdmin
    ? '/admin/connectors'
    : '/settings/connectors';
  useEffect(() => {
    if (editing === null || editing === 'new') {
      setOauthConnectors(new Map());
      setPersonalOauthStatus(new Map());
      return;
    }
    const agentId = editing.id;
    const attachedIds = form.connectorIds;
    if (attachedIds.length === 0) {
      setOauthConnectors(new Map());
      setPersonalOauthStatus(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      attachedIds.map((id) =>
        getConnector(id, connectorBase).catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const oauthMap = new Map<string, { serviceName: string }>();
      for (const connector of results) {
        // A null means the fetch threw; undefined means the server returned
        // a 200 without a `connector` field (best-effort parse gap). Either
        // way skip this connector — no oauth affordance is shown.
        if (connector === null || connector === undefined) continue;
        if (!connector.capabilities) continue;
        const hasOauth = connector.capabilities.credentials.some(
          (slot) => slot.kind === 'oauth',
        );
        if (hasOauth) {
          oauthMap.set(connector.id, { serviceName: connector.name });
        }
      }
      setOauthConnectors(oauthMap);
      // For personal agents, also fetch the OAuth status for each oauth
      // connector so the read-only hint can show the current state.
      if (form.visibility === 'personal' && oauthMap.size > 0) {
        void Promise.all(
          Array.from(oauthMap.keys()).map((cid) =>
            getOAuthStatus({ connectorId: cid, agentId }).catch(
              // M4 — use a distinct sentinel so fetch failures are not
              // reported as "Not connected" (design §8).
              (): OAuthStatusOrError => OAUTH_STATUS_ERROR,
            ),
          ),
        ).then((statuses) => {
          if (cancelled) return;
          const statusMap = new Map<string, OAuthStatusOrError>();
          Array.from(oauthMap.keys()).forEach((cid, i) => {
            const s = statuses[i];
            if (s !== undefined) statusMap.set(cid, s);
          });
          setPersonalOauthStatus(statusMap);
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [form.connectorIds, editing]);

  const startNew = () => {
    setError(null);
    setForm(emptyForm());
    setEditing('new');
  };

  const startEdit = (a: AdminAgent) => {
    setError(null);
    setForm(formFromAgent(a));
    setEditing(a);
  };

  const cancelForm = () => {
    setEditing(null);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!form.displayName.trim()) {
      setError('name is required');
      return;
    }
    if (form.visibility === 'team' && !form.teamId) {
      setError('team is required when visibility is team');
      return;
    }
    setBusy(true);
    setError(null);
    const allowedTools = splitChips(form.allowedTools);
    // TASK-107 — `mcpConfigIds` reverts to MCP-only meaning. Connectors are
    // saved to the first-class attachment store AFTER create/PATCH (below), not
    // here. The wildcard sentinel (`allowedTools=[] && mcpConfigIds=[]`) is
    // reserved for the dev-mode bypass and rejected by the admin API.
    const mcpConfigIds: string[] = [];
    // TASK-147 — a WILDCARD/BARE agent (persisted `allowedTools` empty AND no
    // mcp configs) is a legitimate, store-allowed state. Editing such an agent's
    // identity must NOT force the user to enumerate tools. So the tools-required
    // gate fires only when the save would CREATE a new wildcard agent or DEMOTE
    // a previously-tool-listed agent to wildcard — never on a bare-stays-bare
    // identity edit. (The standalone PUT /admin/agents/:id/identity route was
    // always ungated; this realigns the combined form with it — the TASK-143
    // walk GLITCH.)
    const editingExisting = editing !== null && editing !== 'new' ? editing : null;
    const wasBare =
      editingExisting !== null &&
      editingExisting.allowedTools.length === 0 &&
      editingExisting.mcpConfigIds.length === 0;
    // "Staying bare" — editing an already-bare agent without adding any tools.
    // This is the identity-only path the gate must let through.
    const bareStaysBare = wasBare && allowedTools.length === 0;
    if (allowedTools.length === 0 && !bareStaysBare) {
      setBusy(false);
      setError('agent must list at least one tool');
      return;
    }
    const base: AdminAgentInput = {
      displayName: form.displayName.trim(),
      model: form.model,
      allowedTools,
      mcpConfigIds,
      visibility: form.visibility,
      ...(form.visibility === 'team' ? { teamId: form.teamId } : {}),
    };
    try {
      // The agent id we attach connectors to: the freshly created id for a new
      // agent, or the edited agent's id.
      let agentId: string;
      if (editing === 'new') {
        const created = await createAgent(base);
        agentId = created.id;
      } else if (editing) {
        // PATCH cannot change visibility/teamId; send only fields the
        // backend accepts on update.
        const patch: Partial<AdminAgentInput> = {
          displayName: base.displayName,
          model: base.model,
        };
        // TASK-147 — on a bare-stays-bare edit, OMIT the tool fields entirely.
        // The server's wildcard guard rejects a PATCH that sends BOTH
        // `allowedTools: []` AND `mcpConfigIds: []`; omitting them leaves the
        // agent's existing (empty) tool scope untouched so the identity save can
        // proceed. For every other edit we send the tool fields as usual.
        if (!bareStaysBare) {
          patch.allowedTools = base.allowedTools;
          patch.mcpConfigIds = base.mcpConfigIds;
        }
        await patchAgent(editing.id, patch);
        agentId = editing.id;
      } else {
        // Unreachable (form view requires editing !== null), but keeps the
        // type-narrowing honest.
        setBusy(false);
        return;
      }
      // TASK-107 — save the connector attachments to the first-class store. A
      // separate PATCH so the agent id exists (new agents are created first).
      await patchAgentConnectorAttachments(agentId, form.connectorIds);
      // TASK-142 — save the agent's `.ax/` identity files (IDENTITY.md /
      // SOUL.md / AGENTS.md) through workspace:apply (→ validator-identity). A
      // separate PUT after the agent exists (new agents are created first, like
      // the connector save). The server creates AGENTS.md only when `operating`
      // is non-empty.
      await putAgentIdentity(agentId, {
        identity: form.identity,
        soul: form.soul,
        operating: form.operating,
      });
      await refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteAgent(pendingDelete.id);
      await refresh();
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
    }
  };

  // ── List view ──────────────────────────────────────────────────────────
  if (editing === null) {
    return (
      <div className="max-w-[640px] mx-auto font-sans">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
              Agents
            </h2>
            <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
              Define the agents available across this deployment.
            </p>
          </div>
          <Button onClick={startNew}>New agent</Button>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 px-3 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {error}
          </div>
        )}

        {agents.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No agents yet. Make one.
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {agents.map((a) => (
              <RoleCard
                key={a.id}
                pill="agent"
                title={a.displayName}
                caption={`${a.visibility} · ${a.ownerId} · ${a.model || '—'}`}
              >
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startEdit(a)}
                  >
                    edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(a)}
                  >
                    delete
                  </Button>
                </div>
              </RoleCard>
            ))}
          </div>
        )}

        {/* Delete confirmation dialog (styled — no OS confirm). */}
        {pendingDelete !== null && (
          <Dialog
            open={true}
            onOpenChange={(v) => {
              if (!v) setPendingDelete(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete agent?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                Delete{' '}
                <span className="font-medium text-foreground">
                  {pendingDelete.displayName}
                </span>
                ? This cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setPendingDelete(null)}
                >
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => void confirmDelete()}>
                  Delete
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    );
  }

  // ── Create / edit form view ────────────────────────────────────────────
  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={cancelForm}>
          ← Back
        </Button>
        <h2 className="text-2xl font-medium tracking-[-0.018em]">
          {editing === 'new' ? 'New agent' : `Edit ${form.displayName}`}
        </h2>
      </div>

      <Card className="p-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => void submit(e)}
        >
          {/* Name */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={form.displayName}
              onChange={(e) =>
                setForm((f) => ({ ...f, displayName: e.target.value }))
              }
              required
            />
          </div>

          {/* Visibility */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium leading-none">
              Visibility
            </span>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="visibility"
                  value="personal"
                  checked={form.visibility === 'personal'}
                  disabled={editing !== 'new'}
                  onChange={() =>
                    setForm((f) => ({
                      ...f,
                      visibility: 'personal',
                      teamId: '',
                    }))
                  }
                />
                personal
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="visibility"
                  value="team"
                  checked={form.visibility === 'team'}
                  // Disable until teams are loaded — flipping to `team`
                  // before then would write an empty teamId and the
                  // server would reject the submit. Also disabled for
                  // edits: the backend rejects visibility changes.
                  disabled={editing !== 'new' || teams === null}
                  onChange={() =>
                    setForm((f) => ({
                      ...f,
                      visibility: 'team',
                      teamId: teams?.[0]?.id ?? '',
                    }))
                  }
                />
                team
                {editing === 'new' && teams === null && (
                  <span className="text-xs text-muted-foreground ml-1">
                    (loading teams…)
                  </span>
                )}
              </label>
            </div>
          </div>

          {/* Team picker (conditional) */}
          {form.visibility === 'team' && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent-team">Team</Label>
              <select
                id="agent-team"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={form.teamId}
                disabled={editing !== 'new'}
                onChange={(e) =>
                  setForm((f) => ({ ...f, teamId: e.target.value }))
                }
              >
                {(teams ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Model */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-model">Model</Label>
            <select
              id="agent-model"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              value={form.model}
              onChange={(e) =>
                setForm((f) => ({ ...f, model: e.target.value }))
              }
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* Identity files (TASK-142). The agent's identity lives in its
              `.ax/` files, not a single "system prompt" string. Identity ←
              IDENTITY.md, Soul ← SOUL.md, Operating instructions (advanced) ←
              the optional AGENTS.md override. */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-identity">Identity</Label>
            <Textarea
              id="agent-identity"
              rows={4}
              placeholder="Who this agent is — name, what it is, how it presents itself."
              value={form.identity}
              disabled={editing !== 'new' && identityLoading}
              onChange={(e) =>
                setForm((f) => ({ ...f, identity: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              {editing !== 'new' && identityLoading
                ? 'Loading the agent’s identity files…'
                : 'Saved to the agent’s .ax/IDENTITY.md.'}
            </p>
          </div>

          {/* Soul */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-soul">Soul</Label>
            <Textarea
              id="agent-soul"
              rows={5}
              placeholder="This agent’s values, voice, and the boundaries it holds."
              value={form.soul}
              disabled={editing !== 'new' && identityLoading}
              onChange={(e) =>
                setForm((f) => ({ ...f, soul: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Saved to the agent’s .ax/SOUL.md.
            </p>
          </div>

          {/* Operating instructions — advanced, optional → .ax/AGENTS.md. */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-operating">
              Operating instructions{' '}
              <span className="font-normal text-muted-foreground">
                (advanced, optional)
              </span>
            </Label>
            <Textarea
              id="agent-operating"
              rows={4}
              placeholder="Default behaviors and house rules that override how this agent operates. Leave blank for none."
              value={form.operating}
              disabled={editing !== 'new' && identityLoading}
              onChange={(e) =>
                setForm((f) => ({ ...f, operating: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Only created when you enter something here (the agent’s
              .ax/AGENTS.md). The fixed safety floor always applies and can’t be
              overridden.
            </p>
          </div>

          {/* Allowed tools */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-tools">Allowed tools</Label>
            <Input
              id="agent-tools"
              placeholder="e.g. Bash, Read, Write, Edit, artifact_publish"
              value={form.allowedTools}
              onChange={(e) =>
                setForm((f) => ({ ...f, allowedTools: e.target.value }))
              }
            />
          </div>

          {/* Connectors — attach the services this agent can reach. */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium leading-none">Connectors</span>
            {connectors.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No connectors yet. Create one under Connectors, then attach it
                here.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
                {connectors.map((c) => {
                  const checked = form.connectorIds.includes(c.id);
                  const oauthEntry = oauthConnectors.get(c.id);
                  const isOauth = checked && oauthEntry !== undefined;
                  const isExistingAgent =
                    editing !== null && editing !== 'new';
                  return (
                    <div key={c.id} className="flex flex-col gap-2">
                      <label className="flex items-center gap-2.5 text-sm cursor-pointer">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) =>
                            setForm((f) => ({
                              ...f,
                              connectorIds:
                                v === true
                                  ? [...f.connectorIds, c.id]
                                  : f.connectorIds.filter((id) => id !== c.id),
                            }))
                          }
                          aria-label={`Attach ${c.name}`}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="font-medium">{c.name}</span>
                          {c.description && (
                            <span className="text-muted-foreground">
                              {' '}
                              — {c.description}
                            </span>
                          )}
                        </span>
                      </label>

                      {/* OAuth affordances — only for attached oauth connectors
                          on an existing agent (not 'new'; the agent id must
                          exist before a connection can be stored). */}
                      {isOauth && isExistingAgent && (
                        <div className="ml-7">
                          {form.visibility === 'team' ? (
                            /* Team agent: one-time connect via ConnectorOAuthConnect.
                               This is the ONLY place a team-agent connection can be set
                               up — it needs the specific agent id in context. */
                            <ConnectorOAuthConnect
                              connectorId={c.id}
                              serviceName={oauthEntry.serviceName}
                              agentId={editing.id}
                              requiresConsent
                            />
                          ) : (
                            /* Personal agent: read-only status hint. The connection
                               is user-level, managed in the Connectors tab. No
                               connect button here. */
                            <ConnectorOAuthStatusHint
                              status={personalOauthStatus.get(c.id)}
                            />
                          )}
                        </div>
                      )}

                      {/* "Save first" note for new agents with oauth connectors
                          (no agent id yet, so we can't connect). */}
                      {isOauth && !isExistingAgent && (
                        <p className="ml-7 text-xs text-muted-foreground">
                          Save this agent first — then you can connect right here.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="px-2.5 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive"
            >
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!!busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={cancelForm}
              disabled={!!busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Card>

      {/* Skill attachments — only available when editing an existing agent.
          New agents get their skill-attachment section after first save. */}
      {editing !== 'new' && (
        <Card className="p-5 mt-4">
          <SkillAttachmentsSection
            agentId={editing.id}
            initialAttachments={editing.skillAttachments ?? []}
            isAdmin={isAdmin}
            onSaved={(next) => {
              // Functional updater + identity guard: if the user has
              // navigated to a different agent (or to 'new') by the time
              // the save resolves, don't reopen the stale edit view.
              setEditing((current) => {
                if (current === 'new' || current === null) return current;
                if (current.id !== editing.id) return current;
                return { ...current, skillAttachments: next };
              });
            }}
          />
        </Card>
      )}

      {/* Authored skills — the agent's model-proposed skill DRAFTS + approval.
          A distinct capability-grant flow whose routes stay admin-only for now
          (its owner-scoped opening is a tracked follow-up), so it's hidden for
          non-admins. Only meaningful once the agent exists. */}
      {editing !== 'new' && isAdmin && (
        <div className="mt-4">
          <AuthoredSkillsSection agentId={editing.id} />
        </div>
      )}
    </div>
  );
}

