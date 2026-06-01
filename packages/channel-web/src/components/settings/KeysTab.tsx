/**
 * KeysTab — the Settings "Keys" surface: the user's own credential vault,
 * shared across all their agents (design P2/P3/P6, decision #13).
 *
 * Two row shapes coexist:
 *   - SERVICE-KEYED ("account:<service>", TASK-43): the vault entry any skill
 *     whose slot declares `account: <service>` binds to automatically. The
 *     "used by" hint names every skill that references the service (derived
 *     server-side from skills:list — getAccountUsage). Revoking pulls the
 *     credential out from under all of them (one source of truth — invariant #4).
 *     A user can "add a key by service" here even before any skill prompts.
 *   - PER-SLOT ("skill:<id>:<slot>", TASK-42, back-compat): the key the card
 *     configured for one skill slot.
 *
 * Security: `myCredentials.list()` returns metadata only (no secret bytes); the
 * secret never reaches the client on read. Writes reuse the existing
 * `/settings/destinations/:kind/credential` route, which server-forces the user
 * scope + owner id and independently re-validates the destination. Refs and
 * service names are parsed for display only, never executed; they render
 * through React text nodes (auto-escaped).
 */
import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  myCredentials,
  setDestinationCredential,
  clearDestinationCredential,
  type CredentialMeta,
} from '@/lib/credentials';
import { getAccountUsage } from '@/lib/connections';
import {
  listConnectors,
  getConnector,
  deriveCredentialPlan,
  mechanismHint,
  type ConnectorSummary,
  type Connector,
  type ConnectorCredentialPlanEntry,
  type MechanismHint,
} from '@/lib/connectors';

const SKILL_REF = /^skill:([^:]+):(.+)$/;
// TASK-124 — per-slot credential refs. An account ref is either the collapsed
// `account:<service>` (single-slot connector / standalone key) or the per-slot
// `account:<service>:<slot>` (multi-slot connector). Both `<service>` (lowercase
// slug) and `<slot>` (SCREAMING_SNAKE) carry no ':', so a single optional capture
// splits them unambiguously.
const ACCOUNT_REF = /^account:([a-z][a-z0-9-]*)(?::([A-Z][A-Z0-9_]*))?$/;

type ParsedRef =
  | { shape: 'account'; service: string; slot?: string }
  | { shape: 'skill'; skillId: string; slot: string }
  | { shape: 'other'; kind: string };

function parseRef(ref: string): ParsedRef {
  const acct = ref.match(ACCOUNT_REF);
  if (acct) {
    return acct[2] !== undefined
      ? { shape: 'account', service: acct[1]!, slot: acct[2] }
      : { shape: 'account', service: acct[1]! };
  }
  const skill = ref.match(SKILL_REF);
  if (skill) return { shape: 'skill', skillId: skill[1]!, slot: skill[2]! };
  // Unknown ref shape (provider/mcp/routine/…). Keep ONLY the kind segment for
  // a friendly label — never surface the raw `kind:value` to the user (the
  // `value` half can be an internal id/slug that means nothing to a human).
  const kind = ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : ref;
  return { shape: 'other', kind };
}

/** Friendly nouns for the credential refs this surface doesn't manage. A ref
 *  shape we don't recognize still reads as a calm human label, never a raw
 *  `kind:value` slug. */
const OTHER_KIND_LABEL: Record<string, string> = {
  provider: 'Model provider',
  mcp: 'Connector',
  routine: 'Scheduled task',
};
function otherKindLabel(kind: string): string {
  // `Object.hasOwn` guards against a kind segment that collides with a
  // prototype key (e.g. `toString`, `__proto__`) returning a non-string.
  return Object.hasOwn(OTHER_KIND_LABEL, kind) ? OTHER_KIND_LABEL[kind]! : 'Other credential';
}

/** A humane error string: an Error's own message, or a stringified fallback.
 *  Mirrors the sibling ConnectorsTab / ConnectorConnectDialog idiom — keeps the
 *  raw `[object Object]` of `String(someErrorObject)` off the user's screen. */
function humanError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Normalize a free-typed, human service NAME into the `account:<service>`
 *  slug the vault stores. Guarantees the result either satisfies the server's
 *  grammar (`/^[a-z][a-z0-9-]{0,63}$/`, credentials-admin-routes) or is the
 *  empty string — so the UI never has to surface slug-grammar rules to the
 *  user. "My Service!" → "my-service"; "  " → "". */
