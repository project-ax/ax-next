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
 * Credential slots are STRUCTURED rows (description + machine name), not a
 * comma-string; they map to the per-slot credential refs (keyed by the connector
 * id — each connector owns its own key, no share-by-service).
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
import { X, ChevronDown } from 'lucide-react';
import type { ComposeDrop, ComposeInvalid } from '@ax/skills-parser';
import {
  getConnector,
  createConnector,
  patchConnector,
  type ConnectorSummary,
  type ConnectorKeyMode,
  type ConnectorVisibility,
  type ConnectorRouteBase,
  type ServiceDescriptor,
} from '@/lib/connectors';
import {
  emptyConnectorForm,
  emptySlotRow,
  emptyServiceRow,
  formFromConnector,
  capabilitiesFromForm,
  applyComposeToForm,
  summaryToForm,
  connectorIdFromName,
  STARTER_SERVICE_EXAMPLES,
  type ConnectorFormState,
  type Mechanism,
  type Transport,
  type PackageRegistry,
} from '@/lib/connector-form';
import {
  setDestinationCredential,
  refForDestination,
} from '@/lib/credentials';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

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

// --- service-row (de)serialization (TASK-154) -------------------------------
// The descriptor's `ports` (number[]) / `env` (record) / `writablePaths`
// (string[]) edit as plain text in the form, so the author types comfortably;
// we parse back to the descriptor shape. The store re-validates everything
// against the canonical schema, so loose parsing here is fine — it never widens
// what crosses (an out-of-range port / non-absolute path is rejected server-side
// and at the wire).

const portsToText = (ports: number[]): string => ports.join(', ');
const textToPorts = (s: string): number[] =>
  s
    .split(',')
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((n) => Number.isInteger(n));

const envToText = (env: Record<string, string>): string =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
const textToEnv = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    const eq = t.indexOf('=');
    if (eq === -1) out[t] = '';
    else out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
};

const pathsToText = (paths: string[]): string => paths.join(', ');
const textToPaths = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** Whether an image string is digest-pinned (mirrors the descriptor regex). The
 *  UI flags an un-pinned image inline so the author pins it before save (I8). */
const isDigestPinned = (image: string): boolean =>
  /.+@sha256:[0-9a-f]{64}$/.test(image.trim());

/**
 * The Services ("service bundle") section — declare dev services a connector
 * brings alongside the sandbox (a database, a cache, …). Paste a
 * docker-compose.yml to translate (curated: host mounts / privileged / cap_add /
 * network_mode:host / socket mounts are DROPPED and reported, un-pinned images
 * flagged) or add/edit services by hand. Composes shadcn `Card` / `Alert` /
 * `Button` / `Input` / `Label` / `Textarea` + semantic tokens (invariant #6).
 */
