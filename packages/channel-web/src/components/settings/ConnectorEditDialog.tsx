/**
 * ConnectorEditDialog — the SHARED, mechanism-first connector create/edit form
 * (TASK-128, settings-unified epic). One component, two variants:
 *   - admin curation (the folded Connector Registry, `isAdmin`) — exposes the
 *     workspace-level fields (Sharing / default-on for all agents).
 *   - user authoring (`isAdmin={false}`) — hides those fields and forces the
 *     connector private. (The user-facing ENTRY points + owner-scoped routes are
 *     TASK-129; this component is the variant-aware form they reuse.)
 *
 * MECHANISM-FIRST. A segmented picker at the top — MCP server / Direct API /
 * Command-line tool — reshapes the visible fields (the old "Advanced — how it
 * connects" disclosure is GONE). The form logic lives in `lib/connector-form`,
 * the one source of truth (invariant #4):
 *   - MCP server   → transport (stdio command+args / http url) + secrets.
 *   - Direct API   → allowed hosts + key(s) (proxy-injected).
 *   - Command-line → an npm/pypi package + allowed hosts + env secrets.
 * The backing-mechanism vocabulary (transport / command / url / packages) never
 * becomes a first-class field — it is assembled into the opaque `capabilities`
 * spec on submit (invariant #1).
 *
 * Credential slots are STRUCTURED rows (description + machine name + optional
 * share-by-service account), not a comma-string; they map to the TASK-124
 * per-slot credential refs.
 *
 * SECURITY (invariant #5): EVERY field is browser-supplied and UNTRUSTED — hosts,
 * commands, package names, credential SLOT NAMES (never values). They flow to the
 * owner-scoped `/admin/connectors` routes, which force the owner from the session
 * and validate the opaque `capabilities` against the canonical schema
 * server-side; nothing here is trusted. The Command-line path declares an
 * egress+exec surface (a public-registry package the sandbox may run) — its reach
 * is still gated by the same server-side capability validation + the sandbox's
 * allowedHosts egress lock. Untrusted text renders through React text nodes
 * (auto-escaped), never raw HTML.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  getConnector,
  createConnector,
  patchConnector,
  type ConnectorSummary,
  type ConnectorKeyMode,
  type ConnectorVisibility,
} from '@/lib/connectors';
import {
  emptyConnectorForm,
  emptySlotRow,
  formFromConnector,
  capabilitiesFromForm,
  summaryToForm,
  connectorIdFromName,
  type ConnectorFormState,
  type Mechanism,
  type Transport,
  type PackageRegistry,
} from '@/lib/connector-form';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface ConnectorEditDialogProps {
  /** `'new'` opens a blank create form; a summary opens an edit form prefilled
   *  from the full connector. */
  target: ConnectorSummary | 'new';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create/update so the caller can refresh + close. */
  onSaved: () => void;
  /**
   * Admin variant. When true the workspace-level fields (Sharing / default-on)
   * are exposed; when false they are hidden and `visibility` is forced `private`
   * (user authoring). Defaults to false — the safe, least-privilege variant.
   */
  isAdmin?: boolean;
}

/** Per-mechanism "what the secrets are" label (truthful per the design). */
function secretsLabel(form: ConnectorFormState): string {
  if (form.mechanism === 'mcp') {
    return form.transport === 'stdio' ? 'Secrets (env vars)' : 'Secrets (headers)';
  }
  if (form.mechanism === 'cli') return 'Secrets (env vars)';
  return 'API key(s)';
}

const MECHANISM_OPTIONS: { value: Mechanism; label: string }[] = [
  { value: 'mcp', label: 'MCP server' },
  { value: 'direct-api', label: 'Direct API' },
  { value: 'cli', label: 'Command-line tool' },
];