function toServiceSlug(input: string): string {
  const hyphenated = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics → one hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
  // The grammar requires a LEADING letter; drop any leading digits/hyphens.
  const leadingTrimmed = hyphenated.replace(/^[^a-z]+/, '');
  return leadingTrimmed.slice(0, 64).replace(/-+$/g, '');
}

export function KeysTab() {
  const [creds, setCreds] = useState<CredentialMeta[] | null>(null);
  const [usage, setUsage] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  // The user's existing connectors — the "Add a key" Service dropdown is keyed
  // off them (TASK-132). Metadata only (no capabilities); the full record loads
  // on demand when a connector is picked. Best-effort: a connector-list failure
  // leaves the dropdown with just the "Custom…" fallback (today's flow).
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);

  const load = useCallback(() => {
    setError(null);
    myCredentials
      .list()
      .then(setCreds)
      .catch((e: unknown) => setError(humanError(e)));
    // Best-effort: the "used by" hint degrades to the service name if usage
    // can't be loaded — it must never block the keys list from rendering.
    getAccountUsage()
      .then(setUsage)
      .catch(() => setUsage({}));
    // Best-effort: the Service dropdown degrades to Custom-only on a list failure.
    listConnectors()
      .then(setConnectors)
      .catch(() => setConnectors([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // --- account (service-keyed) writes ------------------------------------
  // TASK-124 — `slot` is optional: a per-slot account ref
  // (`account:<service>:<slot>`, a multi-slot connector) threads it through so
  // the Replace/Remove writes address the SAME row, never collapsing it back to
  // `account:<service>`. The free-typed "Add a key" path always omits it (the
  // standalone single-key case).
  const addAccountKey = async (service: string, payload: string, slot?: string) => {
    try {
      await setDestinationCredential({
        destination: { kind: 'account', service, ...(slot !== undefined ? { slot } : {}) },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null }, // server forces ownerId = actor.id
        payload,
      });
      load();
    } catch (e: unknown) {
      setError(humanError(e));
    }
  };
  const removeAccountKey = async (service: string, slot?: string) => {
    try {
      await clearDestinationCredential({
        destination: { kind: 'account', service, ...(slot !== undefined ? { slot } : {}) },
        scope: { scope: 'user', ownerId: null },
      });
      load();
    } catch (e: unknown) {
      setError(humanError(e));
    }
  };

  // --- per-slot (skill) writes (back-compat) -----------------------------
  const replaceSkillKey = async (skillId: string, slot: string, payload: string) => {
    try {
      await setDestinationCredential({
        destination: { kind: 'skill-slot', skillId, slot },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload,
      });
      load();
    } catch (e: unknown) {
      setError(humanError(e));
    }
  };
  const removeSkillKey = async (skillId: string, slot: string) => {
    try {
      await clearDestinationCredential({
        destination: { kind: 'skill-slot', skillId, slot },
        scope: { scope: 'user', ownerId: null },
      });
      load();
    } catch (e: unknown) {
      setError(humanError(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">My keys</h3>
          <p className="text-xs text-muted-foreground">Shared across all your agents.</p>
        </div>
        <AddByServiceSheet connectors={connectors} onSave={addAccountKey} />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            <span className="block">
              We couldn't save your key. Check it's correct and try again — your
              admin can help if it keeps failing.
            </span>
            <span className="mt-1 block text-xs opacity-80">{error}</span>
          </AlertDescription>
        </Alert>
      )}
      <Card className="divide-y divide-border">
        {creds === null && !error && (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        )}
        {creds?.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">No keys yet.</div>
        )}
        {creds?.map((c) => {
          const parsed = parseRef(c.ref);
          if (parsed.shape === 'account') {
            const referencing = usage[parsed.service] ?? [];
            const usedBy = referencing.length > 0 ? referencing.join(', ') : parsed.service;
            // TASK-124 — a per-slot ref shows the service with its slot name as a
            // mono subtitle (`github · GITHUB_TOKEN`); a collapsed ref shows just
            // the service.
            const label =
              parsed.slot !== undefined ? `${parsed.service} · ${parsed.slot}` : parsed.service;
            return (
              <div key={c.ref} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex flex-1 min-w-0 flex-col">
                  <span className="truncate text-sm text-foreground">{label}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    used by: {usedBy}
                  </span>
                </span>
                <span className="text-xs tracking-widest text-muted-foreground">••••••</span>
                <Badge variant="secondary">set</Badge>
                <ReplaceSheet
                  title={`Replace ${label} key`}
                  onSave={(p) => addAccountKey(parsed.service, p, parsed.slot)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAccountKey(parsed.service, parsed.slot)}
                >
                  Remove
                </Button>
              </div>
            );
          }
          if (parsed.shape === 'skill') {
            return (
              <div key={c.ref} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex flex-1 min-w-0 flex-col">
                  <span className="truncate text-sm text-foreground">{parsed.skillId}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    used by: {parsed.skillId} · {parsed.slot}
                  </span>
                </span>
                <span className="text-xs tracking-widest text-muted-foreground">••••••</span>
                <Badge variant="secondary">set</Badge>
                <ReplaceSheet
                  title="Replace key"
                  onSave={(p) => replaceSkillKey(parsed.skillId, parsed.slot, p)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSkillKey(parsed.skillId, parsed.slot)}
                >
                  Remove
                </Button>
              </div>
            );
          }
          // Unknown ref shape (provider/mcp/routine) — display-only, not
          // user-managed from this surface. Render a friendly kind label, never
          // the raw `kind:value` ref (that internal id means nothing to a user).
          return (
            <div key={c.ref} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex flex-1 min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">
                  {otherKindLabel(parsed.kind)}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  Managed elsewhere
                </span>
              </span>
              <span className="text-xs tracking-widest text-muted-foreground">••••••</span>
              <Badge variant="secondary">set</Badge>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// The sentinel Select value for the free-text "Custom…" fallback — distinct from
// any real connector id (a connector id is a lowercase slug, never starts with
// `__`), so it can never collide with a connector in the dropdown.
const CUSTOM_SERVICE = '__custom__';

/**
 * "Add a key" (design P2 / TASK-132): connector-aware service picker.
 *
 * The Service field is a dropdown of the user's existing connectors plus a
 * "Custom…" free-text fallback:
 *   - **Custom…** → free-type a service name (slugified to `account:<service>`)
 *     + a single Value (today's behaviour, unchanged).
 *   - **A connector** → reveals its declared credential slots via the TASK-124
 *     derivation: a single-slot connector collapses to one Value field; a
 *     multi-slot connector shows one labeled field per slot. Each per-slot field
 *     is labeled with the slot's `description` and carries `<MACHINE_NAME> ·
 *     <mechanism hint>` as mono subtext (the hint is truthful per mechanism —
 *     env var / header / request auth, {@link mechanismHint}).
 *
 * Per-slot WRITES go through the SAME `addAccountKey(service, payload, slot?)` the
 * vault list uses, building the destination from the plan's STRUCTURED `service`
 * + `slotTag` (NOT by parsing the `:`-bearing ref — a per-slot ref would slice
 * into an invalid service; the TASK-124 contract). A single-slot connector omits
 * `slotTag`, keeping the collapsed `account:<service>` ref (back-compat).
 */
function AddByServiceSheet({
  connectors,
  onSave,
}: {
  connectors: ConnectorSummary[];
  onSave: (service: string, payload: string, slot?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // The selected Service: a connector id, or CUSTOM_SERVICE for the free-text
  // fallback. Defaults to Custom… so a user with no connectors meets exactly
  // today's flow (one extra, pre-selected dropdown click).
  const [selected, setSelected] = useState<string>(CUSTOM_SERVICE);

  const reset = useCallback(() => {
    setSelected(CUSTOM_SERVICE);
  }, []);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <SheetTrigger asChild>
        <Button size="sm">Add a key</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add a key</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex flex-col gap-3">
          <Label htmlFor="add-key-service">Which service is this key for?</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id="add-key-service">
              <SelectValue placeholder="Choose a service" />
            </SelectTrigger>
            <SelectContent>
              {connectors.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_SERVICE}>Custom…</SelectItem>
            </SelectContent>
          </Select>
          {selected === CUSTOM_SERVICE ? (
            <CustomServiceFields
              onSave={async (service, value) => {
                await onSave(service, value);
                setOpen(false);
                reset();
              }}
            />
          ) : (
            <ConnectorSlotFields
              connectorId={selected}
              onSave={onSave}
              onDone={() => {
                setOpen(false);
                reset();
              }}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The "Custom…" branch — today's free-text service name + single Value. The
 *  friendly name is slugified on save ({@link toServiceSlug}) so the user never
 *  sees slug-grammar rules; Save is enabled iff that slug is non-empty AND a
 *  value is present. */
function CustomServiceFields({
  onSave,
}: {
  onSave: (service: string, value: string) => Promise<void>;
}) {
  const [service, setService] = useState('');
  const [value, setValue] = useState('');
  const slug = toServiceSlug(service);
  const canSave = slug.length > 0 && value.length > 0;
  return (
    <>
      <Label htmlFor="add-key-custom-name">Service name</Label>
      <Input
        id="add-key-custom-name"
        value={service}
        onChange={(e) => setService(e.target.value)}
        placeholder="e.g. Linear, GitHub, Notion"
      />
      <Label htmlFor="add-key-value">Value</Label>
      <Input
        id="add-key-value"
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Secret value"
      />
      <Button disabled={!canSave} onClick={() => void onSave(slug, value)}>
        Save
      </Button>
    </>
  );
}

/**
 * The connector branch — loads the full connector record on demand (the list is
 * metadata-only) and renders one labeled key field per credential slot derived
 * by {@link deriveCredentialPlan}. A single-slot connector collapses to one
 * field; a multi-slot connector shows one per slot. Each field carries the slot's
 * `description` as its label and `<MACHINE_NAME> · <mechanism hint>` as mono
 * subtext. Saving writes every field that has a value, threading the plan's
 * structured `slotTag` so a multi-slot write lands in its distinct row.
 */
function ConnectorSlotFields({
  connectorId,
  onSave,
  onDone,
}: {
  connectorId: string;
  onSave: (service: string, payload: string, slot?: string) => Promise<void>;
  onDone: () => void;
}) {
  const [connector, setConnector] = useState<Connector | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // One pending secret value per plan slot (keyed by the capability slot name).
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setConnector(null);
    setLoadError(null);
    setValues({});
    getConnector(connectorId)
      .then((c) => {
        if (!cancelled) setConnector(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(humanError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connectorId]);

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }
  if (connector === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const plan = deriveCredentialPlan(connector);
  if (plan.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This service needs no key — your assistant can already reach it.
      </p>
    );
  }

  const hint = mechanismHint(connector);
  // A slot's friendly label is its declared `description`; the mono subtext pairs
  // the machine name with the truthful mechanism hint.
  const slotMeta = (slotName: string) =>
    connector.capabilities.credentials.find((s) => s.slot === slotName);
  const canSave = plan.some((entry) => (values[entry.slot] ?? '').length > 0);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Write every slot the user filled in. Structured service + slotTag from
      // the plan — never a parsed ref (TASK-124).
      for (const entry of plan) {
        const value = values[entry.slot] ?? '';
        if (value.length === 0) continue;
        await onSave(entry.service, value, entry.slotTag);
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {plan.map((entry) => {
        // exactOptionalPropertyTypes: only pass `description` when the slot
        // declares one (an absent description must not become `undefined`).
        const description = slotMeta(entry.slot)?.description;
        return (
          <PerSlotKeyField
            key={entry.slot}
            entry={entry}
            {...(description !== undefined ? { description } : {})}
            hint={hint}
            value={values[entry.slot] ?? ''}
            onChange={(v) => setValues((prev) => ({ ...prev, [entry.slot]: v }))}
          />
        );
      })}
      <Button disabled={!canSave || saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}

/** One labeled key field for a connector credential slot (TASK-132). Label = the
 *  slot's `description` (a calm fallback when absent); subtext = `<MACHINE_NAME> ·
 *  <mechanism hint>` in mono. Value is a password input — the secret is never
 *  rendered. */
function PerSlotKeyField({
  entry,
  description,
  hint,
  value,
  onChange,
}: {
  entry: ConnectorCredentialPlanEntry;
  description?: string;
  hint: MechanismHint;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = `add-key-slot-${entry.slot}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{description || 'API key'}</Label>
      <span className="font-mono text-[11px] text-muted-foreground">
        {entry.slot} · {hint}
      </span>
      <Input
        id={inputId}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Secret value"
      />
    </div>
  );
}

function ReplaceSheet({
  title,
  onSave,
}: {
  title: string;
  onSave: (payload: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm">
          Replace
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex flex-col gap-3">
          <Label htmlFor="replace-key-value">New value</Label>
          <Input
            id="replace-key-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="New value"
          />
          <Button
            disabled={value.length === 0}
            onClick={async () => {
              await onSave(value);
              setOpen(false);
              setValue('');
            }}
          >
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
