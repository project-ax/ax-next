/**
 * ConnectorRegistry — admin CRUD for connectors (TASK-98).
 *
 * Replaces the standalone `McpServerForm`. A connector is the first-class ACCESS
 * object (design "Connectors as a first-class concept"); an MCP-backed connector
 * is simply a connector whose `capabilities.mcpServers` is non-empty. This is the
 * one home for that concept (invariant #4) — creating/editing goes through the
 * connector store via `/admin/connectors`, never a separate MCP table.
 *
 * Shape mirrors the other admin list+form surfaces:
 *
 *   - List view: every connector the actor owns as a RoleCard showing the
 *     service name, what it needs (credential slots / nothing), and connected
 *     state — edit/delete per row, "New connector" at the top.
 *   - Form view: name + description + a "how to use me" note + whose-key
 *     (keyMode) + sharing (visibility) by DEFAULT. The backing MECHANISM
 *     (transport / command / url / args / hosts) lives only behind an
 *     **Advanced** disclosure (design: mechanism hidden unless asked).
 *
 * UI composes shadcn primitives + semantic tokens only — no raw colors.
 */
import { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import {
  listConnectors,
  getConnector,
  createConnector,
  patchConnector,
  deleteConnector,
  emptyCapabilities,
  type ConnectorSummary,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorKeyMode,
  type ConnectorVisibility,
  type ConnectorMcpServerSpec,
} from '../../lib/connectors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RoleCard } from './RoleCard';
import { StatusDot } from './StatusDot';

type Transport = 'stdio' | 'http';

type FormState = {
  connectorId: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: ConnectorKeyMode;
  visibility: ConnectorVisibility;
  /**
   * Default-on for every agent (the connector half of the admin Catalog). When
   * true the connector flows into every agent's effective set via
   * `connectors:list-defaults` (TASK-97). This is the admin "curate + flag
   * default-on" control (design §UI/IA admin Catalog).
   */
  defaultAttached: boolean;
  // Mechanism (Advanced) — at most one MCP server in this form. Empty command
  // AND empty url ⟹ a non-MCP connector (CLI / direct-API), still valid.
  transport: Transport;
  command: string;
  args: string; // space-separated
  url: string;
  allowedHosts: string; // comma-separated
  credentialSlots: string; // comma-separated slot names
  /**
   * The loaded connector's full capabilities (empty for a new connector). The
   * form only edits allowedHosts / credentials / the single leading mcpServer;
   * `packages` (CLI/npm/pypi backing) and any beyond-first mcpServer or extra
   * mcpServer fields (env, etc.) are NOT surfaced — so we carry the original
   * here and MERGE onto it on submit, never wiping the un-edited fill.
   */
  baseCapabilities: ConnectorCapabilities;
};

const emptyForm = (): FormState => ({
  connectorId: '',
  name: '',
  description: '',
  usageNote: '',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  allowedHosts: '',
  credentialSlots: '',
  baseCapabilities: emptyCapabilities(),
});

const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Derive form state from a fetched connector (edit mode). Reads the single
 *  leading mcpServer if present, otherwise leaves mechanism fields empty. */
function formFromConnector(c: Connector): FormState {
  const mcp = c.capabilities.mcpServers[0];
  const credSlots = c.capabilities.credentials.map((s) => s.slot);
  return {
    connectorId: c.id,
    name: c.name,
    description: c.description,
    usageNote: c.usageNote,
    keyMode: c.keyMode,
    visibility: c.visibility,
    defaultAttached: c.defaultAttached,
    transport: mcp?.transport ?? 'stdio',
    command: mcp?.command ?? '',
    args: (mcp?.args ?? []).join(' '),
    url: mcp?.url ?? '',
    allowedHosts: c.capabilities.allowedHosts.join(', '),
    credentialSlots: credSlots.join(', '),
    baseCapabilities: c.capabilities,
  };
}

/**
 * Assemble the opaque capabilities fill. MERGES the form's edited fields
 * (allowedHosts / credentials / the single leading mcpServer) onto the loaded
 * connector's original capabilities so the un-surfaced fill — `packages`
 * (CLI/npm/pypi backing), any beyond-first mcpServer, extra mcpServer fields
 * (env) — is PRESERVED, never wiped on edit. For a new connector the base is
 * empty so this is a plain build.
 */
function capabilitiesFromForm(form: FormState): ConnectorCapabilities {
  const base = form.baseCapabilities;
  const allowedHosts = splitList(form.allowedHosts);
  const credentials = splitList(form.credentialSlots).map((slot) => ({
    slot,
    kind: 'api-key' as const,
  }));
  const hasMcp =
    (form.transport === 'http' && form.url.trim().length > 0) ||
    (form.transport === 'stdio' && form.command.trim().length > 0);
  let mcpServers = base.mcpServers;
  if (hasMcp) {
    const existing = base.mcpServers[0];
    // Preserve any extra mcpServer fields (env, the server's own allowedHosts /
    // credentials) the form doesn't surface; overlay transport/command/args/url.
    const server: ConnectorMcpServerSpec = {
      name: existing?.name ?? form.connectorId ?? form.name.trim().toLowerCase(),
      allowedHosts: existing?.allowedHosts ?? [],
      credentials: existing?.credentials ?? [],
      ...(existing?.env !== undefined ? { env: existing.env } : {}),
      transport: form.transport,
      ...(form.transport === 'stdio'
        ? {
            command: form.command.trim(),
            args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
          }
        : { url: form.url.trim() }),
    };
    // Replace the leading server; keep any beyond-first servers untouched.
    mcpServers = [server, ...base.mcpServers.slice(1)];
  }
  return {
    allowedHosts,
    credentials,
    mcpServers,
    packages: base.packages,
  };
}

/** Short "what it needs" caption for the list. */
function needsCaption(c: ConnectorSummary): string {
  const key = c.keyMode === 'workspace' ? 'a shared key' : 'a personal key';
  return `Needs ${key}`;
}

export function ConnectorRegistry() {
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [editing, setEditing] = useState<ConnectorSummary | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await listConnectors();
      setConnectors(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []); // mount-only: intentional

  const startNew = () => {
    setError(null);
    setForm(emptyForm());
    setShowAdvanced(false);
    setEditing('new');
  };

  const startEdit = async (c: ConnectorSummary) => {
    setError(null);
    setShowAdvanced(false);
    setEditing(c);
    try {
      const full = await getConnector(c.id);
      setForm(formFromConnector(full));
    } catch (err) {
      // Fall back to summary-only fields; mechanism stays blank until refetch.
      setForm({ ...emptyForm(), ...summaryToForm(c) });
      setError(err instanceof Error ? err.message : String(err));
    }
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
    const connectorId =
      form.connectorId ||
      form.name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    setBusy(true);
    setError(null);
    const body = {
      connectorId,
      name: form.name.trim(),
      description: form.description,
      usageNote: form.usageNote,
      keyMode: form.keyMode,
      visibility: form.visibility,
      defaultAttached: form.defaultAttached,
      capabilities: capabilitiesFromForm(form),
    };
    try {
      if (editing === 'new') {
        await createConnector(body);
      } else if (editing) {
        await patchConnector(editing.id, body);
      }
      await refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: ConnectorSummary) => {
    if (!confirm(`Delete connector "${c.name}"?`)) return;
    try {
      await deleteConnector(c.id);
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
              Connectors
            </h2>
            <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
              Connected services your agents can reach. Each connector bundles
              what a service needs — a key, the hosts it talks to — behind a
              single name.
            </p>
          </div>
          <Button onClick={startNew}>New connector</Button>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 px-3 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {error}
          </div>
        )}

        {connectors.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No connectors yet. Connect a service to get started.
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {connectors.map((c) => (
              <RoleCard
                key={c.id}
                pill="connector"
                title={c.name}
                caption={needsCaption(c)}
              >
                <div className="flex items-center justify-end gap-2">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground mr-auto">
                    <StatusDot variant="ok" />
                    connected
                  </span>
                  {c.visibility === 'shared' && (
                    <Badge variant="secondary" className="text-[10px]">
                      shared
                    </Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void startEdit(c)}
                  >
                    edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(c)}
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
          {editing === 'new' ? 'New connector' : `Edit ${form.name}`}
        </h2>
      </div>

      <Card className="p-5">
        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
          {/* Name */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="connector-name">Service name</Label>
            <Input
              id="connector-name"
              type="text"
              placeholder="e.g. Google Drive, Salesforce"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              required
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="connector-description">Description</Label>
            <Input
              id="connector-description"
              type="text"
              placeholder="What this connects to"
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
            />
          </div>

          {/* Usage note */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="connector-usage">How to use it</Label>
            <Textarea
              id="connector-usage"
              rows={3}
              placeholder="A short note the assistant reads so it knows how to drive this service."
              value={form.usageNote}
              onChange={(e) =>
                setForm((f) => ({ ...f, usageNote: e.target.value }))
              }
            />
          </div>

          {/* Whose key (keyMode) */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="connector-keymode">Whose key</Label>
            <Select
              value={form.keyMode}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, keyMode: v as ConnectorKeyMode }))
              }
            >
              <SelectTrigger id="connector-keymode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">
                  Personal — each user brings their own key
                </SelectItem>
                <SelectItem value="workspace">
                  Shared — one key the whole workspace spends
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Sharing (visibility) */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="connector-visibility">Sharing</Label>
            <Select
              value={form.visibility}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, visibility: v as ConnectorVisibility }))
              }
            >
              <SelectTrigger id="connector-visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">
                  Private — just your agents
                </SelectItem>
                <SelectItem value="shared">
                  Shared — agents others can use
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Default-on (the connector half of the admin Catalog). Flowing a
              connector on by default grants it to EVERY agent (TASK-97) — an
              admin-only curation control. */}
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="connector-default"
              checked={form.defaultAttached}
              onCheckedChange={(v) =>
                setForm((f) => ({ ...f, defaultAttached: v === true }))
              }
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="connector-default" className="cursor-pointer">
                Default-on for all agents
              </Label>
              <p className="text-xs text-muted-foreground">
                Every agent gets this connector without anyone attaching it.
              </p>
            </div>
          </div>

          {/* Advanced: the backing mechanism (hidden unless asked). */}
          <div className="flex flex-col gap-3 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start px-1.5"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((s) => !s)}
            >
              {showAdvanced ? (
                <ChevronDown className="h-3.5 w-3.5 mr-1" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 mr-1" />
              )}
              Advanced — how it connects
            </Button>

            {showAdvanced && (
              <div className="flex flex-col gap-4 pl-1 border-l border-border ml-0.5">
                <div className="pl-3 flex flex-col gap-4">
                  <p className="text-xs text-muted-foreground">
                    The backing mechanism. Leave the MCP fields blank for a
                    connector that drives a CLI or a direct API instead.
                  </p>

                  {/* Transport */}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="connector-transport">Transport</Label>
                    <Select
                      value={form.transport}
                      onValueChange={(v) =>
                        setForm((f) => ({ ...f, transport: v as Transport }))
                      }
                    >
                      <SelectTrigger id="connector-transport">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">stdio (local binary)</SelectItem>
                        <SelectItem value="http">http (remote server)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {form.transport === 'stdio' ? (
                    <>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="connector-command">Command</Label>
                        <Input
                          id="connector-command"
                          type="text"
                          placeholder="e.g. mcp-gdrive"
                          value={form.command}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, command: e.target.value }))
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="connector-args">
                          Args (space-separated)
                        </Label>
                        <Input
                          id="connector-args"
                          type="text"
                          placeholder="optional"
                          value={form.args}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, args: e.target.value }))
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="connector-url">URL</Label>
                      <Input
                        id="connector-url"
                        type="text"
                        placeholder="https://..."
                        value={form.url}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, url: e.target.value }))
                        }
                      />
                    </div>
                  )}

                  {/* Allowed hosts */}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="connector-hosts">
                      Allowed hosts (comma-separated)
                    </Label>
                    <Input
                      id="connector-hosts"
                      type="text"
                      placeholder="e.g. drive.googleapis.com"
                      value={form.allowedHosts}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, allowedHosts: e.target.value }))
                      }
                    />
                  </div>

                  {/* Credential slots */}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="connector-slots">
                      Credential slots (comma-separated)
                    </Label>
                    <Input
                      id="connector-slots"
                      type="text"
                      className="font-mono"
                      placeholder="e.g. gdrive"
                      value={form.credentialSlots}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          credentialSlots: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
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
    </div>
  );
}

/** Map a summary into the subset of form fields it carries (edit fallback). */
function summaryToForm(c: ConnectorSummary): Partial<FormState> {
  return {
    connectorId: c.id,
    name: c.name,
    description: c.description,
    usageNote: c.usageNote,
    keyMode: c.keyMode,
    visibility: c.visibility,
  };
}