export function ConnectorEditDialog({
  target,
  open,
  onOpenChange,
  onSaved,
  isAdmin = false,
}: ConnectorEditDialogProps) {
  const [form, setForm] = useState<ConnectorFormState>(() => emptyConnectorForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)load the form each time the dialog opens. For edit, fetch the full
  // connector so the mechanism + capabilities round-trip; fall back to the
  // summary subset if the fetch fails (mechanism stays at the default).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setBusy(false);
    if (target === 'new') {
      setForm(emptyConnectorForm());
      return;
    }
    setForm({ ...emptyConnectorForm(), ...summaryToForm(target) });
    getConnector(target.id)
      .then((full) => {
        if (!cancelled) setForm(formFromConnector(full));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!form.name.trim()) {
      setError('name is required');
      return;
    }
    const connectorId = form.connectorId || connectorIdFromName(form.name);
    setBusy(true);
    setError(null);
    // The user variant cannot set workspace-level fields — force them off so a
    // tampered form state can't smuggle a shared / default-on connector through
    // (the server also rejects them for a non-admin owner; this is belt + braces).
    const visibility: ConnectorVisibility = isAdmin ? form.visibility : 'private';
    const defaultAttached = isAdmin ? form.defaultAttached : false;
    const body = {
      connectorId,
      name: form.name.trim(),
      description: form.description,
      usageNote: form.usageNote,
      keyMode: form.keyMode,
      visibility,
      defaultAttached,
      capabilities: capabilitiesFromForm(form),
    };
    try {
      if (target === 'new') {
        await createConnector(body);
      } else {
        await patchConnector(target.id, body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // --- structured credential-slot row helpers ------------------------------
  const addSlot = () =>
    setForm((f) => ({ ...f, credentialSlots: [...f.credentialSlots, emptySlotRow()] }));
  const removeSlot = (i: number) =>
    setForm((f) => ({
      ...f,
      credentialSlots: f.credentialSlots.filter((_, idx) => idx !== i),
    }));
  const updateSlot = (i: number, patch: Partial<ConnectorFormState['credentialSlots'][number]>) =>
    setForm((f) => ({
      ...f,
      credentialSlots: f.credentialSlots.map((row, idx) =>
        idx === i ? { ...row, ...patch } : row,
      ),
    }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {target === 'new' ? 'New connector' : `Edit ${form.name || 'connector'}`}
          </DialogTitle>
          <DialogDescription>
            {isAdmin
              ? 'Curate a service the workspace can connect to. Sharing and default-on make it available to everyone’s agents.'
              : 'Add a service your assistant can connect to. It stays private to your agents.'}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
          {/* Mechanism picker — leads the form, reshapes the fields below. */}
          <div className="flex flex-col gap-2">
            <Label>How it connects</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={form.mechanism}
              onValueChange={(v) => {
                // Radix emits '' when the active item is re-clicked; keep the
                // current mechanism (a mechanism is always required).
                if (v) setForm((f) => ({ ...f, mechanism: v as Mechanism }));
              }}
              className="justify-start flex-wrap"
            >
              {MECHANISM_OPTIONS.map((m) => (
                <ToggleGroupItem key={m.value} value={m.value} className="px-3">
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {/* Name */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="connector-name">Service name</Label>
            <Input
              id="connector-name"
              type="text"
              placeholder="e.g. Google Drive, Salesforce"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
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

          {/* Admin-only workspace fields. Hidden + forced off in the user variant. */}
          {isAdmin && (
            <>
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

              {/* Default-on for all agents */}
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
            </>
          )}

          {/* Per-mechanism fields. */}
          <div className="flex flex-col gap-4 border-t border-border pt-4">
            {form.mechanism === 'mcp' && (
              <>
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
                      <Label htmlFor="connector-args">Args (space-separated)</Label>
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
              </>
            )}

            {form.mechanism === 'cli' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="connector-package">Package</Label>
                <p className="text-xs text-muted-foreground">
                  A package from a public registry. The sandbox installs it on
                  demand — its network reach is still limited to the allowed hosts
                  below.
                </p>
                <div className="flex gap-2">
                  <Select
                    value={form.packageRegistry}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        packageRegistry: v as PackageRegistry,
                      }))
                    }
                  >
                    <SelectTrigger className="w-[110px]" aria-label="Package registry">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="npm">npm</SelectItem>
                      <SelectItem value="pypi">pypi</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    id="connector-package"
                    type="text"
                    className="font-mono"
                    placeholder="e.g. @org/cli or some-pkg"
                    aria-label="Package name"
                    value={form.packageName}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, packageName: e.target.value }))
                    }
                  />
                </div>
              </div>
            )}

            {/* Allowed hosts — relevant to direct-api + cli (MCP reach derives
                from its own server config, so we hide it for the MCP mechanism). */}
            {form.mechanism !== 'mcp' && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="connector-hosts">
                  Allowed hosts (comma-separated)
                </Label>
                <Input
                  id="connector-hosts"
                  type="text"
                  placeholder="e.g. api.stripe.com"
                  value={form.allowedHosts}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, allowedHosts: e.target.value }))
                  }
                />
              </div>
            )}

            {/* Structured credential-slot rows. */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <Label>{secretsLabel(form)}</Label>
                <Button type="button" variant="outline" size="sm" onClick={addSlot}>
                  {form.mechanism === 'direct-api' ? 'Add key' : 'Add secret'}
                </Button>
              </div>
              {form.credentialSlots.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No keys needed — this connector reaches its service without one.
                </p>
              ) : (
                form.credentialSlots.map((row, i) => (
                  <div
                    key={i}
                    className="flex flex-col gap-2 rounded-md border border-border p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        Key {i + 1}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove key ${i + 1}`}
                        onClick={() => removeSlot(i)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`slot-desc-${i}`} className="text-xs">
                        Label (what it is)
                      </Label>
                      <Input
                        id={`slot-desc-${i}`}
                        type="text"
                        placeholder="e.g. Personal access token"
                        value={row.description}
                        onChange={(e) => updateSlot(i, { description: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`slot-name-${i}`} className="text-xs">
                        Machine name
                      </Label>
                      <Input
                        id={`slot-name-${i}`}
                        type="text"
                        className="font-mono"
                        placeholder="e.g. GITHUB_TOKEN"
                        value={row.slot}
                        onChange={(e) => updateSlot(i, { slot: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`slot-account-${i}`} className="text-xs">
                        Share key by service (optional)
                      </Label>
                      <Input
                        id={`slot-account-${i}`}
                        type="text"
                        className="font-mono"
                        placeholder="e.g. github — reuse one stored key across connectors"
                        value={row.account}
                        onChange={(e) => updateSlot(i, { account: e.target.value })}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
