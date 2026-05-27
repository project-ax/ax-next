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
import { grantHost, setDestinationCredential } from '@/lib/credentials';
import {
  permissionCardActions,
  usePermissionCardStore,
} from '@/lib/permission-card-store';
import { resumeActions } from '@/lib/resume-actions';
import { useConversationId } from '@/lib/use-conversation-id';

/**
 * The ONE bundled approval card (JIT design §11.3/§6B, decision #6) — the
 * open-mode security boundary. Surfaced by a `chat:permission-request` SSE
 * frame. Two variants discriminated on `kind`:
 *
 * - `kind: 'skill'` (TASK-35/36) — "Connect <skill>": shows the hosts the skill
 *   reaches + one field per credential slot. On Connect the card (1) writes each
 *   entered key straight to the host credential store (TASK-35; never the model
 *   or transcript, §10), (2) POSTs the decision to
 *   `/api/chat/permission-decision` — which attaches the skill for the user and
 *   retires the conversation's warm session — then (3) re-issues the pending
 *   original turn via `resumeActions.continueAfterGrant()` so the conversation
 *   re-spawns + resumes and the agent answers with the skill present (TASK-36,
 *   design §7). Connect is gated on every declared slot being filled.
 *
 * - `kind: 'host'` (TASK-37) — "Allow access to <host>?": the reactive egress
 *   wall. Granting widens the LIVE session allowlist via `proxy:add-host` (the
 *   CSRF-gated /api/chat/allow-host route) — no re-spawn — so the next egress
 *   to that host succeeds. Carries no secret. "Always for this agent" performs
 *   the same LIVE grant as "Just this once" this phase; per-(user, agent)
 *   persistence is TASK-44, and seamless auto-retry is TASK-36.
 */
export function PermissionCard() {
  const { request } = usePermissionCardStore();
  const conversationId = useConversationId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every declared slot must have a non-empty value before Connect is enabled
  // (a slotless skill is immediately connectable). `request === null` short-
  // circuits so the hook order stays stable even when the card is hidden.
  // Only the skill variant has slots; the host variant is always "fillable".
  const allSlotsFilled =
    request === null ||
    request.kind !== 'skill' ||
    request.slots.every(({ slot }) => (values[slot] ?? '').trim().length > 0);

  if (!request) return null;

  function close(): void {
    setValues({});
    setError(null);
    permissionCardActions.dismiss();
  }

  async function connect(): Promise<void> {
    if (
      busy ||
      request === null ||
      request.kind !== 'skill' ||
      conversationId === null ||
      !allSlotsFilled
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // (TASK-35) write each entered key straight to the host credential store.
      for (const { slot } of request.slots) {
        const payload = (values[slot] ?? '').trim();
        if (payload.length === 0) continue;
        await setDestinationCredential({
          destination: { kind: 'skill-slot', skillId: request.skillId, slot },
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
      // (TASK-36) apply the grant: attach the skill + retire the warm session.
      // No secret on this POST — only domain ids. CSRF-guarded via x-requested-with.
      const resp = await fetch('/api/chat/permission-decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ conversationId, skillId: request.skillId }),
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`connect failed: ${resp.status}`);
      close();
      // (TASK-36) re-issue the pending original turn -> fresh re-spawn + resume
      // -> the agent answers, with the now-attached skill (design §7).
      resumeActions.continueAfterGrant();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function allow(persist: boolean): Promise<void> {
    if (busy || request === null || request.kind !== 'host') return;
    setBusy(true);
    setError(null);
    try {
      await grantHost({ sessionId: request.sessionId, host: request.host, persist });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (request.kind === 'host') {
    return (
      <Card className="mb-3" data-testid="permission-card-host">
        <CardHeader>
          <CardTitle>Allow access to {request.host}?</CardTitle>
          <CardDescription>
            Your assistant tried to reach a site it isn’t allowed to yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{request.host}</Badge>
          </div>
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
          <Button variant="outline" disabled={busy} onClick={() => void allow(true)}>
            Always for this agent
          </Button>
          <Button disabled={busy} onClick={() => void allow(false)}>
            {busy ? 'Allowing…' : 'Just this once'}
          </Button>
        </CardFooter>
      </Card>
    );
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
        {request.authored === true && (
          <Alert>
            <AlertDescription>
              ⚠ This is a new skill your assistant just wrote. Approve the access
              below only if you expected it.
            </AlertDescription>
          </Alert>
        )}
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
        <Button
          disabled={busy || !allSlotsFilled || conversationId === null}
          onClick={() => void connect()}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </CardFooter>
    </Card>
  );
}
