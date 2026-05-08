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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { RoleCard } from './RoleCard';
import { StatusDot } from './StatusDot';

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

const testStatusToVariant = (
  status: TestStatus | undefined,
): 'empty' | 'ok' | 'bad' | 'pending' => {
  if (!status || status === 'idle') return 'empty';
  if (status === 'testing') return 'pending';
  if (status === 'ok') return 'ok';
  return 'bad';
};

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

  const renderBadgeText = (status: TestStatus | undefined) => {
    if (!status || status === 'idle') return null;
    if (status === 'testing') return 'testing…';
    if (status === 'ok') return 'ok';
    return status;
  };

  // ── List view ──────────────────────────────────────────────────────────
  if (editing === null) {
    return (
      <div className="max-w-[640px] mx-auto font-sans">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
              MCP servers
            </h2>
            <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
              Configure the MCP servers available to agents in this deployment.
            </p>
          </div>
          <Button onClick={startNew}>New MCP server</Button>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 px-3 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {error}
          </div>
        )}

        {servers.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No MCP servers yet.
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {servers.map((s) => (
              <RoleCard
                key={s.id}
                pill="mcp"
                title={s.name}
                caption={`${s.transport} · ${s.url}`}
              >
                <div className="flex items-center justify-end gap-2">
                  {renderBadgeText(testStatus[s.id]) && (
                    <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                      <StatusDot variant={testStatusToVariant(testStatus[s.id])} />
                      {renderBadgeText(testStatus[s.id])}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void onTest(s.id)}
                  >
                    Test
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startEdit(s)}
                  >
                    edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(s)}
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
          {editing === 'new' ? 'New MCP server' : `Edit ${form.name}`}
        </h2>
      </div>

      <Card className="p-5">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => void submit(e)}
        >
          {/* Name */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              type="text"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              required
            />
          </div>

          {/* URL */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              type="text"
              value={form.url}
              onChange={(e) =>
                setForm((f) => ({ ...f, url: e.target.value }))
              }
              required
            />
          </div>

          {/* Transport */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-transport">Transport</Label>
            <select
              id="mcp-transport"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
          </div>

          {/* Credentials ID */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-credentials">Credentials ID</Label>
            <Input
              id="mcp-credentials"
              type="text"
              placeholder="optional"
              value={form.credentials_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, credentials_id: e.target.value }))
              }
            />
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
    </div>
  );
}
