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
 * (TASK-388) Neither `skillId` nor a connector's `name`/`connectorId` is
 * guaranteed present on this frame — unlike the workspace's `GrantRow`,
 * whose producer (`isRenderableGrant`) refuses to create a row unless
 * `skillId`/`connectorId` is a string (TASK-351), this card's producer
 * (`transport.ts`) does no shape validation at all before calling
 * `permissionCardActions.show()`. A missing id must not reach `humanizeId`,
 * which does `id.replace(...)` and throws `TypeError` on `undefined` — and
 * a bare template-string fallback (`` `Connect ${undefined}` ``) is worse
 * than the crash it replaces: it prints the literal words "Connect
 * undefined" above a password field, per TASK-351/#557's round-two finding.
 */
function humanizedTitleOrFallback(id: unknown, fallback: string): string {
  return typeof id === 'string' && id.trim().length > 0 ? humanizeId(id) : fallback;
}

/**
 * (TASK-388) The slot ELEMENTS need the same treatment as the slots array —
 * one level deeper than the fields this card's brief named, and the level
 * where porting `GrantRow`'s render-site fix is NOT sufficient on its own:
 * `GrantRow` reads `s.slot` unguarded too, and is safe only because its
 * producer (`isRenderableGrant` -> `hasIterableReach`) already requires every
 * element to carry a string `slot`. This card's producer requires nothing, so
 * `humanizeId(s.account ?? s.slot)` / `humanizeSlotLabel(s.slot, ...)` reach
 * `tokenize(undefined)` -> `undefined.replace(...)` -> `TypeError`, thrown
 * inside render.
 *
 * ONE list, used by the renderer AND `allSlotsFilled` AND the two click
 * handlers, because filtering only the renderer is a trap: `allSlotsFilled`
 * would still count a slot nobody can see, leaving Connect disabled forever
 * behind a hint pointing at no field — an unanswerable card, which is the
 * failure this whole task is avoiding.
 *
 * Dropping such a slot is safe: its key has nowhere to go (every vault
 * destination is derived from the slot id), and the server re-resolves the
 * real proposal and intersects it with `shown`, so a slot missing from
 * `shown` can only ever grant LESS, never more.
 */
