/**
 * ConnectorEditDialog — the inline admin connector create/edit form, folded
 * into the Connectors tab (TASK-127). The standalone admin Connector Registry
 * surface is gone (TASK-125 dropped it from the nav); admins now curate the
 * workspace's Available shelf directly here.
 *
 * This reuses the SAME form logic as the (orphaned) ConnectorRegistry via the
 * shared `lib/connector-form` module — one source of truth for the connector
 * form (invariant #4). The only shape difference is presentation: a Dialog
 * instead of a full-page view, so curation happens without leaving the tab.
 *
 * The backing MECHANISM (transport / command / url / args / hosts / slots)
 * still lives behind an "Advanced — how it connects" disclosure; the default
 * fields are the service-level ones a curator reasons about (name, description,
 * how-to-use, whose key, sharing, default-on). TASK-128 reshapes this into a
 * mechanism-first form; until then the fold is behavior-preserving.
 *
 * SECURITY (invariant #5): all fields are browser-supplied. They flow to the
 * owner-scoped `/admin/connectors` routes, which force the owner from the
 * session and validate the opaque `capabilities` against the canonical schema
 * server-side; nothing here is trusted. Untrusted text renders through React
 * text nodes (auto-escaped), never raw HTML.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
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
  formFromConnector,
  capabilitiesFromForm,
  summaryToForm,
  connectorIdFromName,
  type ConnectorFormState,
  type Transport,
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
}

export function ConnectorEditDialog({
  target,
  open,
  onOpenChange,
  onSaved,
}: ConnectorEditDialogProps) {
  const [form, setForm] = useState<ConnectorFormState>(() => emptyConnectorForm());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)load the form each time the dialog opens. For edit, fetch the full
  // connector so the mechanism fields + capabilities round-trip; fall back to
  // the summary subset if the fetch fails (mechanism stays blank until refetch).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setShowAdvanced(false);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {target === 'new' ? 'New connector' : `Edit ${form.name || 'connector'}`}
          </DialogTitle>
          <DialogDescription>
            Curate a service the workspace can connect to. Sharing and default-on
            make it available to everyone's agents.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
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

          {/* Sharing (visibility) — admin-only field, exposed here. */}
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

          {/* Default-on — the connector half of the workspace catalog. Flowing
              a connector on by default grants it to EVERY agent. Admin curation. */}
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
