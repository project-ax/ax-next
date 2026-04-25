/**
 * McpServerForm — admin CRUD for MCP servers (Task 23).
 *
 * Mirrors AgentForm's list+form shape:
 *
 *   - List view: every MCP server, with Test, edit, and delete buttons
 *     per row, and "+ New MCP server" at the top.
 *   - Form view: opens for "+ New MCP server" or "edit". Submit POSTs
 *     (new) or PATCHes (edit), then re-fetches the list.
 *
 * The Test button is the only thing this form has that AgentForm doesn't.
 * It calls `POST /api/admin/mcp-servers/:id/test` and renders the result
 * inline next to the button:
 *
 *   - "ok"          — green badge, request returned `{ ok: true }`.
 *   - "error: …"    — red badge, request failed or returned `{ ok: false }`.
 *   - "testing…"    — yellow badge while the round-trip is in flight.
 *
 * Test status is stored per-row in a `Record<id, status>` map so multiple
 * rows can be tested independently without one clobbering another's badge.
 */
import { useEffect, useState } from 'react';
import {
  listMcpServers,
  createMcpServer,
  patchMcpServer,
  deleteMcpServer,
  testMcpServer,
} from '../../lib/admin';
import type { McpServerInput } from '../../lib/admin';
import type { McpServer } from '../../../mock/admin/mcp-servers';

const TRANSPORTS: McpServerInput['transport'][] = ['http', 'stdio', 'sse'];

type FormState = {
  name: string;
  url: string;
  transport: McpServerInput['transport'];
  credentials_id: string;
};

const emptyForm = (): FormState => ({
  name: '',
  url: '',
  transport: 'http',
  credentials_id: '',
});

const formFromServer = (s: McpServer): FormState => ({
  name: s.name,
  url: s.url,
  transport: s.transport,
  credentials_id: s.credentials_id ?? '',
});

type TestStatus = 'idle' | 'testing' | 'ok' | string;

export function McpServerForm() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, TestStatus>>({});

  const refresh = async () => {
    try {
      const list = await listMcpServers();
      setServers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startNew = () => {
    setError(null);
    setForm(emptyForm());
    setEditing('new');
  };

  const startEdit = (s: McpServer) => {
    setError(null);
    setForm(formFromServer(s));
    setEditing(s);
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
    if (!form.url.trim()) {
      setError('url is required');
      return;
    }
    setBusy(true);
    setError(null);
    const payload: McpServerInput = {
      name: form.name.trim(),
      url: form.url.trim(),
      transport: form.transport,
      ...(form.credentials_id.trim()
        ? { credentials_id: form.credentials_id.trim() }
        : {}),
    };
    try {
      if (editing === 'new') {
        await createMcpServer(payload);
      } else if (editing) {
        await patchMcpServer(editing.id, payload);
      }
      await refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: McpServer) => {
    if (!confirm(`Delete MCP server "${s.name}"?`)) return;
    try {
      await deleteMcpServer(s.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onTest = async (id: string) => {
    setTestStatus((prev) => ({ ...prev, [id]: 'testing' }));
    // `testMcpServer` is documented as not-throwing — it folds errors
    // into `{ ok: false, error }`. The try/catch here is defensive: if a
    // future refactor (or a programmer error in the helper) ever lets a
    // throw escape, the badge would otherwise stay stuck on "testing…"
    // forever.
    try {
      const result = await testMcpServer(id);
      setTestStatus((prev) => ({
        ...prev,
        [id]: result.ok ? 'ok' : `error: ${result.error ?? 'failed'}`,
      }));
    } catch (err) {
      setTestStatus((prev) => ({
        ...prev,
        [id]: `error: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  };

  const renderBadge = (status: TestStatus | undefined) => {
    if (!status || status === 'idle') return null;
    if (status === 'testing') {
      return <span className="admin-badge admin-badge-pending">testing…</span>;
    }
    if (status === 'ok') {
      return <span className="admin-badge admin-badge-ok">ok</span>;
    }
    return <span className="admin-badge admin-badge-error">{status}</span>;
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
              + New MCP server
            </button>
          </div>
          {servers.length === 0 ? (
            <div className="admin-empty">No MCP servers yet.</div>
          ) : (
            <ul className="admin-list">
              {servers.map((s) => (
                <li key={s.id} className="admin-list-row">
                  <div className="admin-list-text">
                    <div className="admin-list-name">{s.name}</div>
                    <div className="admin-list-meta">
                      {s.transport} · {s.url}
                    </div>
                  </div>
                  <div className="admin-list-actions">
                    {renderBadge(testStatus[s.id])}
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => void onTest(s.id)}
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => startEdit(s)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="admin-btn admin-btn-danger"
                      onClick={() => void remove(s)}
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
            <label htmlFor="mcp-name">Name</label>
            <input
              id="mcp-name"
              type="text"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              required
            />

            <label htmlFor="mcp-url">URL</label>
            <input
              id="mcp-url"
              type="text"
              value={form.url}
              onChange={(e) =>
                setForm((f) => ({ ...f, url: e.target.value }))
              }
              required
            />

            <label htmlFor="mcp-transport">Transport</label>
            <select
              id="mcp-transport"
              value={form.transport}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  transport: e.target.value as McpServerInput['transport'],
                }))
              }
            >
              {TRANSPORTS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            <label htmlFor="mcp-credentials">Credentials ID</label>
            <input
              id="mcp-credentials"
              type="text"
              placeholder="optional"
              value={form.credentials_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, credentials_id: e.target.value }))
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
