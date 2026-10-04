import { movedNotice } from '@/lib/models-copy';
/**
 * AgentForm — CRUD for agents, in the user "Settings" surface. Agents are
 * owner-scoped, so EVERY user manages their OWN agents here (the `/admin/agents`
 * routes are requireUser + owner-scoped, not admin-gated). `isAdmin` gates the
 * admin-only bits: the authored-skill drafts section is admin-only for now.
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
 * `/admin/teams`. `allowedTools` stays a dumb comma-separated text field.
 * Connectors are NOT assigned here (TASK-799) — people add them from the
 * workspace rail.
 */
import { useEffect, useRef, useState } from 'react';
import {
  listAdminAgents,
  listAgentModelOptions,
  getAdminAgent,
  createAgent,
  patchAgent,
  getAgentIdentity,
  putAgentIdentity,
  deleteAgent,
  listTeams,
  type AdminAgent,
  type AdminAgentInput,
  type AgentModelOption,
  type Team,
} from '../../lib/admin';
import { SkillAttachmentsSection } from './SkillAttachmentsSection';
import { AuthoredSkillsSection } from './AuthoredSkillsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RoleCard } from './RoleCard';

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
};

const emptyForm = (): FormState => ({
  displayName: '',
  visibility: 'personal',
  teamId: '',
  identity: '',
  soul: '',
  operating: '',
  // Empty until GET /admin/agents/models resolves — this deployment's
  // allow-list decides what a valid model is, not a constant in the SPA.
  model: '',
  allowedTools: '',
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
  model: a.model,
  allowedTools: (a.allowedTools ?? []).join(', '),
});

const splitChips = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * The model a freshly-opened picker is EFFECTIVELY showing: the user's explicit
 * choice when they have one, else the first available option.
 *
 * This exists as a derivation rather than as state back-filled by an effect,
 * and that distinction is the whole of bug #401. A `<select>` whose `value`
 * matches no `<option>` displays its FIRST option, so binding
 * `value={form.model}` while `form.model` was still `''` made the picker show a
 * model the form had not actually selected. An effect filled `form.model` one
 * commit later — and anyone who submitted inside that window got "no model is
 * available to assign" while the dropdown plainly showed one. Measured at 3
 * failures in 30 runs of the admin-agents suite; 0 in 40 after this change.
 *
 * Deriving closes the window structurally instead of narrowing it: the value
 * the picker renders and the value `submit` sends are the same call in the same
 * render, so they cannot disagree at any instant. Exported so that rule can be
 * pinned directly, without racing an effect to observe it.
 */
export function effectiveModelId(
  formModel: string,
  options: ReadonlyArray<{ id: string }>,
  defaultModel: string | null = null,
): string {
  if (formModel !== '') return formModel;
  if (defaultModel !== null && options.some((o) => o.id === defaultModel)) return defaultModel;
  return options[0]?.id ?? '';
}


/**
 * (TASK-341 / audit D1) What one agent's card says under its name.
 *
 * It used to be `${a.visibility} · ${a.ownerId} · ${a.model}` — a lowercase
 * enum, a raw database id and a provider model ref, on the card an admin scans
 * to find the agent they want. The owner id is the worst of the three:
 * `usr_abc123` identifies the row to the machine and to nobody else.
 *
 * What a person actually needs is who can see it, whose it is when that is a
 * team, and which model it runs.
 *
 * The model label comes from the loaded option list — the same labels the
 * picker shows, so the card and the form can never disagree. While that list is
 * still in flight we say NOTHING rather than fall back to the raw ref: a
 * caption is a summary, the edit form carries the exact value, and printing
 * `anthropic/claude-sonnet-4-6` here is the thing this finding is about.
 */
export function agentCaption(
  a: Pick<AdminAgent, 'visibility' | 'ownerId' | 'model'>,
  teams: Team[] | null,
  models: AgentModelOption[] | null,
): string {
  const parts: string[] = [a.visibility === 'team' ? 'Team' : 'Personal'];
  if (a.visibility === 'team') {
    // A team id says nothing; the team's NAME is the entire point of the row.
    const name = teams?.find((t) => t.id === a.ownerId)?.displayName;
    if (name !== undefined && name.length > 0) parts.push(name);
  }
  const label = models?.find((m) => m.id === a.model)?.label;
  if (label !== undefined && label.length > 0) parts.push(label);
  return parts.join(' · ');
}

