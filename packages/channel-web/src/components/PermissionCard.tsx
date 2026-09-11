/**
 * The JIT permission card — and why it is NOT a `Decision`.
 *
 * This question comes up every time someone reads both surfaces, so here is the
 * answer once, in the file, rather than in a PR description nobody re-reads
 * (TASK-232 / plan task AW-11 asked for exactly this).
 *
 * The two look alike. Both stop mid-turn, both put a card in the thread, both
 * have an approve and a decline. They are different things:
 *
 *   - This card is a **capability GRANT**. "May this agent ever reach
 *     `api.linear.app`?" It is durable, it is agent-scoped, and there is no
 *     recorded call behind it — approving does not run anything, it widens what
 *     the agent may do and then lets the turn continue via `regenerate()`.
 *
 *   - A `Decision` (`@ax/decisions`, rendered by `workspace/ApprovalCard.tsx`
 *     and `workspace/DecisionRow.tsx`) is an **outward ACTION**. "Shall THIS
 *     email go?" It is one-shot, it carries the verbatim call so approving can
 *     replay it byte for byte, and it is freshness-guarded so an approval given
 *     six hours later cannot act on a world that has since moved.
 *
 * Collapsing them would force every grant to carry a null `call`, a null
 * `freshness`, and an `approvedText` that cannot say what happened because
 * nothing happened — plus a resolution path (`regenerate()`) that shares no
 * code at all with the host replay. That is three lies and a switch statement in
 * exchange for one component.
 *
 * The `kind: 'action' | 'grant'` field on `Decision` stays, because a grant
 * raised THROUGH a policy hold is a real case and belongs on that row. This
 * card is not that case: it is fired by `chat:permission-request` from
 * @ax/skill-broker and the egress wall, mid-turn, with the agent still warm. It
 * is not migrated, and it should not be.
 */
import { useState, type ReactElement } from 'react';
import { TriangleAlert } from 'lucide-react';
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
import { humanizeId, humanizeSlotLabel } from '@/lib/humanize';
import {
  permissionCardActions,
  usePermissionCardStore,
} from '@/lib/permission-card-store';
import { HttpError, httpFetch, userFacingMessage } from '@/lib/http';
import { resumeActions } from '@/lib/resume-actions';
import { useConversationId } from '@/lib/use-conversation-id';
import type { Destination } from '@ax/credentials';

/**
 * One card slot row, as the WRITE paths read it. `service`/`slotTag` (TASK-124)
 * are the resolved vault-key tags the producer (orchestrator / skill-broker) set;
 * `account` is the legacy pre-TASK-124 field kept for back-compat with a card that
 * predates the new tags.
 */
interface CardSlot {
  slot: string;
  account?: string;
  service?: string;
  slotTag?: string;
}

/**
 * TASK-124 — build the account destination for a CONNECTOR slot. Prefer the
 * resolved `service`/`slotTag` (so a multi-slot connector hits its distinct
 * per-slot `account:<service>:<slot>` row); fall back to the legacy
 * `account ?? connectorId` collapsed shape for a card without the new tags.
 */
function accountDestinationForConnectorSlot(s: CardSlot, connectorId: string): Destination {
  const service = s.service ?? s.account ?? connectorId;
  return {
    kind: 'account',
    service,
    ...(s.slotTag !== undefined ? { slot: s.slotTag } : {}),
  };
}

/**
 * TASK-124 — build the destination for a SKILL-card slot. A connector-derived
 * slot carries `service` (always set by the producer) → the
 * `account:<service>[:<slot>]` vault row; a legacy slot with only `account` keeps
 * the collapsed account route; an untagged slot keeps the per-skill `skill-slot`
 * destination.
 */
function accountOrSkillDestination(s: CardSlot, skillId: string): Destination {
  if (s.service !== undefined) {
    return {
      kind: 'account',
      service: s.service,
      ...(s.slotTag !== undefined ? { slot: s.slotTag } : {}),
    };
  }
  if (s.account !== undefined) {
    return { kind: 'account', service: s.account };
  }
  return { kind: 'skill-slot', skillId, slot: s.slot };
}

/**
 * (A2) The reassurance line, shared by the skill and connector cards.
 *
 * `workspace/ApprovalCard.tsx` has said something like this for a while and it
 * is the reason that surface reads as trustworthy: it tells you what the button
 * does, that nothing has happened yet, and that the decision is reversible. The
 * grant card — the one that actually widens what an agent may do — said none of
 * it. Every clause here is true: the grant is durable, nothing is applied until
 * the click, and both halves are revocable in Settings (skills detach from the
 * Skills tab, hosts from Allowed sites).
 *
 * No jokes on this string. It is a security decision.
 */
const GRANT_REASSURANCE =
  'Connecting lets this agent do this from now on. Nothing happens until you ' +
  'choose, and you can change it later in Settings.';

