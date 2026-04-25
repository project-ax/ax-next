/**
 * AgentForm — admin CRUD for agents (Task 22).
 *
 * Two states share the same component:
 *
 *   - List view: every agent on the system, with edit + delete buttons
 *     per row, and a "+ New agent" button at the top.
 *   - Form view: opens for "+ New agent" or "edit". Submit POSTs (new)
 *     or PATCHes (edit) and re-fetches the list on success.
 *
 * Owner picker — `owner_type` (user/team) toggles the `owner_id`
 * dropdown source. The teams list comes from `/api/admin/teams`.
 * Users come from a hardcoded `[u1, u2]` shim because there's no
 * `/api/users` endpoint yet — the mock seed only knows admin/alice.
 * When a real user-list endpoint shows up (post-MVP), swap the
 * `KNOWN_USERS` constant for a fetch.
 *
 * The chip inputs (`allowed_tools`, `mcp_config_ids`) are deliberately
 * dumb comma-separated text fields. A drag-reorder multiselect with
 * server-side completion is on the deferred polish list — the design
 * handoff treats these as low-traffic admin paths.
 */
import { useEffect, useState } from 'react';
import {
  listAdminAgents,
  createAgent,
  patchAgent,
  deleteAgent,
  listMcpServers,
  listTeams,
} from '../../lib/admin';
import type { Agent, AgentInput } from '../../../mock/agents';
import type { Team } from '../../../mock/admin/teams';
import type { McpServer } from '../../../mock/admin/mcp-servers';

// Hardcoded users until a `/api/users` endpoint exists. Mirrors
// `mock/seed.ts`. TODO(post-MVP): wire to a real user directory.
const KNOWN_USERS: { id: string; name: string }[] = [
  { id: 'u1', name: 'Admin (admin@local)' },
  { id: 'u2', name: 'Alice (alice@local)' },
];

const MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
];

type FormState = {
  name: string;
  desc: string;
  color: string;
  tag: string;
  owner_type: 'user' | 'team';
  owner_id: string;
  system_prompt: string;
  model: string;
  allowed_tools: string;
  mcp_config_ids: string;
};

const emptyForm = (): FormState => ({
  name: '',
  desc: '',
  color: '#7aa6c9',
  tag: '',
  owner_type: 'user',
  owner_id: KNOWN_USERS[0]?.id ?? '',
  system_prompt: '',
  model: MODELS[0] ?? 'claude-sonnet-4-6',
  allowed_tools: '',
  mcp_config_ids: '',
});

const formFromAgent = (a: Agent): FormState => ({
  name: a.name,
  desc: a.desc,
  color: a.color || '#7aa6c9',
  tag: a.tag,
  owner_type: a.owner_type,
  owner_id: a.owner_id,
  system_prompt: a.system_prompt,
  model: a.model || MODELS[0] || 'claude-sonnet-4-6',
  allowed_tools: a.allowed_tools.join(', '),
  mcp_config_ids: a.mcp_config_ids.join(', '),
});