function ServicesSection({
  services,
  onChange,
}: {
  services: ServiceDescriptor[];
  onChange: (next: ServiceDescriptor[]) => void;
}) {
  const [compose, setCompose] = useState('');
  const [drops, setDrops] = useState<ComposeDrop[]>([]);
  const [invalid, setInvalid] = useState<ComposeInvalid[]>([]);
  const [composeError, setComposeError] = useState<string | null>(null);

  const translate = () => {
    setComposeError(null);
    // applyComposeToForm REPLACES `services` with the translated set, so the
    // form we hand it only needs to be a valid shell — the current `services`
    // would be overwritten anyway. We lift the result's services up via onChange.
    const result = applyComposeToForm(emptyConnectorForm(), compose);
    if (!result.ok) {
      setComposeError(result.error);
      setDrops([]);
      setInvalid([]);
      return;
    }
    onChange(result.form.services);
    setDrops(result.drops);
    setInvalid(result.invalid);
  };

  const updateService = (i: number, patch: Partial<ServiceDescriptor>) =>
    onChange(services.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeService = (i: number) =>
    onChange(services.filter((_, idx) => idx !== i));

  return (
    <Card className="border-border">
      <CardHeader>
        <CardTitle className="text-base">Services</CardTitle>
        <CardDescription>
          Make this a service bundle — declare a database, cache, or other service
          your assistant gets running alongside its sandbox. Paste a Compose file
          to start, or add one by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Compose paste → curated translate. */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="connector-compose">
            Paste a docker-compose.yml (optional)
          </Label>
          <Textarea
            id="connector-compose"
            rows={4}
            className="font-mono text-xs"
            placeholder={'services:\n  db:\n    image: postgres@sha256:...\n    ports: ["5432:5432"]'}
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              We translate it — we don’t run it. Anything that can’t safely cross
              into the sandbox gets dropped, and we’ll tell you what.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={translate}
              disabled={compose.trim().length === 0}
            >
              Translate compose
            </Button>
          </div>
        </div>

        {composeError && (
          <Alert variant="destructive">
            <AlertDescription>
              We couldn’t read that as a Compose file: {composeError}
            </AlertDescription>
          </Alert>
        )}

        {/* I10 — what we removed because it can’t cross into the sandbox. */}
        {drops.length > 0 && (
          <Alert>
            <AlertTitle>We removed a few things</AlertTitle>
            <AlertDescription>
              <p className="mb-1">
                These can’t cross into the sandbox — they’re how a container breaks
                out of one, so we left them behind:
              </p>
              <ul className="list-disc pl-5">
                {drops.map((d, i) => (
                  <li key={i}>
                    <span className="font-mono">{d.field}</span> on{' '}
                    <span className="font-mono">{d.service}</span>
                    {d.value ? <span className="text-muted-foreground"> ({d.value})</span> : null}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* I8 — un-pinned images (and other un-translatable services). */}
        {invalid.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>A few services need a fix</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {invalid.map((iv, i) => (
                  <li key={i}>
                    <span className="font-mono">{iv.name}</span>: {iv.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Declared service rows. */}
        {services.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No services declared — this connector adds reach, not a running service.
          </p>
        ) : (
          services.map((svc, i) => (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  Service {i + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove service ${i + 1}`}
                  onClick={() => removeService(i)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`svc-name-${i}`} className="text-xs">
                  Name
                </Label>
                <Input
                  id={`svc-name-${i}`}
                  type="text"
                  className="font-mono"
                  placeholder="e.g. db"
                  value={svc.name}
                  onChange={(e) => updateService(i, { name: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`svc-image-${i}`} className="text-xs">
                  Image (digest-pinned)
                </Label>
                <Input
                  id={`svc-image-${i}`}
                  type="text"
                  className="font-mono"
                  placeholder="e.g. postgres@sha256:…"
                  value={svc.image}
                  onChange={(e) => updateService(i, { image: e.target.value })}
                />
                {svc.image.trim().length > 0 && !isDigestPinned(svc.image) && (
                  <p className="text-xs text-destructive">
                    Pin this image to an immutable digest (…@sha256:&lt;64 hex&gt;) —
                    a floating tag can change under us.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`svc-ports-${i}`} className="text-xs">
                  Ports (comma-separated)
                </Label>
                <Input
                  id={`svc-ports-${i}`}
                  type="text"
                  className="font-mono"
                  placeholder="e.g. 5432"
                  value={portsToText(svc.ports)}
                  onChange={(e) => updateService(i, { ports: textToPorts(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`svc-env-${i}`} className="text-xs">
                  Environment (one KEY=value per line)
                </Label>
                <Textarea
                  id={`svc-env-${i}`}
                  rows={2}
                  className="font-mono text-xs"
                  placeholder="POSTGRES_PASSWORD=…"
                  value={envToText(svc.env)}
                  onChange={(e) => updateService(i, { env: textToEnv(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`svc-paths-${i}`} className="text-xs">
                  Writable paths (comma-separated, absolute)
                </Label>
                <Input
                  id={`svc-paths-${i}`}
                  type="text"
                  className="font-mono"
                  placeholder="/var/lib/postgresql/data"
                  value={pathsToText(svc.writablePaths)}
                  onChange={(e) =>
                    updateService(i, { writablePaths: textToPaths(e.target.value) })
                  }
                />
              </div>
            </div>
          ))
        )}

        {/* TASK-159 — proven starter examples (NOT an exhaustive list). One click
            drops the descriptor (digest-pinned image + the writable paths it needs)
            into a new row. Each service sidecar inherits the runner's locked posture
            (read-only root filesystem), so it must declare a writable path for every
            dir the image scribbles into — data dir, /tmp, caches. Bring your own
            with the Compose paste above; these are just a running start. */}
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
          <div className="flex flex-col gap-0.5">
            <Label className="text-xs">Start from an example</Label>
            <p className="text-xs text-muted-foreground">
              A couple of services we’ve proven on a real cluster — examples, not an
              exhaustive list. Each one already declares the writable paths it needs.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {STARTER_SERVICE_EXAMPLES.map((ex) => (
              <Button
                key={ex.label}
                type="button"
                variant="outline"
                size="sm"
                title={ex.description}
                onClick={() =>
                  // Deep-copy so two clicks of the same chip don't alias the
                  // shared constant's nested arrays/record across form rows.
                  onChange([
                    ...services,
                    {
                      ...ex.service,
                      ports: [...ex.service.ports],
                      env: { ...ex.service.env },
                      writablePaths: [...ex.service.writablePaths],
                    },
                  ])
                }
              >
                {ex.label}
              </Button>
            ))}
          </div>
        </div>

        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...services, emptyServiceRow()])}
          >
            Add service
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

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
  /**
   * Per-row client_secret values (keyed by row index). These are LOCAL state —
   * they are NEVER stored on CredentialSlotRow, NEVER flow into capabilitiesFromForm,
   * and NEVER land on the connector record. On save they are written to the vault
   * and only the resulting ref (`clientSecretRef`) is placed on the slot row.
   */
  const [oauthClientSecrets, setOauthClientSecrets] = useState<
    Record<number, string>
  >({});

  // The route bundle this variant targets (TASK-129): the admin variant curates
  // via `/admin/connectors`; the user variant authors via the locked-down
  // `/settings/connectors` (owner forced, visibility forced private, admin-only
  // fields rejected server-side, catalog/shared read-only).
  const base: ConnectorRouteBase = isAdmin
    ? '/admin/connectors'
    : '/settings/connectors';

  // (Re)load the form each time the dialog opens. For edit, fetch the full
  // connector so the mechanism + capabilities round-trip; fall back to the
  // summary subset if the fetch fails (mechanism stays at the default).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setBusy(false);
    setOauthClientSecrets({});
    if (target === 'new') {
      setForm(emptyConnectorForm());
      return;
    }
    setForm({ ...emptyConnectorForm(), ...summaryToForm(target) });
    getConnector(target.id, base)
      .then((full) => {
        if (!cancelled) setForm(formFromConnector(full));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, base]);

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

    // --- oauth client_secret persistence ------------------------------------
    // For each oauth slot that has a newly-entered client_secret: write the
    // secret to the vault and attach the resulting ref to the slot row.
    // The raw secret MUST NOT flow into capabilitiesFromForm — only the ref.
    //
    // NOTE: A pinned client_secret stored at user-scope (personal keyMode) is
    // only resolvable by the connector owner. A team member connecting a team
    // agent with a pinned client needs the connector at workspace keyMode (global
    // secret). DCR (blank client) avoids this entirely. This is a documented
    // follow-up; not handled here.
    let updatedSlots = form.credentialSlots;
    try {
      const slotPatches: Record<number, { clientSecretRef: string }> = {};
      for (const [idxStr, secret] of Object.entries(oauthClientSecrets)) {
        const idx = Number(idxStr);
        const row = form.credentialSlots[idx];
        if (!row || row.kind !== 'oauth' || !secret.trim()) continue;
        const destination = {
          kind: 'account' as const,
          service: connectorId,
          slot: 'oauth-client-secret',
        };
        const scope =
          form.keyMode === 'workspace'
            ? ({ scope: 'global' as const, ownerId: null })
            : ({ scope: 'user' as const, ownerId: null });
        await setDestinationCredential({
          destination,
          slot: { kind: 'api-key' },
          scope,
          payload: secret,
        });
        slotPatches[idx] = {
          clientSecretRef: refForDestination(destination),
        };
      }
      // Apply clientSecretRef patches. Do this outside the loop so we mutate the
      // slot array once (avoids multiple setForm calls racing with each other).
      if (Object.keys(slotPatches).length > 0) {
        updatedSlots = form.credentialSlots.map((row, idx) =>
          slotPatches[idx] ? { ...row, ...slotPatches[idx] } : row,
        );
      }
    } catch (err) {
      setError(
        `Failed to save OAuth client secret: ${err instanceof Error ? err.message : String(err)}`,
      );
      setBusy(false);
      return;
    }
    // Build capabilities from the slot list that now carries clientSecretRefs (not raw
    // secrets). The raw secrets are in oauthClientSecrets (local state only) and never
    // reach the connector body.
    const formWithSecretRefs: ConnectorFormState = {
      ...form,
      credentialSlots: updatedSlots,
    };

    const body = {
      connectorId,
      name: form.name.trim(),
      description: form.description,
      usageNote: form.usageNote,
      keyMode: form.keyMode,
      visibility,
      defaultAttached,
      capabilities: capabilitiesFromForm(formWithSecretRefs),
    };
    try {
      if (target === 'new') {
        await createConnector(body, base);
      } else {
        await patchConnector(target.id, body, base);
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
  const removeSlot = (i: number) => {
    setForm((f) => ({
      ...f,
      credentialSlots: f.credentialSlots.filter((_, idx) => idx !== i),
    }));
    // Re-key oauthClientSecrets after removal: drop the removed index and shift
    // all higher indexes down by one so they stay in sync with the new row order.
    setOauthClientSecrets((prev) => {
      const next: Record<number, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        const ki = Number(k);
        if (ki === i) continue; // dropped
        if (ki > i) next[ki - 1] = v; // shifted
        else next[ki] = v;
      }
      return next;
    });
  };
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
                form.credentialSlots.map((row, i) => {
                  // Derive the list of MCP server names available for an oauth
                  // slot's `server` field. For an MCP connector, the leading
                  // server name may not yet be in baseCapabilities (it's being
                  // authored), so we derive it from the form fields.
                  const existingServerNames = form.baseCapabilities.mcpServers.map(
                    (s) => s.name,
                  );
                  const leadingServerName =
                    form.mechanism === 'mcp'
                      ? (form.baseCapabilities.mcpServers[0]?.name ??
                        (form.connectorId || connectorIdFromName(form.name)))
                      : undefined;
                  const serverOptions = leadingServerName
                    ? [
                        leadingServerName,
                        ...existingServerNames.filter((n) => n !== leadingServerName),
                      ]
                    : existingServerNames;

                  return (
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

                      {/* Slot type toggle — api-key (default) or oauth. */}
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs">Type</Label>
                        <ToggleGroup
                          type="single"
                          variant="outline"
                          value={row.kind}
                          onValueChange={(v) => {
                            if (v) updateSlot(i, { kind: v as 'api-key' | 'oauth' });
                          }}
                          className="justify-start"
                        >
                          <ToggleGroupItem value="api-key" className="px-3 text-xs">
                            API key
                          </ToggleGroupItem>
                          <ToggleGroupItem value="oauth" className="px-3 text-xs">
                            OAuth
                          </ToggleGroupItem>
                        </ToggleGroup>
                      </div>

                      {row.kind === 'oauth' ? (
                        /* ---- OAuth slot fields ---- */
                        <>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`slot-name-${i}`} className="text-xs">
                              Machine name
                            </Label>
                            <Input
                              id={`slot-name-${i}`}
                              type="text"
                              className="font-mono"
                              placeholder="e.g. GITHUB_OAUTH"
                              value={row.slot}
                              onChange={(e) => updateSlot(i, { slot: e.target.value })}
                            />
                          </div>

                          {/* Server select */}
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`slot-server-${i}`} className="text-xs">
                              MCP server
                            </Label>
                            {serverOptions.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                Add an MCP server (http) above first — an OAuth slot
                                authorizes against its URL.
                              </p>
                            ) : (
                              <Select
                                value={row.server ?? ''}
                                onValueChange={(v) => updateSlot(i, { server: v })}
                              >
                                <SelectTrigger id={`slot-server-${i}`}>
                                  <SelectValue placeholder="Pick a server" />
                                </SelectTrigger>
                                <SelectContent>
                                  {serverOptions.map((name) => (
                                    <SelectItem key={name} value={name}>
                                      {name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </div>

                          {/* Scopes */}
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`slot-scopes-${i}`} className="text-xs">
                              Scopes (comma-separated)
                            </Label>
                            <Input
                              id={`slot-scopes-${i}`}
                              type="text"
                              placeholder="e.g. read, write"
                              value={row.scopes ?? ''}
                              onChange={(e) => updateSlot(i, { scopes: e.target.value })}
                            />
                          </div>

                          {/* Advanced — pinned client id/secret (optional, DCR preferred). */}
                          <Collapsible>
                            <CollapsibleTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="flex w-full items-center justify-between px-0 text-xs text-muted-foreground"
                                aria-label="Advanced — custom OAuth client (optional)"
                              >
                                <span>Advanced — custom OAuth client (optional)</span>
                                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="flex flex-col gap-2 pt-2">
                              <p className="text-xs text-muted-foreground">
                                Leave blank to register automatically (recommended).
                                Fill these in only if the service doesn't support
                                automatic registration.
                              </p>
                              <div className="flex flex-col gap-1.5">
                                <Label
                                  htmlFor={`slot-clientid-${i}`}
                                  className="text-xs"
                                >
                                  Client ID
                                </Label>
                                <Input
                                  id={`slot-clientid-${i}`}
                                  type="text"
                                  placeholder="optional"
                                  value={row.clientId ?? ''}
                                  onChange={(e) =>
                                    updateSlot(i, { clientId: e.target.value })
                                  }
                                />
                              </div>
                              <div className="flex flex-col gap-1.5">
                                <Label
                                  htmlFor={`slot-clientsecret-${i}`}
                                  className="text-xs"
                                >
                                  Client secret
                                </Label>
                                <Input
                                  id={`slot-clientsecret-${i}`}
                                  type="password"
                                  placeholder="optional"
                                  value={oauthClientSecrets[i] ?? ''}
                                  onChange={(e) =>
                                    setOauthClientSecrets((prev) => ({
                                      ...prev,
                                      [i]: e.target.value,
                                    }))
                                  }
                                />
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        </>
                      ) : (
                        /* ---- API key slot fields (unchanged) ---- */
                        <>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`slot-desc-${i}`} className="text-xs">
                              Label (what it is)
                            </Label>
                            <Input
                              id={`slot-desc-${i}`}
                              type="text"
                              placeholder="e.g. Personal access token"
                              value={row.description}
                              onChange={(e) =>
                                updateSlot(i, { description: e.target.value })
                              }
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
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Services (service bundle) — independent of the mechanism choice. */}
          <ServicesSection
            services={form.services}
            onChange={(services) => setForm((f) => ({ ...f, services }))}
          />

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
