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
  myCredentials,
  setDestinationCredential,
  clearDestinationCredential,
  type CredentialMeta,
} from '@/lib/credentials';
import { getAccountUsage } from '@/lib/connections';

const SKILL_REF = /^skill:([^:]+):(.+)$/;
const ACCOUNT_REF = /^account:(.+)$/;
// Client-side friendly early validation. SUBSET-or-equal of the server's account
// service grammar (credentials-admin-routes DestinationSchema) so a slug that
// passes here always passes there — never a superset (the mistakes.md rule).
const ACCOUNT_SERVICE_RE = /^[a-z][a-z0-9-]{0,63}$/;

type ParsedRef =
  | { shape: 'account'; service: string }
  | { shape: 'skill'; skillId: string; slot: string }
  | { shape: 'other'; raw: string };

function parseRef(ref: string): ParsedRef {
  const acct = ref.match(ACCOUNT_REF);
  if (acct) return { shape: 'account', service: acct[1]! };
  const skill = ref.match(SKILL_REF);
  if (skill) return { shape: 'skill', skillId: skill[1]!, slot: skill[2]! };
  return { shape: 'other', raw: ref };
}

export function KeysTab() {
  const [creds, setCreds] = useState<CredentialMeta[] | null>(null);
  const [usage, setUsage] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    myCredentials
      .list()
      .then(setCreds)
      .catch((e: unknown) => setError(String(e)));
    // Best-effort: the "used by" hint degrades to the service name if usage
    // can't be loaded — it must never block the keys list from rendering.
    getAccountUsage()
      .then(setUsage)
      .catch(() => setUsage({}));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // --- account (service-keyed) writes ------------------------------------
  const addAccountKey = async (service: string, payload: string) => {
    try {
      await setDestinationCredential({
        destination: { kind: 'account', service },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null }, // server forces ownerId = actor.id
        payload,
      });
      load();
    } catch (e: unknown) {
      setError(String(e));
    }
  };
  const removeAccountKey = async (service: string) => {
    try {
      await clearDestinationCredential({
        destination: { kind: 'account', service },
        scope: { scope: 'user', ownerId: null },
      });
      load();
    } catch (e: unknown) {
      setError(String(e));
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
      setError(String(e));
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
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">My keys</h3>
          <p className="text-xs text-muted-foreground">Shared across all your agents.</p>
        </div>
        <AddByServiceSheet onSave={addAccountKey} />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
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
            return (
              <div key={c.ref} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex flex-1 min-w-0 flex-col">
                  <span className="truncate text-sm text-foreground">{parsed.service}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    used by: {usedBy}
                  </span>
                </span>
                <span className="text-xs tracking-widest text-muted-foreground">••••••</span>
                <Badge variant="secondary">set</Badge>
                <ReplaceSheet
                  title={`Replace ${parsed.service} key`}
                  onSave={(p) => addAccountKey(parsed.service, p)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAccountKey(parsed.service)}
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
          // user-managed from this surface.
          return (
            <div key={c.ref} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex flex-1 min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{parsed.raw}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  used by: {parsed.raw}
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

/** "Add a key by service" (design P2): enter a service slug + value to create a
 *  shared `account:<service>` vault entry, even before any skill prompts. */
function AddByServiceSheet({
  onSave,
}: {
  onSave: (service: string, payload: string) => Promise<void>;
}) {
  const [service, setService] = useState('');
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const serviceValid = ACCOUNT_SERVICE_RE.test(service);
  const invalid = service.length > 0 && !serviceValid;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm">Add a key</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add a key by service</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex flex-col gap-3">
          <Label htmlFor="add-key-service">Service</Label>
          <Input
            id="add-key-service"
            value={service}
            aria-invalid={invalid}
            onChange={(e) => setService(e.target.value.trim())}
            placeholder="e.g. linear"
          />
          {invalid && (
            <p className="text-[11px] text-destructive">
              Use a lowercase service name (letters, digits, hyphens).
            </p>
          )}
          <Label htmlFor="add-key-value">Value</Label>
          <Input
            id="add-key-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Secret value"
          />
          <Button
            disabled={!serviceValid || value.length === 0}
            onClick={async () => {
              await onSave(service, value);
              setOpen(false);
              setService('');
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
