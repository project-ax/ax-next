import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { setDestinationCredential } from '@/lib/credentials';
import {
  permissionCardActions,
  usePermissionCardStore,
} from '@/lib/permission-card-store';

/**
 * The ONE bundled approval card (JIT design §11.3, decision #6) — the open-mode
 * security boundary. Surfaced by a `chat:permission-request` SSE frame; shows
 * the hosts the skill reaches and one field per credential slot. The key never
 * touches the model or transcript: it posts straight to the host credential
 * store via the user-scoped destination route (`skill:<id>:<slot>`, §10).
 *
 * Half-wired this phase: Connect collects credentials + dismisses; it does not
 * yet allowlist hosts (TASK-37), attach the skill, or re-spawn/resume the turn
 * (TASK-36).
 */
export function PermissionCard() {
  const { request } = usePermissionCardStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request) return null;

  function close(): void {
    setValues({});
    setError(null);
    permissionCardActions.dismiss();
  }

  async function connect(): Promise<void> {
    if (busy || request === null) return;
    setBusy(true);
    setError(null);
    try {
      for (const { slot } of request.slots) {
        const payload = (values[slot] ?? '').trim();
        if (payload.length === 0) continue; // a slot may be left blank
        await setDestinationCredential({
          destination: { kind: 'skill-slot', skillId: request.skillId, slot },
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-3" data-testid="permission-card">
      <CardHeader>
        <CardTitle>Connect {request.skillId}</CardTitle>
        {request.description.length > 0 && (
          <CardDescription>{request.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {request.hosts.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">Will access</p>
            <div className="flex flex-wrap gap-1.5">
              {request.hosts.map((h) => (
                <Badge key={h} variant="secondary">
                  {h}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {request.slots.map(({ slot }) => (
          <div key={slot} className="grid gap-1.5">
            <Label htmlFor={`perm-cred-${slot}`}>{slot}</Label>
            <Input
              id={`perm-cred-${slot}`}
              type="password"
              autoComplete="off"
              value={values[slot] ?? ''}
              onChange={(e) =>
                setValues((v) => ({ ...v, [slot]: e.target.value }))
              }
            />
          </div>
        ))}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={close}>
          Not now
        </Button>
        <Button disabled={busy} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </CardFooter>
    </Card>
  );
}
