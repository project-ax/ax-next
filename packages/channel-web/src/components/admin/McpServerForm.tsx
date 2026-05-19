/**
 * McpServerForm — admin CRUD for MCP servers (Task 23 / Task 12).
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
 *
 * Task 12 replaces the old `credentials_id` field with per-env/per-header
 * CredentialSlotRow lists, matching the real @ax/mcp-client ServerConfig
 * schema (`credentialRefs` for stdio, `headerCredentialRefs` for http
 * transports). The `initialConfig` prop accepts an optional
 * McpServerConfig-shaped object for testability — when provided the form
 * opens immediately in "edit" mode, bypassing the list view.
 */
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  listMcpServers,
  createMcpServer,
  patchMcpServer,
  deleteMcpServer,
  testMcpServer,
} from '../../lib/admin';
import type { McpServerInput } from '../../lib/admin';
import type { McpServer, McpServerConfig } from '../../../mock/admin/mcp-servers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { RoleCard } from './RoleCard';
import { StatusDot } from './StatusDot';
import { CredentialSlotRow } from '../credentials/CredentialSlotRow';
import { refForDestination } from '@/lib/credentials';

const TRANSPORTS: McpServerInput['transport'][] = [
  'stdio',
  'streamable-http',
  'sse',
  'http',
];

const HTTP_TRANSPORTS: McpServerInput['transport'][] = [
  'http',
  'sse',
  'streamable-http',
];

function buildEnvBindings(
  serverId: string,
  envNames: string[],
): Record<string, string> {
  return Object.fromEntries(
    envNames.map((name) => [
      name,
      refForDestination({ kind: 'mcp-env', serverId, envName: name }),
    ]),
  );
}

function buildHeaderBindings(
  serverId: string,
  headerNames: string[],
): Record<string, string> {
  return Object.fromEntries(
    headerNames.map((name) => [
      name,
      refForDestination({ kind: 'mcp-header', serverId, headerName: name }),
    ]),
  );
}

type FormTransport = McpServerInput['transport'];

type FormState = {
  name: string;
  transport: FormTransport;
  // stdio fields
  command: string;
  args: string; // space-separated
  envNames: string[]; // each env var name becomes a credential slot
  // http/sse/streamable-http fields
  url: string;
  headerNames: string[]; // each header name becomes a credential slot
};

const emptyForm = (): FormState => ({
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  envNames: [],
  url: '',
  headerNames: [],
});

/** Derive initial form state from an existing McpServerConfig (for edit mode). */
function formFromConfig(cfg: McpServerConfig): FormState {
  if (cfg.transport === 'stdio') {
    // Env names: union of plain env keys and credentialRefs keys
    const envNames = Array.from(
      new Set([
        ...Object.keys(cfg.env ?? {}),
        ...Object.keys(cfg.credentialRefs ?? {}),
      ]),
    );
    return {
      name: cfg.id,
      transport: 'stdio',
      command: cfg.command,
      args: (cfg.args ?? []).join(' '),
      envNames,
      url: '',
      headerNames: [],
    };
  }
  // http / sse / streamable-http
  const headerNames = Object.keys(cfg.headerCredentialRefs ?? {});
  return {
    name: cfg.id,
    transport: cfg.transport,
    command: '',
    args: '',
    envNames: [],
    url: cfg.url,
    headerNames,
  };
}

/** Derive initial form state from a flat McpServer (list-mode record). */
function formFromServer(s: McpServer): FormState {
  return {
    name: s.name,
    transport: s.transport,
    command: '',
    args: '',
    envNames: [],
    url: s.url,
    headerNames: [],
  };
}

type TestStatus = 'idle' | 'testing' | 'ok' | string;

const testStatusToVariant = (
  status: TestStatus | undefined,
): 'empty' | 'ok' | 'bad' | 'pending' => {
  if (!status || status === 'idle') return 'empty';
  if (status === 'testing') return 'pending';
  if (status === 'ok') return 'ok';
  return 'bad';
};

export interface McpServerFormProps {
  /** When provided the form opens immediately in edit mode, bypassing the
   *  list view. Intended for tests and deep-link scenarios. */
  initialConfig?: McpServerConfig;
}

