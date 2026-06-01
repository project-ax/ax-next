import { useState, type ReactElement } from 'react';
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
 *
 * - `kind: 'connector'` (TASK-94 host / TASK-112 UI) — "Connect <name>": the
 *   upfront authored-connector approval card. Same shape as the skill card (hosts
 *   + one field per slot + an authored banner + a packages line) but the SUBJECT
 *   is a connector. On Connect the card (1) writes each entered key straight to
 *   the host credential store under the connector's `account:<service>` vault row
 *   (service = the slot's `account` tag, else the connectorId — matching the host
 *   resolver's ref), (2) POSTs the decision to `/api/chat/permission-decision`
 *   with a `connectorId` subject — the host grant reuses the TASK-93 approved-caps
 *   wall — then (3) re-issues the pending turn via `continueAfterGrant()`.
 */
export function PermissionCard() {
  const { request } = usePermissionCardStore();
  const conversationId = useConversationId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every declared slot must have a non-empty value before Connect is enabled
  // (a slotless skill/connector is immediately connectable). `request === null`
  // short-circuits so the hook order stays stable even when the card is hidden.
  // The skill AND connector variants carry slots; the host variant is always
  // "fillable". A slot already in the user's shared vault (haveExisting) needs no
  // input — it counts as filled (JIT P2). Otherwise the user must type a value.
  const allSlotsFilled =
    request === null ||
    (request.kind !== 'skill' && request.kind !== 'connector') ||
    request.slots.every(
      (s) => s.haveExisting === true || (values[s.slot] ?? '').trim().length > 0,
    );

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
      // Route by destination kind (JIT P2): a slot tagged `account: <svc>` posts
      // to the shared `account:<service>` vault entry; an untagged slot keeps the
      // per-skill `skill-slot` destination. A slot already in the vault
      // (haveExisting) writes nothing — the key is already there.
      for (const s of request.slots) {
        if (s.haveExisting === true) continue; // already in the vault — nothing to write
        const payload = (values[s.slot] ?? '').trim();
        if (payload.length === 0) continue;
        const destination =
          s.account !== undefined
            ? ({ kind: 'account', service: s.account } as const)
            : ({ kind: 'skill-slot', skillId: request.skillId, slot: s.slot } as const);
        await setDestinationCredential({
          destination,
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
      // (TASK-36) apply the grant: attach the skill + retire the warm session.
      // No secret on this POST — only domain ids. CSRF-guarded via x-requested-with.
      //
      // FIX 1 (TOCTOU guard): include `shown` — what the card displayed at
      // render time. The orchestrator intersects this with the re-resolved
      // current proposalDelta so an agent that widens its draft between card
      // render and user click can never grant caps the user never saw.
      const shown = {
        hosts: request.hosts,
        slots: request.slots.map((s) => s.slot),
        npm: request.packages?.npm ?? [],
        pypi: request.packages?.pypi ?? [],
      };
      const resp = await fetch('/api/chat/permission-decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ conversationId, skillId: request.skillId, shown }),
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

  async function approveConnector(): Promise<void> {
    if (
      busy ||
      request === null ||
      request.kind !== 'connector' ||
      conversationId === null ||
      !allSlotsFilled
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Write each entered key straight to the host credential store under the
      // connector's `account:<service>` vault row. service = the slot's `account`
      // tag when present, else the connectorId — the SAME ref the connector
      // resolver reads (`account:<slot.account ?? connectorId>`), so the approved
      // key lands in the row the next spawn will pick up. A slot already in the
      // vault (haveExisting) writes nothing — the key is already there. No secret
      // crosses the decision POST below (§10).
      for (const s of request.slots) {
        if (s.haveExisting === true) continue;
        const payload = (values[s.slot] ?? '').trim();
        if (payload.length === 0) continue;
        await setDestinationCredential({
          destination: { kind: 'account', service: s.account ?? request.connectorId },
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
      // Apply the grant with the connectorId SUBJECT — the host reuses the
      // TASK-93 approved-caps wall (connectorId subject) + flips the draft active.
      // The `shown` TOCTOU guard mirrors the skill card: the orchestrator
      // intersects this with the re-resolved current proposal so a draft widened
      // between render and click can never grant caps the user never saw.
      const shown = {
        hosts: request.hosts,
        slots: request.slots.map((s) => s.slot),
        npm: request.packages?.npm ?? [],
        pypi: request.packages?.pypi ?? [],
      };
      const resp = await fetch('/api/chat/permission-decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ conversationId, connectorId: request.connectorId, shown }),
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`connect failed: ${resp.status}`);
      close();
      // Re-issue the pending turn → fresh re-spawn + resume → the agent answers
      // with the now-active connector's reach present.
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

  // Shared reach renderer for the skill + connector cards — both surface the
  // same hosts/slots/packages shape (a connector IS the capability surface lifted
  // out of the skill). One source of truth for the reach markup so the two cards
  // can't drift. Closes over `values`/`setValues` for the slot inputs.
  type ReachSlot = {
    slot: string;
    kind: 'api-key';
    account?: string;
    haveExisting?: boolean;
  };
  function renderReach(
    hosts: string[],
    slots: ReachSlot[],
    packages: { npm: string[]; pypi: string[] } | undefined,
  ): ReactElement {
    return (
      <>
        {hosts.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">Will access</p>
            <div className="flex flex-wrap gap-1.5">
              {hosts.map((h) => (
                <Badge key={h} variant="secondary">
                  {h}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {slots.map((s) =>
          s.haveExisting === true ? (
            // (JIT P2) the user already has this service key in their shared
            // vault — offer it with one tap, no re-entry. No input, no POST.
            <div
              key={s.slot}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Badge variant="secondary">{s.account ?? s.slot}</Badge>
              <span>
                Using your existing{' '}
                {(s.account ?? s.slot).charAt(0).toUpperCase() +
                  (s.account ?? s.slot).slice(1)}{' '}
                key
              </span>
            </div>
          ) : (
            <div key={s.slot} className="grid gap-1.5">
              <Label htmlFor={`perm-cred-${s.slot}`}>{s.slot}</Label>
              <Input
                id={`perm-cred-${s.slot}`}
                type="password"
                autoComplete="off"
                value={values[s.slot] ?? ''}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [s.slot]: e.target.value }))
                }
              />
            </div>
          ),
        )}
        {packages != null &&
          (packages.npm.length > 0 || packages.pypi.length > 0) && (
            <p className="text-sm text-muted-foreground" data-testid="permission-packages">
              {packages.npm.length > 0 && (
                <>Installs npm packages → reaches <code>registry.npmjs.org</code>. </>
              )}
              {packages.pypi.length > 0 && (
                <>Installs Python packages → reaches <code>pypi.org</code>, <code>files.pythonhosted.org</code>.</>
              )}
            </p>
          )}
      </>
    );
  }

  if (request.kind === 'connector') {
    return (
      <Card className="mb-3" data-testid="permission-card-connector">
        <CardHeader>
          <CardTitle>Connect {request.name}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {request.authored === true && (
            <Alert>
              <AlertDescription>
                ⚠ This is a new connector your assistant just wrote. Approve the
                access below only if you expected it.
              </AlertDescription>
            </Alert>
          )}
          {renderReach(request.hosts, request.slots, request.packages)}
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
            onClick={() => void approveConnector()}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </CardFooter>
      </Card>
    );
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
        {renderReach(request.hosts, request.slots, request.packages)}
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
