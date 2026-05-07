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
 * `/admin/teams`. The chip inputs (`allowedTools`, `mcpConfigIds`) are
 * deliberately dumb comma-separated text fields. A drag-reorder
 * multiselect is on the deferred polish list — admin paths are
 * low-traffic.
 */
import { useEffect, useState } from 'react';
import {
  listAdminAgents,
  createAgent,
  patchAgent,
  deleteAgent,
  listMcpServers,
  listTeams,
  type AdminAgent,
  type AdminAgentInput,
} from '../../lib/admin';
import type { Team } from '../../../mock/admin/teams';
import type { McpServer } from '../../../mock/admin/mcp-servers';

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
  mcpConfigIds: string;
};

const emptyForm = (): FormState => ({
  displayName: '',
  visibility: 'personal',
  teamId: '',
  systemPrompt: '',
  model: MODELS[0] ?? 'claude-sonnet-4-6',
  allowedTools: '',
  mcpConfigIds: '',
});

const formFromAgent = (a: AdminAgent): FormState => ({
  displayName: a.displayName,
  visibility: a.visibility,
  teamId: a.visibility === 'team' ? a.ownerId : '',
  systemPrompt: a.systemPrompt,
  model: a.model || MODELS[0] || 'claude-sonnet-4-6',
  allowedTools: (a.allowedTools ?? []).join(', '),
  mcpConfigIds: (a.mcpConfigIds ?? []).join(', '),
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
  const [mcps, setMcps] = useState<McpServer[]>([]);
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

  // Teams + mcp servers are only needed once the form actually opens —
  // they feed the team picker and the chip placeholder. Defer fetching
  // until then so the list view stays a single round-trip. Both lookups
  // are best-effort: if either fails or returns a shape we can't read,
  // fall back to empty arrays — the form still submits.
  useEffect(() => {
    if (editing === null) return;
    void listTeams()
      .then((t) => setTeams(t ?? []))
      .catch(() => setTeams([]));
    void listMcpServers()
      .then((m) => setMcps(m ?? []))
      .catch(() => setMcps([]));
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
    const mcpConfigIds = splitChips(form.mcpConfigIds);
    if (allowedTools.length === 0 && mcpConfigIds.length === 0) {
      setBusy(false);
      setError('agent must list at least one tool or one MCP config');
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
      if (editing === 'new') {
        await createAgent(base);
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
      }
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

  return (
    <div className="admin-form-wrap">
      {error && <div className="admin-error">{error}</div>}

      {editing === null ? (
        <>
          <div className="admin-list-toolbar">
            <button
              type="button"
              className="admin-btn admin-btn-primary"
              onClick={startNew}
            >
              + New agent
            </button>
          </div>
          {agents.length === 0 ? (
            <div className="admin-empty">No agents yet. Make one.</div>
          ) : (
            <ul className="admin-list">
              {agents.map((a) => (
                <li key={a.id} className="admin-list-row">
                  <span
                    className="admin-list-swatch"
                    style={{ background: agentColorFor(a.id) }}
                    aria-hidden="true"
                  />
                  <div className="admin-list-text">
                    <div className="admin-list-name">{a.displayName}</div>
                    <div className="admin-list-meta">
                      {a.visibility} · {a.ownerId} · {a.model || '—'}
                    </div>
                  </div>
                  <div className="admin-list-actions">
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => startEdit(a)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="admin-btn admin-btn-danger"
                      onClick={() => void remove(a)}
                    >
                      delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <form className="admin-form" onSubmit={(e) => void submit(e)}>
          <div className="admin-form-grid">
            <label htmlFor="agent-name">Name</label>
            <input
              id="agent-name"
              type="text"
              value={form.displayName}
              onChange={(e) =>
                setForm((f) => ({ ...f, displayName: e.target.value }))
              }
              required
            />

            <span className="admin-form-label">Visibility</span>
            <div className="admin-form-radios">
              <label>
                <input
                  type="radio"
                  name="visibility"
                  value="personal"
                  checked={form.visibility === 'personal'}
                  disabled={editing !== 'new'}
                  onChange={() =>
                    setForm((f) => ({ ...f, visibility: 'personal', teamId: '' }))
                  }
                />{' '}
                personal
              </label>
              <label>
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
                />{' '}
                team
                {editing === 'new' && teams === null && (
                  <span className="form-hint"> (loading teams…)</span>
                )}
              </label>
            </div>

            {form.visibility === 'team' && (
              <>
                <label htmlFor="agent-team">Team</label>
                <select
                  id="agent-team"
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
              </>
            )}

            <label htmlFor="agent-model">Model</label>
            <select
              id="agent-model"
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

            <label htmlFor="agent-system-prompt">System prompt</label>
            <textarea
              id="agent-system-prompt"
              rows={5}
              value={form.systemPrompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, systemPrompt: e.target.value }))
              }
            />

            <label htmlFor="agent-tools">Allowed tools</label>
            <input
              id="agent-tools"
              type="text"
              placeholder="comma, separated, names"
              value={form.allowedTools}
              onChange={(e) =>
                setForm((f) => ({ ...f, allowedTools: e.target.value }))
              }
            />

            <label htmlFor="agent-mcps">MCP servers</label>
            <input
              id="agent-mcps"
              type="text"
              placeholder={
                mcps.length
                  ? `e.g. ${mcps
                      .slice(0, 2)
                      .map((m) => m.id)
                      .join(', ')}`
                  : 'comma-separated server IDs'
              }
              value={form.mcpConfigIds}
              onChange={(e) =>
                setForm((f) => ({ ...f, mcpConfigIds: e.target.value }))
              }
            />
          </div>

          <div className="admin-form-buttons">
            <button
              type="button"
              className="admin-btn"
              onClick={cancelForm}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="admin-btn admin-btn-primary"
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// Stable per-agent color from a small palette. The wire doesn't carry
// a per-agent color, so we derive one from the id so the list looks
// consistent across reloads. Same shape as `AgentChip.agentColorFor`.
function agentColorFor(agentId: string): string {
  const palette = ['#7aa6c9', '#b08968', '#9c89b8', '#90a955', '#d4a373', '#9b5de5'];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? '#888';
}