const splitChips = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function AgentForm() {
  const [agents, setAgents] = useState<Agent[]>([]);
  // `null` = not yet loaded (radio disabled), `[]` = loaded but empty.
  // Distinguishing the two prevents writing an empty `owner_id` if the
  // user toggles to `team` before `/api/admin/teams` resolves.
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [editing, setEditing] = useState<Agent | 'new' | null>(null);
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
  // they feed the owner dropdown and the chip placeholder. Defer fetching
  // until then so the list view stays a single round-trip. Both lookups
  // are best-effort: if either fails or returns a shape we can't read,
  // fall back to empty arrays — the form still submits.
  useEffect(() => {
    if (editing === null) return;
    void listTeams()
      .then((t) => setTeams(t ?? []))
      .catch(() => {});
    void listMcpServers()
      .then((m) => setMcps(m ?? []))
      .catch(() => {});
  }, [editing]);

  const startNew = () => {
    setError(null);
    setForm(emptyForm());
    setEditing('new');
  };

  const startEdit = (a: Agent) => {
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
    if (!form.name.trim()) {
      setError('name is required');
      return;
    }
    setBusy(true);
    setError(null);
    const payload: AgentInput = {
      name: form.name.trim(),
      desc: form.desc,
      color: form.color || '#7aa6c9',
      tag: form.tag,
      owner_type: form.owner_type,
      owner_id: form.owner_id,
      system_prompt: form.system_prompt,
      model: form.model,
      allowed_tools: splitChips(form.allowed_tools),
      mcp_config_ids: splitChips(form.mcp_config_ids),
    };
    try {
      if (editing === 'new') {
        await createAgent(payload);
      } else if (editing) {
        await patchAgent(editing.id, payload);
      }
      await refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Agent) => {
    // `confirm()` is fine for the mock — the design has us using inline
    // confirm rows like the session list, but that's deferred polish.
    if (!confirm(`Delete agent "${a.name}"?`)) return;
    try {
      await deleteAgent(a.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const ownerOptions =
    form.owner_type === 'team'
      ? (teams ?? []).map((t) => ({ id: t.id, name: t.name }))
      : KNOWN_USERS;

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
                    style={{ background: a.color || '#7aa6c9' }}
                    aria-hidden="true"
                  />
                  <div className="admin-list-text">
                    <div className="admin-list-name">{a.name}</div>
                    <div className="admin-list-meta">
                      {a.owner_type} · {a.owner_id} · {a.model || '—'}
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
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              required
            />

            <label htmlFor="agent-desc">Description</label>
            <input
              id="agent-desc"
              type="text"
              value={form.desc}
              onChange={(e) =>
                setForm((f) => ({ ...f, desc: e.target.value }))
              }
            />

            <label htmlFor="agent-color">Color</label>
            <input
              id="agent-color"
              type="color"
              value={form.color}
              onChange={(e) =>
                setForm((f) => ({ ...f, color: e.target.value }))
              }
            />

            <label htmlFor="agent-tag">Tag</label>
            <input
              id="agent-tag"
              type="text"
              value={form.tag}
              onChange={(e) => setForm((f) => ({ ...f, tag: e.target.value }))}
            />

            <span className="admin-form-label">Owner type</span>
            <div className="admin-form-radios">
              <label>
                <input
                  type="radio"
                  name="owner_type"
                  value="user"
                  checked={form.owner_type === 'user'}
                  onChange={() =>
                    setForm((f) => ({
                      ...f,
                      owner_type: 'user',
                      owner_id: KNOWN_USERS[0]?.id ?? '',
                    }))
                  }
                />{' '}
                user
              </label>
              <label>
                <input
                  type="radio"
                  name="owner_type"
                  value="team"
                  checked={form.owner_type === 'team'}
                  // Disable until teams are loaded — flipping to `team`
                  // before then would write an empty owner_id and the
                  // server would reject the submit.
                  disabled={teams === null}
                  onChange={() =>
                    setForm((f) => ({
                      ...f,
                      owner_type: 'team',
                      owner_id: teams?.[0]?.id ?? '',
                    }))
                  }
                />{' '}
                team
                {teams === null && (
                  <span className="form-hint"> (loading teams…)</span>
                )}
              </label>
            </div>

            <label htmlFor="agent-owner">Owner</label>
            <select
              id="agent-owner"
              value={form.owner_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, owner_id: e.target.value }))
              }
            >
              {ownerOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>

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
              value={form.system_prompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, system_prompt: e.target.value }))
              }
            />

            <label htmlFor="agent-tools">Allowed tools</label>
            <input
              id="agent-tools"
              type="text"
              placeholder="comma, separated, names"
              value={form.allowed_tools}
              onChange={(e) =>
                setForm((f) => ({ ...f, allowed_tools: e.target.value }))
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
              value={form.mcp_config_ids}
              onChange={(e) =>
                setForm((f) => ({ ...f, mcp_config_ids: e.target.value }))
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
