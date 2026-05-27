/**
 * KeysTab (TASK-42) — the Settings "Keys" surface: the user's own credential
 * vault, shared across all their agents. Lists each key masked, with a
 * "used by" hint derived by parsing the credential ref (`skill:<id>:<slot>`),
 * plus Replace (a Sheet over the existing destination write path) and Remove.
 *
 * This slice is PER-SLOT (keyed by the skill slot the card configured). The
 * service-keyed "add a key by service" flow is TASK-43's `account` vault — a
 * future addition to this same surface, not built here.
 *
 * Security: `myCredentials.list()` returns metadata only (no secret bytes); the
 * secret never reaches the client on read. Writes reuse the existing
 * `/settings/destinations/:kind/credential` route, which server-forces the
 * user scope + owner id. The ref is parsed for display only, never executed.
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

const SKILL_REF = /^skill:([^:]+):(.+)$/;

/** `skill:<id>:<slot>` → { usedBy: id, slot }. Other ref shapes → { usedBy: ref }. */
function parseRef(ref: string): { usedBy: string; slot: string | null } {
  const m = ref.match(SKILL_REF);
  return m ? { usedBy: m[1]!, slot: m[2]! } : { usedBy: ref, slot: null };
}

export function KeysTab() {
  const [creds, setCreds] = useState<CredentialMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    myCredentials
      .list()
      .then(setCreds)
      .catch((e: unknown) => setError(String(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const replace = async (ref: string, payload: string) => {
    const m = ref.match(SKILL_REF);
    if (!m) return; // only skill-slot destinations are user-replaceable in this slice
    try {
      await setDestinationCredential({
        destination: { kind: 'skill-slot', skillId: m[1]!, slot: m[2]! },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null }, // server forces ownerId = actor.id
        payload,
      });
      load();
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  const remove = async (ref: string) => {
    const m = ref.match(SKILL_REF);
    if (!m) return;
    try {
      await clearDestinationCredential({
        destination: { kind: 'skill-slot', skillId: m[1]!, slot: m[2]! },
        scope: { scope: 'user', ownerId: null },
      });
      load();
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div>
        <h3 className="text-sm font-medium text-foreground">My keys</h3>
        <p className="text-xs text-muted-foreground">Shared across all your agents.</p>
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
          const { usedBy, slot } = parseRef(c.ref);
          const replaceable = slot !== null;
          return (
            <div key={c.ref} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex flex-1 min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{usedBy}</span>
                <span className="text-[11px] text-muted-foreground">
                  used by: {usedBy}
                  {slot ? ` · ${slot}` : ''}
                </span>
              </span>
              <span className="text-xs tracking-widest text-muted-foreground">••••••</span>
              <Badge variant="secondary">set</Badge>
              {replaceable && <ReplaceSheet onSave={(p) => replace(c.ref, p)} />}
              {replaceable && (
                <Button variant="ghost" size="sm" onClick={() => remove(c.ref)}>
                  Remove
                </Button>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function ReplaceSheet({ onSave }: { onSave: (payload: string) => Promise<void> }) {
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
          <SheetTitle>Replace key</SheetTitle>
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