/** (A6) Why the Connect button is disabled — it used to just sit there, greyed out. */
const SLOT_HINT = 'Add the key above to continue';

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
      // Route by destination kind: a connector-derived slot carries the resolved
      // `service` tag (TASK-124 — always set by the producers; = the slot's account
      // else the connector id) and, for a multi-slot connector, a `slotTag`, so it
      // posts to the SAME `account:<service>[:<slot>]` vault row the orchestrator
      // fold resolves. A legacy slot with only `account` keeps the collapsed
      // `account:<service>` route; an untagged slot keeps the per-skill
      // `skill-slot` destination. A slot already in the vault (haveExisting) writes
      // nothing — the key is already there.
      for (const s of request.slots) {
        if (s.haveExisting === true) continue; // already in the vault — nothing to write
        const payload = (values[s.slot] ?? '').trim();
        if (payload.length === 0) continue;
        const destination = accountOrSkillDestination(s, request.skillId);
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
      const resp = await httpFetch('/api/chat/permission-decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ conversationId, skillId: request.skillId, shown }),
      });
      if (!resp.ok) throw new HttpError('/api/chat/permission-decision', resp.status);
      close();
      // (TASK-36) re-issue the pending original turn -> fresh re-spawn + resume
      // -> the agent answers, with the now-attached skill (design §7).
      resumeActions.continueAfterGrant();
    } catch (err) {
      // `connect failed: 401` used to land in the Alert below (TASK-288).
      setError(userFacingMessage(err, 'permission-card'));
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
      // connector's `account:<service>[:<slot>]` vault row. service = the resolved
      // `service` tag (TASK-124 — always set by the producer; = the slot's account
      // tag else the connectorId); `slotTag` is present for a multi-slot connector
      // so the key lands on the SAME per-slot row the connector resolver / fold
      // reads (no collision). A slot already in the vault (haveExisting) writes
      // nothing — the key is already there. No secret crosses the decision POST
      // below (§10).
      for (const s of request.slots) {
        if (s.haveExisting === true) continue;
        const payload = (values[s.slot] ?? '').trim();
        if (payload.length === 0) continue;
        await setDestinationCredential({
          destination: accountDestinationForConnectorSlot(s, request.connectorId),
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
      const resp = await httpFetch('/api/chat/permission-decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ conversationId, connectorId: request.connectorId, shown }),
      });
      if (!resp.ok) throw new HttpError('/api/chat/permission-decision', resp.status);
      close();
      // Re-issue the pending turn → fresh re-spawn + resume → the agent answers
      // with the now-active connector's reach present.
      resumeActions.continueAfterGrant();
    } catch (err) {
      // `connect failed: 401` used to land in the Alert below (TASK-288).
      setError(userFacingMessage(err, 'permission-card'));
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
      // `connect failed: 401` used to land in the Alert below (TASK-288).
      setError(userFacingMessage(err, 'permission-card'));
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
            {/* (A12) A bare hostname list asks the reader to work out why it is
                there. Say what the list is for before showing it. */}
            <p className="text-xs text-muted-foreground">
              To do this, it needs to reach:
            </p>
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
              <Badge variant="secondary">{humanizeId(s.account ?? s.slot)}</Badge>
              <span>Using the {humanizeSlotLabel(s.slot, s.account)} you already saved.</span>
            </div>
          ) : (
            <div key={s.slot} className="grid gap-1.5">
              {/* (A1) This is the single trust moment of the product: we are
                  asking for a secret. The label said `api_key` and nothing said
                  where the key goes. Both are fixed here — the label reads as
                  English, and the helper line states the one fact a person
                  hesitating over this field actually wants. That claim is true:
                  the value posts straight to the host credential store and
                  never reaches the model or the transcript (§10, TASK-35). */}
              <Label htmlFor={`perm-cred-${s.slot}`}>
                {humanizeSlotLabel(s.slot, s.account)}
              </Label>
              <p className="text-xs text-muted-foreground">
                We store this key on the server. The agent never sees it, and it
                never appears in your conversation.
              </p>
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
            // (A5) "Installs npm packages → reaches registry.npmjs.org" is a
            // true sentence that means nothing to most people. What they need
            // to know is that something gets downloaded — the registry
            // hostnames are the grant's business, not theirs.
            <p className="text-sm text-muted-foreground" data-testid="permission-packages">
              It will download some extra software it needs from the internet to
              do this.
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
              <TriangleAlert className="size-4" />
              <AlertDescription>
                Your assistant wrote this connector itself, just now. Connect it
                only if you were expecting that.
              </AlertDescription>
            </Alert>
          )}
          {renderReach(request.hosts, request.slots, request.packages)}
          <p className="text-sm text-muted-foreground">{GRANT_REASSURANCE}</p>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          {!allSlotsFilled && (
            <p className="mr-auto text-xs text-muted-foreground">
              {SLOT_HINT}
            </p>
          )}
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
        {/* (A2) The title read `Connect linear-issues` — the id the producer
            uses, not the name a person would. Humanized, with the raw id as its
            own fallback for anything we can't read. */}
        <CardTitle>Connect {humanizeId(request.skillId)}</CardTitle>
        {request.description.length > 0 && (
          <CardDescription>{request.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {request.authored === true && (
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertDescription>
              Your assistant wrote this skill itself, just now. Connect it only
              if you were expecting that.
            </AlertDescription>
          </Alert>
        )}
        {renderReach(request.hosts, request.slots, request.packages)}
        <p className="text-sm text-muted-foreground">{GRANT_REASSURANCE}</p>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {!allSlotsFilled && (
          <p className="mr-auto text-xs text-muted-foreground">{SLOT_HINT}</p>
        )}
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
