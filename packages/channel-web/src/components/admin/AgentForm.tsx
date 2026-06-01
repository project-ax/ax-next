/**
 * AgentForm — admin CRUD for agents.
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
  deleteAgent,
  listTeams,
  type AdminAgent,
  type AdminAgentInput,
} from '../../lib/admin';
import { listConnectors, type ConnectorSummary } from '../../lib/connectors';
import { SkillAttachmentsSection } from './SkillAttachmentsSection';
import { AuthoredSkillsSection } from './AuthoredSkillsSection';
import type { Team } from '../../../mock/admin/teams';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
  systemPrompt: string;
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
  systemPrompt: '',
  model: MODELS[0] ?? 'claude-sonnet-4-6',
  allowedTools: '',
  connectorIds: [],
});

const formFromAgent = (a: AdminAgent): FormState => ({
  displayName: a.displayName,
  visibility: a.visibility,
  teamId: a.visibility === 'team' ? a.ownerId : '',
  systemPrompt: a.systemPrompt,
  model: a.model || MODELS[0] || 'claude-sonnet-4-6',
  allowedTools: (a.allowedTools ?? []).join(', '),
  connectorIds: a.connectorAttachments ?? [],
});

const splitChips = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function AgentForm() {
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
    void listConnectors()
      .then((c) => setConnectors(c ?? []))
      .catch(() => setConnectors([]));
  }, [editing]);

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
    // reserved for the dev-mode bypass and rejected by the admin API, so the
    // form requires at least one explicit tool — connector attachments don't
    // participate (exactly like skill attachments).
    const mcpConfigIds: string[] = [];
    if (allowedTools.length === 0) {
      setBusy(false);
      setError('agent must list at least one tool');
      return;
    }
    const base: AdminAgentInput = {
      displayName: form.displayName.trim(),
      systemPrompt: form.systemPrompt,
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
          systemPrompt: base.systemPrompt,
          model: base.model,
          allowedTools: base.allowedTools,
          mcpConfigIds: base.mcpConfigIds,
        };
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
      await refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: AdminAgent) => {
    // `confirm()` is fine for the mock — the design has us using inline
    // confirm rows like the session list, but that's deferred polish.
    if (!confirm(`Delete agent "${a.displayName}"?`)) return;
    try {
      await deleteAgent(a.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
                    onClick={() => void remove(a)}
                  >
                    delete
                  </Button>
                </div>
              </RoleCard>
            ))}
          </div>
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

          {/* System prompt */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-system-prompt">System prompt</Label>
            <Textarea
              id="agent-system-prompt"
              rows={5}
              value={form.systemPrompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, systemPrompt: e.target.value }))
              }
            />
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
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-2.5 text-sm cursor-pointer"
                    >
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

      {/* Authored skills — skills the agent wrote in its workspace.
          Only meaningful once the agent exists and has a workspace. */}
      {editing !== 'new' && (
        <div className="mt-4">
          <AuthoredSkillsSection agentId={editing.id} />
        </div>
      )}
    </div>
  );
}