export function McpServerForm({ initialConfig }: McpServerFormProps = {}) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(
    initialConfig != null ? ('new' as const) : null,
  );
  const [form, setForm] = useState<FormState>(() =>
    initialConfig != null ? formFromConfig(initialConfig) : emptyForm(),
  );
  // serverId is the id used for computing refs. For "new" it's empty until
  // the user fills the name; for edits it's the existing server id.
  const [serverId, setServerId] = useState<string>(
    initialConfig != null ? initialConfig.id : '',
  );
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
    // Skip the initial list fetch when driven by initialConfig (test/deep-link mode).
    if (initialConfig != null) return;
    void refresh();
    // `refresh` is stable (defined inside the component but doesn't close
    // over any state that changes after mount). `initialConfig` is a prop
    // that is intentionally read only at mount time — the list view is not
    // supported when initialConfig is provided.
  }, []); // mount-only: intentional

  const startNew = () => {
    setError(null);
    setForm(emptyForm());
    setServerId('');
    setEditing('new');
  };

  const startEdit = (s: McpServer) => {
    setError(null);
    setForm(formFromServer(s));
    setServerId(s.id);
    setEditing(s);
  };

  const cancelForm = () => {
    setEditing(null);
    setError(null);
  };

  const isHttpTransport = HTTP_TRANSPORTS.includes(form.transport);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!form.name.trim()) {
      setError('name is required');
      return;
    }
    if (isHttpTransport && !form.url.trim()) {
      setError('url is required for http transports');
      return;
    }
    if (!isHttpTransport && !form.command.trim()) {
      setError('command is required for stdio transport');
      return;
    }
    setBusy(true);
    setError(null);

    const id = serverId || form.name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');

    let payload: McpServerInput;
    if (isHttpTransport) {
      payload = {
        name: form.name.trim(),
        transport: form.transport,
        url: form.url.trim(),
        ...(form.headerNames.length > 0
          ? { headerCredentialRefs: buildHeaderBindings(id, form.headerNames) }
          : {}),
      };
    } else {
      payload = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.command.trim(),
        args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
        ...(form.envNames.length > 0
          ? { credentialRefs: buildEnvBindings(id, form.envNames) }
          : {}),
      };
    }

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

  // ── Env var / header name list helpers ────────────────────────────────

  const addEnvName = () =>
    setForm((f) => ({ ...f, envNames: [...f.envNames, ''] }));

  const setEnvName = (idx: number, value: string) =>
    setForm((f) => {
      const next = [...f.envNames];
      next[idx] = value;
      return { ...f, envNames: next };
    });

  const removeEnvName = (idx: number) =>
    setForm((f) => ({
      ...f,
      envNames: f.envNames.filter((_, i) => i !== idx),
    }));

  const addHeaderName = () =>
    setForm((f) => ({ ...f, headerNames: [...f.headerNames, ''] }));

  const setHeaderName = (idx: number, value: string) =>
    setForm((f) => {
      const next = [...f.headerNames];
      next[idx] = value;
      return { ...f, headerNames: next };
    });

  const removeHeaderName = (idx: number) =>
    setForm((f) => ({
      ...f,
      headerNames: f.headerNames.filter((_, i) => i !== idx),
    }));

  // The effective server id for ref computation — use the existing server id
  // for edits, or derive a slug from the current name for new ones.
  const effectiveServerId =
    serverId ||
    form.name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-') ||
    'new';

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
                  transport: e.target.value as FormTransport,
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

          {/* Stdio-specific fields */}
          {!isHttpTransport && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  type="text"
                  placeholder="e.g. mcp-github"
                  value={form.command}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, command: e.target.value }))
                  }
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-args">Args (space-separated)</Label>
                <Input
                  id="mcp-args"
                  type="text"
                  placeholder="optional"
                  value={form.args}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, args: e.target.value }))
                  }
                />
              </div>

              {/* Env var credential slots (stdio) */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label>Env vars (credential slots)</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addEnvName}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add env var
                  </Button>
                </div>
                {form.envNames.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No env vars declared. Each declared env var name becomes a
                    credential slot the operator must fill.
                  </p>
                )}
                <div className="space-y-1 divide-y divide-border">
                  {form.envNames.map((name, idx) => (
                    <div key={idx} className="pt-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Input
                          aria-label={`Env var name ${idx + 1}`}
                          type="text"
                          className="h-7 text-xs font-mono"
                          placeholder="VAR_NAME"
                          value={name}
                          onChange={(e) => setEnvName(idx, e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeEnvName(idx)}
                          aria-label={`Remove env var ${name || idx + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {name.trim() && (
                        <CredentialSlotRow
                          destination={{
                            kind: 'mcp-env',
                            serverId: effectiveServerId,
                            envName: name.trim(),
                          }}
                          slot={{ label: name.trim(), kind: 'api-key' }}
                          scope={{ scope: 'global', ownerId: null }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* HTTP-specific fields */}
          {isHttpTransport && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  type="text"
                  placeholder="https://..."
                  value={form.url}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, url: e.target.value }))
                  }
                  required
                />
              </div>

              {/* Header credential slots (http) */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label>Headers (credential slots)</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addHeaderName}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add header
                  </Button>
                </div>
                {form.headerNames.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No headers declared. Each declared header name becomes a
                    credential slot the operator must fill.
                  </p>
                )}
                <div className="space-y-1 divide-y divide-border">
                  {form.headerNames.map((name, idx) => (
                    <div key={idx} className="pt-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Input
                          aria-label={`Header name ${idx + 1}`}
                          type="text"
                          className="h-7 text-xs font-mono"
                          placeholder="Authorization"
                          value={name}
                          onChange={(e) => setHeaderName(idx, e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeHeaderName(idx)}
                          aria-label={`Remove header ${name || idx + 1}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {name.trim() && (
                        <CredentialSlotRow
                          destination={{
                            kind: 'mcp-header',
                            serverId: effectiveServerId,
                            headerName: name.trim(),
                          }}
                          slot={{ label: name.trim(), kind: 'api-key' }}
                          scope={{ scope: 'global', ownerId: null }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

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
