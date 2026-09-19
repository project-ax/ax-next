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
 *
 * ANSWERING IT REMOVES IT, SO FOCUS HAS TO GO SOMEWHERE (TASK-427). "Not now"
 * and a successful Connect both unmount this card, and a focused element that
 * disappears leaves the browser pointing at `<body>` — the top of the document,
 * a long blind crawl from anything on this screen. `close()` hands focus up to
 * the `data-consent-region` the composer puts around its card stack first, while
 * this node is still in the document. `lib/consent-focus.ts` carries the
 * argument, and the sibling `workspace/GrantRow.tsx` does the same thing on the
 * surface that outlives this one.
 *
 * AND WHEN IT DOES NOT GO — a Connect or an Allow that comes back 401, or never
 * reaches the server at all — the card STAYS, the button comes back, and the
 * focus that the browser took away when the button went `disabled` does not
 * come back with it. That is the same `<body>` landing with the error left
 * unread behind it, and this file is the live `/` surface until TASK-360, so it
 * is fixed here rather than waited out. The error `Alert` is the answer, and it
 * takes the focus — exactly as `GrantRow` does with its own.
 */
import { useRef, useState, type ReactElement } from 'react';
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
import {
  RESOLUTION_FOCUS_RING,
  returnFocusToConsentRegion,
  useResolutionFocus,
} from '@/lib/consent-focus';
import { grantHost, setDestinationCredential } from '@/lib/credentials';
import {
  AUTHORED_CONNECTOR_WARNING,
  AUTHORED_SKILL_WARNING,
  GRANT_CONNECT_LABEL,
  GRANT_CONNECTING_LABEL,
  GRANT_REASSURANCE,
  GRANT_REJECT_LABEL,
  HOST_ALLOW_ALWAYS_LABEL,
  HOST_ALLOW_ONCE_LABEL,
  HOST_ALLOWING_LABEL,
  HOST_WALL_EXPLANATION,
  KEY_SAFETY,
  PACKAGES_LINE,
  REACH_LEAD_IN,
  SLOT_HINT,
} from '@/lib/grant-copy';
import { humanizeId, humanizeSlotLabel } from '@/lib/humanize';
import {
  permissionCardActions,
  usePermissionCardStore,
} from '@/lib/permission-card-store';
import { HttpError, httpFetch, userFacingMessage } from '@/lib/http';
import { resumeActions } from '@/lib/resume-actions';
import { useConversationId } from '@/lib/use-conversation-id';
import {
  accountDestinationForConnectorSlot,
  accountOrSkillDestination,
} from '@/lib/grant-destinations';

// (TASK-350) The grant copy moved to `@/lib/grant-copy` so the agent
// workspace's own grant renderer reads the same strings rather than repeating
// them. This file is deleted by TASK-360; the copy must outlive it.

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
  // The card's own node, read while it is still mounted: `closest` cannot walk
  // up from a node React has already detached.
  const cardRef = useRef<HTMLDivElement | null>(null);
  /*
    The one ending that leaves the card on screen. A success unmounts it and
    `close()` hands focus up to the region; a failure has to be caught here or
    the person is standing on `<body>` with an unread Alert behind them.

    Above the `if (!request)` return, with the other hooks — this file bails out
    early when there is no card to draw, and a hook after that point would run
    on some renders and not others.
  */
  const { answerRef, armForResolution } = useResolutionFocus(error !== null);

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
    // BEFORE the dismiss, not after: the store update unmounts this card, and
    // a detached node has no region above it to find.
    returnFocusToConsentRegion(cardRef.current);
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
            <p className="text-xs text-muted-foreground">{REACH_LEAD_IN}</p>
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
              <p className="text-xs text-muted-foreground">{KEY_SAFETY}</p>
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
              {PACKAGES_LINE}
            </p>
          )}
      </>
    );
  }

  if (request.kind === 'connector') {
    return (
      <Card ref={cardRef} className="mb-3" data-testid="permission-card-connector">
        <CardHeader>
          <CardTitle>Connect {request.name}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {request.authored === true && (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertDescription>{AUTHORED_CONNECTOR_WARNING}</AlertDescription>
            </Alert>
          )}
          {renderReach(request.hosts, request.slots, request.packages)}
          <p className="text-sm text-muted-foreground">{GRANT_REASSURANCE}</p>
          {error !== null && (
            <Alert
              ref={answerRef}
              tabIndex={-1}
              variant="destructive"
              className={RESOLUTION_FOCUS_RING}
            >
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
            {GRANT_REJECT_LABEL}
          </Button>
          <Button
            disabled={busy || !allSlotsFilled || conversationId === null}
            onClick={() => {
              armForResolution();
              void approveConnector();
            }}
          >
            {busy ? GRANT_CONNECTING_LABEL : GRANT_CONNECT_LABEL}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (request.kind === 'host') {
    return (
      <Card ref={cardRef} className="mb-3" data-testid="permission-card-host">
        <CardHeader>
          <CardTitle>Allow access to {request.host}?</CardTitle>
          <CardDescription>{HOST_WALL_EXPLANATION}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{request.host}</Badge>
          </div>
          {error !== null && (
            <Alert
              ref={answerRef}
              tabIndex={-1}
              variant="destructive"
              className={RESOLUTION_FOCUS_RING}
            >
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={close}>
            {GRANT_REJECT_LABEL}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              armForResolution();
              void allow(true);
            }}
          >
            {HOST_ALLOW_ALWAYS_LABEL}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              armForResolution();
              void allow(false);
            }}
          >
            {busy ? HOST_ALLOWING_LABEL : HOST_ALLOW_ONCE_LABEL}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card ref={cardRef} className="mb-3" data-testid="permission-card">
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
            <AlertDescription>{AUTHORED_SKILL_WARNING}</AlertDescription>
          </Alert>
        )}
        {renderReach(request.hosts, request.slots, request.packages)}
        <p className="text-sm text-muted-foreground">{GRANT_REASSURANCE}</p>
        {error !== null && (
          <Alert
            ref={answerRef}
            tabIndex={-1}
            variant="destructive"
            className={RESOLUTION_FOCUS_RING}
          >
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        {!allSlotsFilled && (
          <p className="mr-auto text-xs text-muted-foreground">{SLOT_HINT}</p>
        )}
        <Button variant="ghost" disabled={busy} onClick={close}>
          {GRANT_REJECT_LABEL}
        </Button>
        <Button
          disabled={busy || !allSlotsFilled || conversationId === null}
          onClick={() => {
            armForResolution();
            void connect();
          }}
        >
          {busy ? GRANT_CONNECTING_LABEL : GRANT_CONNECT_LABEL}
        </Button>
      </CardFooter>
    </Card>
  );
}