function usableSlots<S extends { slot: string }>(slots: readonly S[] | undefined): S[] {
  return (slots ?? []).filter(
    (s) =>
      typeof s === 'object' && s !== null && typeof s.slot === 'string' && s.slot.trim().length > 0,
  );
}

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
  // (TASK-388) `slots` is typed required, but this producer validates
  // nothing on the wire (see `humanizedTitleOrFallback` above for why) — a
  // frame that omits it threw here too. `usableSlots` treats "no slots", "not
  // an array" and "slots we cannot draw a field for" alike: a grant with
  // nothing fillable is immediately connectable, which is the existing,
  // intended behavior for the slotless case.
  const allSlotsFilled =
    request === null ||
    (request.kind !== 'skill' && request.kind !== 'connector') ||
    usableSlots(request.slots).every(
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
      //
      // (TASK-388) `usableSlots` on every read below: `allSlotsFilled` now
      // treats a missing or undrawable `slots` as vacuously filled (see its
      // comment above), so this click path can run with `request.slots`
      // absent — guard it the same way here, or an undefined-iteration throw
      // replaces the request-shape one this task exists to fix. Same list the
      // renderer used, so `shown` reports exactly what the person saw.
      for (const s of usableSlots(request.slots)) {
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
        hosts: request.hosts ?? [],
        slots: usableSlots(request.slots).map((s) => s.slot),
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
      // below (§10). (TASK-388) `?? []` — same reasoning as `connect()` above.
      for (const s of usableSlots(request.slots)) {
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
        hosts: request.hosts ?? [],
        slots: usableSlots(request.slots).map((s) => s.slot),
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
        {/*
          (TASK-388) Same hole TASK-351 found and fixed in the workspace's
          `GrantRow` — `npm`/`pypi` are both required when `packages` is
          present, so a wire payload carrying only one of them threw here.
          `connect()`/`approveConnector()` above already read them as
          `packages?.npm ?? []`; this is the render site catching up.
        */}
        {packages != null &&
          ((packages.npm?.length ?? 0) > 0 || (packages.pypi?.length ?? 0) > 0) && (
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
    // (TASK-388) See `humanizedTitleOrFallback` above: `name` is not
    // guaranteed, and neither is `connectorId` behind it (unlike `GrantRow`,
    // where `isRenderableGrant` requires `connectorId`). Falls through to a
    // plain English noun rather than a raw id or a crash.
    const connectorTitle =
      typeof request.name === 'string' && request.name.trim().length > 0
        ? request.name
        : humanizedTitleOrFallback(request.connectorId, 'this connector');
    return (
      <Card className="mb-3" data-testid="permission-card-connector">
        <CardHeader>
          <CardTitle>Connect {connectorTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {request.authored === true && (
            <Alert>
              <TriangleAlert className="size-4" />
              <AlertDescription>{AUTHORED_CONNECTOR_WARNING}</AlertDescription>
            </Alert>
          )}
          {renderReach(request.hosts ?? [], usableSlots(request.slots), request.packages)}
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
            {GRANT_REJECT_LABEL}
          </Button>
          <Button
            disabled={busy || !allSlotsFilled || conversationId === null}
            onClick={() => void approveConnector()}
          >
            {busy ? GRANT_CONNECTING_LABEL : GRANT_CONNECT_LABEL}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (request.kind === 'host') {
    // (TASK-388) The host arm's turn. An absent `host` degrades quietly on its
    // own — React drops the child and the title reads "Allow access to ?" —
    // but an OBJECT-typed one throws React's "Objects are not valid as a React
    // child", and the workspace guards this at its producer
    // (`isRenderableGrant` requires `typeof r.host === 'string'`) where this
    // card cannot. NOT humanized: a hostname is already the thing we want the
    // person to read, and `humanizeId('api.linear.app')` would dress it up.
    const hostLabel =
      typeof request.host === 'string' && request.host.trim().length > 0
        ? request.host
        : 'this site';
    return (
      <Card className="mb-3" data-testid="permission-card-host">
        <CardHeader>
          <CardTitle>Allow access to {hostLabel}?</CardTitle>
          <CardDescription>{HOST_WALL_EXPLANATION}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{hostLabel}</Badge>
          </div>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={close}>
            {GRANT_REJECT_LABEL}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void allow(true)}>
            {HOST_ALLOW_ALWAYS_LABEL}
          </Button>
          <Button disabled={busy} onClick={() => void allow(false)}>
            {busy ? HOST_ALLOWING_LABEL : HOST_ALLOW_ONCE_LABEL}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  // (TASK-388) Same hole TASK-351 found and fixed in the workspace's
  // `GrantRow`: `description` is typed `string` and required, and the JSX
  // below asked it for `.length` unguarded — a wire payload that omitted it
  // threw `TypeError: Cannot read properties of undefined (reading 'length')`
  // here too. `typeof` rather than a bare `??` so a non-string (which would
  // also survive a `??`) can't reach `.length` and throw one line further
  // down, and can't render as a React child either.
  const skillDescription =
    typeof request.description === 'string' ? request.description : '';
  // (TASK-388) `skillId` is likewise not guaranteed on this unvalidated
  // frame (unlike `GrantRow`, where `isRenderableGrant` requires it) —
  // `humanizeId(undefined)` throws inside it (`id.replace(...)`). Falls
  // through to plain English rather than a raw id or a crash.
  const skillTitle = humanizedTitleOrFallback(request.skillId, 'this skill');

  return (
    <Card className="mb-3" data-testid="permission-card">
      <CardHeader>
        {/* (A2) The title read `Connect linear-issues` — the id the producer
            uses, not the name a person would. Humanized, with the raw id as its
            own fallback for anything we can't read. */}
        <CardTitle>Connect {skillTitle}</CardTitle>
        {skillDescription.length > 0 && (
          <CardDescription>{skillDescription}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {request.authored === true && (
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertDescription>{AUTHORED_SKILL_WARNING}</AlertDescription>
          </Alert>
        )}
        {renderReach(request.hosts ?? [], usableSlots(request.slots), request.packages)}
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
          {GRANT_REJECT_LABEL}
        </Button>
        <Button
          disabled={busy || !allSlotsFilled || conversationId === null}
          onClick={() => void connect()}
        >
          {busy ? GRANT_CONNECTING_LABEL : GRANT_CONNECT_LABEL}
        </Button>
      </CardFooter>
    </Card>
  );
}