export function AgentForm({ isAdmin }: { isAdmin: boolean }) {
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  // `null` = not yet loaded (radio disabled), `[]` = loaded but empty.
  // Distinguishing the two prevents writing an empty `teamId` if the
  // user toggles to `team` before `/admin/teams` resolves.
  const [teams, setTeams] = useState<Team[] | null>(null);
  // The selectable models for this deployment, from GET /admin/agents/models
  // — the operator's agents allow-list, labelled by whichever
  // `models:list-supported:<provider>` registrants are loaded (an allow-listed
  // ref whose provider has no registrant still appears, labelled with its own
  // id). `null` = not loaded yet, `[]` = loaded and genuinely empty (an empty
  // allow-list), which the form calls out instead of showing a blank picker.
  const [models, setModels] = useState<AgentModelOption[] | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminAgent | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [busy, setBusy] = useState(false);
  const editRequest = useRef(0);
  useEffect(() => () => { editRequest.current += 1; }, []);
  const [error, setError] = useState<string | null>(null);
  // Whether the agent's `.ax/` identity files are still loading (edit view).
  // The identity textareas are disabled until the fetch resolves so a save
  // can't race a half-loaded form and blank a file the user never saw.
  const [identityLoading, setIdentityLoading] = useState(false);
  // The agent awaiting delete confirmation (null = no dialog). Styled-confirm
  // pattern (TASK-117: project-wide styled Dialog) — no OS `window.confirm`.
  const [pendingDelete, setPendingDelete] = useState<AdminAgent | null>(null);

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

  // Teams + models are only needed once the form actually opens — they feed
  // the team picker and the model picker. Defer fetching until then so the
  // list view stays a single round-trip. The teams lookup is best-effort: if it
  // fails or returns a shape we can't read, fall back to an empty array — the
  // form still submits.
  useEffect(() => {
    if (editing === null) return;
    void listTeams()
      .then((t) => setTeams(t ?? []))
      .catch(() => setTeams([]));
    // The model list is NOT best-effort-empty: an empty picker with no
    // explanation is how someone ends up staring at a form they can't submit.
    // A failure is surfaced in the form (see the Model field below).
    setModelsError(null);
    void listAgentModelOptions()
      .then(({ models: m, defaultModel: d }) => { setModels(m); setDefaultModel(d); })
      .catch((err: unknown) => {
        setModels([]);
        setModelsError(err instanceof Error ? err.message : String(err));
      });
  }, [editing]);

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

  const startNew = () => {
    editRequest.current += 1;
    setBusy(false);
    setError(null);
    setForm(emptyForm());
    setEditing('new');
  };

  const startEdit = async (a: AdminAgent) => {
    const request = ++editRequest.current;
    setError(null);
    setBusy(true);
    try {
      const resolved = await getAdminAgent(a.id);
      if (request !== editRequest.current) return;
      setForm(formFromAgent(resolved));
      setEditing(resolved);
    } catch (err) {
      if (request !== editRequest.current) return;
      setError('We could not load this agent. Try opening it again.');
      console.warn('could not read agent details', err);
    } finally {
      if (request === editRequest.current) setBusy(false);
    }
  };

  // What the picker renders: the fetched options, plus the agent's CURRENT
  // model when the list no longer carries it (allow-list changed, provider
  // swapped). Without that fallback a `<select>` whose value matches no option
  // renders blank and quietly implies a model the agent isn't using.
  const fetchedModels = models ?? [];
  const currentModelMissing =
    form.model !== '' && !fetchedModels.some((m) => m.id === form.model);
  const modelOptions: AgentModelOption[] = currentModelMissing
    ? [
        ...fetchedModels,
        { id: form.model, label: `${form.model} (not available)`, kind: 'either' },
      ]
    : fetchedModels;

  const selectedModel = effectiveModelId(form.model, modelOptions, defaultModel);

  const cancelForm = () => {
    editRequest.current += 1;
    setBusy(false);
    setEditing(null);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!form.displayName.trim()) {
      setError('Give the agent a name.');
      return;
    }
    if (form.visibility === 'team' && !form.teamId) {
      setError('Pick the team this agent belongs to.');
      return;
    }
    setBusy(true);
    setError(null);
    const allowedTools = splitChips(form.allowedTools);
    // `mcpConfigIds` carries MCP configs only; connectors are added from the
    // workspace rail, not this form (TASK-799). The wildcard sentinel
    // (`allowedTools=[] && mcpConfigIds=[]`) is reserved for the dev-mode bypass
    // and rejected by the admin API.
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
      setError('Pick at least one tool this agent may use — e.g. Bash, Read, Write.');
      return;
    }
    // The server rejects an empty/unknown model, so say why HERE rather than
    // shipping a blank one and surfacing a bare 400. Two distinct causes: the
    // list is still in flight, or this deployment genuinely has no models.
    // Gate on the DERIVED selection — the one the picker is actually showing —
    // so this error can never contradict the visible dropdown (#401).
    if (!selectedModel) {
      setBusy(false);
      setError(
        models === null
          ? 'We’re still loading the list of models. Give it a second and try again.'
          : 'No model is available to assign yet. Set up a model provider first.',
      );
      return;
    }
    const base: AdminAgentInput = {
      displayName: form.displayName.trim(),
      model: selectedModel,
      allowedTools,
      mcpConfigIds,
      visibility: form.visibility,
      ...(form.visibility === 'team' ? { teamId: form.teamId } : {}),
    };
    try {
      // The agent id the identity files are saved under: the freshly created id
      // for a new agent, or the edited agent's id.
      let agentId: string;
      if (editing === 'new') {
        const created = await createAgent(base);
        agentId = created.id;
      } else if (editing) {
        // PATCH cannot change visibility/teamId; send only fields the
        // backend accepts on update.
// `model` goes out ONLY if the user changed it. For an agent the admin moved
// onto the Default, `editing.model` is that Default; re-sending it would save
// the swap as the owner's own choice.
const patch: Partial<AdminAgentInput> = { displayName: base.displayName };
if (base.model !== editing.model) patch.model = base.model;

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
      // TASK-142 — save the agent's `.ax/` identity files (IDENTITY.md /
      // SOUL.md / AGENTS.md) through workspace:apply (→ validator-identity). A
      // separate PUT after the agent exists (new agents are created first). The
      // server creates AGENTS.md only when `operating` is non-empty.
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

        {/* (D2) Was a hand-rolled destructive div. `Alert` is installed, this
            file already imports it, and one of the two copies had different
            padding from the other — which is the whole argument for the
            primitive. */}
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
                caption={agentCaption(a, teams, models)}
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
              {/* TASK-718: say what goes with the agent. Every item named here
                  is really deleted (conversations and their attachments, the
                  agent's saved files, its routines) -- do not add a claim
                  without the code behind it, and do not promise anything is
                  kept. Data loss, so plain and direct: no jokes. */}
              <DialogDescription>
                Delete{' '}
                <span className="font-medium text-foreground">
                  {pendingDelete.displayName}
                </span>
                ? We will delete its conversations, the files in them, the files
                it saved and its routines along with it. This cannot be undone.
              </DialogDescription>
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
                    {t.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Model — the options are whatever THIS deployment allows
              (GET /admin/agents/models = the operator's agents allow-list,
              with labels from whichever `models:list-supported:<provider>`
              registrants are loaded), never a list baked into the SPA.
              Values are `provider/model-id` refs. */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-model">Model</Label>
            {editing !== null && editing !== 'new' && editing.requestedModel !== undefined && (
              <Alert><AlertDescription>{movedNotice(modelOptions.find((o) => o.id === editing.model)?.label ?? editing.model)}</AlertDescription></Alert>
            )}
            {models !== null && modelOptions.length === 0 ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {modelsError === null
                    ? 'No models are available yet. That usually means no model provider is configured — add a provider key on the Model config tab, then reopen this form.'
                    : `We couldn’t load the model list (${modelsError}). Close and reopen this form to try again.`}
                </AlertDescription>
              </Alert>
            ) : (
              <select
                id="agent-model"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={selectedModel}
                disabled={models === null}
                onChange={(e) =>
                  setForm((f) => ({ ...f, model: e.target.value }))
                }
              >
                {models === null ? (
                  <option value="">Loading models…</option>
                ) : (
                  modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            )}
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

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
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

