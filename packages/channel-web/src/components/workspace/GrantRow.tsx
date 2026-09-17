/**
 * A capability grant, as a row in the Today queue (TASK-350).
 *
 * WHY NOT `components/PermissionCard.tsx`. That card is chat's, it mounts above
 * chat's composer, and TASK-360 deletes it with the rest of the chat tree.
 * Mounting it here would tie the surviving surface to the retiring one. What
 * the two share — the words, and where a key is written — lives in
 * `@/lib/grant-copy` and `@/lib/grant-destinations`, which both import.
 *
 * WHY IT IS A ROW AND NOT A CARD. It sits inside Today's existing bordered
 * list, next to `DecisionRow`. A `Card` inside that list would read as a
 * different kind of object; it is the same kind of object — something waiting
 * on a person — so it gets the same frame.
 *
 * THE GRANT/DECISION DISTINCTION STAYS (2026-09-12). A grant is durable and
 * agent-scoped and carries no recorded call; a `Decision` is a one-shot outward
 * action with a verbatim call and a freshness guard. Two types, two rows, one
 * list. Sharing a queue is not collapsing them, which is why this is its own
 * component and not a `kind` branch inside `DecisionRow`.
 */
import { useState, type ReactElement } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { grantHost, setDestinationCredential } from '@/lib/credentials';
import {
  AUTHORED_CONNECTOR_WARNING,
  AUTHORED_SKILL_WARNING,
  GRANT_CONNECT_LABEL,
  GRANT_CONNECTING_LABEL,
  GRANT_REASSURANCE,
  GRANT_NO_CONVERSATION,
  GRANT_NOT_RESUMED,
  GRANT_NOT_RESUMED_DISMISS,
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
import {
  accountDestinationForConnectorSlot,
  accountOrSkillDestination,
} from '@/lib/grant-destinations';
import { humanizeId, humanizeSlotLabel } from '@/lib/humanize';
import { HttpError, httpFetch, userFacingMessage } from '@/lib/http';
import type { PermissionRequest } from '@/server/types';
import type { WorkspaceGrant } from '@/lib/workspace-grant-store';

interface Props {
  grant: WorkspaceGrant;
  /** The grant is answered or turned down: drop the row. */
  onResolved: (key: string) => void;
  /**
   * The capability has just been granted — pick the stopped agent back up
   * (TASK-374). Resolves `true` when the interrupted turn was re-issued and
   * `false` when it was not, which is the difference between dropping this row
   * and turning it into a sentence that says so.
   *
   * MUST NOT REJECT. Every failure is a `false`, because by the time this is
   * called the capability has already been granted, and a rejection would be
   * reported to the person as the connection failing — the one thing it did
   * not do. `lib/workspace-resume.ts` says the same from its own side.
   *
   * WHY IT LIVES ON THE PRIMITIVE and not on the two surfaces that draw it.
   * This row is what Today and the agent's thread SHARE, and answering a grant
   * has to mean the same thing in both; wiring the resume into one of them is
   * the drift a shared component exists to prevent. It is also the only code
   * that knows a grant was APPROVED rather than turned down: `onResolved` fires
   * for both, so a caller keying off that alone would restart an agent whose
   * answer was "not now".
   *
   * REQUIRED, and not optional-with-a-no-op default. A missing resume is
   * exactly the silence this task is about, and a default would let the next
   * render site reintroduce it without writing a line of code. Fires only for
   * `skill` and `connector`: a `host` grant widens the LIVE session allowlist
   * and the agent never stopped, so there is nothing to pick up.
   */
  onGranted: (grant: WorkspaceGrant) => Promise<boolean>;
}

/** Slots the person still has to fill — the vaulted ones need no input. */
function blankSlots(slots: readonly { slot: string; haveExisting?: boolean }[]): string[] {
  return slots.filter((s) => s.haveExisting !== true).map((s) => s.slot);
}

export function GrantRow({ grant, onResolved, onGranted }: Props): ReactElement {
  // The conversation is recorded on the grant when the frame arrives: Today can
  // hold grants from several agents, so the row cannot work it out from context.
  const { request, conversationId } = grant;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The grant was applied and the agent did not start again (TASK-374).
   *
   * A THIRD outcome, not an error: `error` above means the grant did not land
   * and the buttons are still worth pressing, and this means it DID land and
   * they are not. Rendering it through `error` would put "Connect" under a
   * sentence saying we already had, and re-pressing it would post a second
   * decision for a capability the person already owns.
   */
  const [stalled, setStalled] = useState(false);

  const slots = request.kind === 'host' ? [] : request.slots;
  const needed = blankSlots(slots);
  const allSlotsFilled = needed.every((s) => (values[s] ?? '').trim().length > 0);

  /**
   * Turning a grant down is PURELY LOCAL — no network call, the same as chat.
   * There is nothing to tell the server: the wall already holds, and a grant
   * that was never given needs no revoking.
   */
  function reject(): void {
    onResolved(grant.key);
  }

  /** Write each freshly-typed key to the host credential store, then decide. */
  async function writeKeys(subjectId: string, forConnector: boolean): Promise<void> {
    for (const s of slots) {
      if (s.haveExisting === true) continue;
      const value = (values[s.slot] ?? '').trim();
      if (value.length === 0) continue;
      await setDestinationCredential({
        destination: forConnector
          ? accountDestinationForConnectorSlot(s, subjectId)
          : accountOrSkillDestination(s, subjectId),
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload: value,
      });
    }
  }

  async function connect(): Promise<void> {
    if (request.kind === 'host' || conversationId === null) return;
    setBusy(true);
    setError(null);
    try {
      const forConnector = request.kind === 'connector';
      const subjectId = forConnector ? request.connectorId : request.skillId;
      await writeKeys(subjectId, forConnector);
      // What the row DISPLAYED. The authored grant intersects its proposal with
      // this, so a card that showed less than the manifest asks for grants less.
      const shown = {
        hosts: request.hosts,
        slots: request.slots.map((s) => s.slot),
        npm: request.packages?.npm ?? [],
        pypi: request.packages?.pypi ?? [],
      };
      const resp = await httpFetch('/api/chat/permission-decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify(
          forConnector
            ? { conversationId, connectorId: subjectId, shown }
            : { conversationId, skillId: subjectId, shown },
        ),
      });
      if (!resp.ok) throw new HttpError('/api/chat/permission-decision', resp.status);
      /*
        THE GRANT IS APPLIED FROM HERE DOWN, and nothing below may report
        otherwise. The skill is attached and the warm session retired; the only
        open question is whether the agent picked up again.

        `onGranted` must not reject (its own doc says so) and this catches
        anyway — because the alternative is that a bug in the resume path falls
        into the `catch` below and tells the person their connection failed when
        it is the one thing that definitely worked, sending them back to
        re-enter a key that is already saved.
      */
      let resumed = false;
      try {
        resumed = await onGranted(grant);
      } catch (e) {
        console.warn('[workspace] the resume after a grant threw', e);
      }
      if (resumed) {
        onResolved(grant.key);
        return;
      }
      setStalled(true);
    } catch (err) {
      // Never the status, never the path — those go to the console.
      setError(userFacingMessage(err, 'grant-row'));
    } finally {
      setBusy(false);
    }
  }

  async function allow(persist: boolean): Promise<void> {
    if (request.kind !== 'host') return;
    setBusy(true);
    setError(null);
    try {
      await grantHost({ sessionId: request.sessionId, host: request.host, persist });
      onResolved(grant.key);
    } catch (err) {
      setError(userFacingMessage(err, 'grant-row'));
    } finally {
      setBusy(false);
    }
  }

  const failure =
    error === null ? null : (
      <Alert variant="destructive" className="mt-3 max-w-[660px]">
        <AlertDescription className="text-[13px] leading-relaxed">
          {error}
        </AlertDescription>
      </Alert>
    );

  if (request.kind === 'host') {
    return (
      <div
        className="border-b border-rule-soft p-4 last:border-b-0"
        data-testid={`grant-${grant.key}`}
      >
        <p className="text-[14px] font-medium">Allow access to {request.host}?</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          {HOST_WALL_EXPLANATION}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge variant="secondary">{request.host}</Badge>
        </div>
        {failure}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void allow(false)}>
            {busy ? HOST_ALLOWING_LABEL : HOST_ALLOW_ONCE_LABEL}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void allow(true)}
          >
            {HOST_ALLOW_ALWAYS_LABEL}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={reject}>
            {GRANT_REJECT_LABEL}
          </Button>
        </div>
      </div>
    );
  }

  /*
    THE TITLE IS THE SUBJECT OF THE CONSENT, so it is the one string on this
    card that must never be missing.

    `name` is typed `string` and required, and `isRenderableGrant` deliberately
    does not check it — correctly, since a connector with no name is still an
    answerable grant and refusing it would cost the person the question
    entirely. But the first version of that reasoning cleared `name` on the
    wrong test: "it is interpolated, so it cannot throw." Not throwing is not
    tolerating. `Connect ${undefined}` renders **"Connect undefined"** above a
    `type="password"` input and the KEY_SAFETY copy — a credential prompt whose
    subject has gone missing, on the one surface whose entire job is informed
    consent. That is worse than the crash it was compared against: a crash is
    loud and this is a person typing an API key into a question they cannot
    read.

    `connectorId` IS guarded, so it is always there to fall back on, and
    `humanizeId` is already how the skill arm below builds its title. An empty
    string counts as missing for the same reason `undefined` does.
  */
  const connectorTitle = (r: Extract<PermissionRequest, { kind: 'connector' }>) =>
    typeof r.name === 'string' && r.name.trim().length > 0
      ? r.name
      : humanizeId(r.connectorId);
  const title =
    request.kind === 'connector'
      ? `Connect ${connectorTitle(request)}`
      : `Connect ${humanizeId(request.skillId)}`;
  const authoredWarning =
    request.kind === 'connector' ? AUTHORED_CONNECTOR_WARNING : AUTHORED_SKILL_WARNING;
  /*
    THE FALLBACK IS LOAD-BEARING, not defensive noise. `description` is typed
    `string` and required, and the JSX below asks it for `.length` — so a
    payload that omits it threw `TypeError` here, the workspace
    `ErrorBoundary` caught it, and ONE such row buried every other legible
    grant and decision on the surface with it.

    Coalescing rather than validating at the wire is the deliberate choice:
    a description is how the card reads, not whether it can be ANSWERED, and
    refusing the grant over it would trade a plain-looking row for a question
    that silently never gets asked. `hosts` and `slots` get the opposite
    treatment in `isRenderableGrant` precisely because without them there is
    no answerable row left to draw.

    `typeof` rather than a bare `??` so a non-string survives too: this value
    is also rendered as a React child, and an object with a truthy `.length`
    would throw again one line further down.
  */
  const description =
    request.kind === 'skill' && typeof request.description === 'string'
      ? request.description
      : '';
  const packages = request.packages;

  /*
    THE GRANT LANDED AND THE AGENT DID NOT (TASK-374).

    The row STAYS, wearing one sentence and one way out, because the thing it
    has to report is invisible everywhere else: the capability is attached
    (nothing on screen would contradict a row that simply vanished) and the
    agent is stopped (which looks exactly like an agent that is thinking). The
    old behaviour was for the row to disappear on both counts, which told the
    person the opposite of what had happened in the only place they were
    looking.

    It keeps the title so it is still legible as the answer to the question
    that was here a moment ago, and drops everything else — the reach badges,
    the key field, the reassurance line. Those are for DECIDING, and the
    decision is made.

    Unreachable on a `host` grant: that arm returns above, and `onGranted` is
    never called there because the agent never stopped.
  */
  if (stalled) {
    return (
      <div
        className="border-b border-rule-soft p-4 last:border-b-0"
        data-testid={`grant-${grant.key}`}
      >
        <p className="text-[14px] font-medium">{title}</p>
        <p
          className="mt-1 max-w-[660px] text-[13px] leading-relaxed text-muted-foreground"
          data-testid="grant-not-resumed"
        >
          {GRANT_NOT_RESUMED}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onResolved(grant.key)}
          >
            {GRANT_NOT_RESUMED_DISMISS}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="border-b border-rule-soft p-4 last:border-b-0"
      data-testid={`grant-${grant.key}`}
    >
      <p className="text-[14px] font-medium">{title}</p>
      {description.length > 0 && (
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}

      {request.authored === true && (
        <Alert className="mt-3 max-w-[660px]">
          <TriangleAlert className="size-4" />
          <AlertDescription className="text-[13px] leading-relaxed">
            {authoredWarning}
          </AlertDescription>
        </Alert>
      )}

      {request.hosts.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">{REACH_LEAD_IN}</p>
          <div className="flex flex-wrap gap-1.5">
            {request.hosts.map((h) => (
              <Badge key={h} variant="secondary">
                {h}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {request.slots.map((s) =>
        s.haveExisting === true ? (
          <div
            key={s.slot}
            className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground"
          >
            <Badge variant="secondary">{humanizeId(s.account ?? s.slot)}</Badge>
            <span>Using the {humanizeSlotLabel(s.slot, s.account)} you already saved.</span>
          </div>
        ) : (
          <div key={s.slot} className="mt-3 grid max-w-[420px] gap-1.5">
            <Label htmlFor={`grant-cred-${grant.key}-${s.slot}`}>
              {humanizeSlotLabel(s.slot, s.account)}
            </Label>
            <p className="text-xs text-muted-foreground">{KEY_SAFETY}</p>
            <Input
              id={`grant-cred-${grant.key}-${s.slot}`}
              type="password"
              autoComplete="off"
              value={values[s.slot] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [s.slot]: e.target.value }))}
            />
          </div>
        ),
      )}

      {/*
        Same shape of bug as `description` above, one field over: `npm` and
        `pypi` are both required when `packages` is present, so a payload
        carrying only one of them threw on the other's `.length`. The click
        handler was already reading them as `packages?.npm ?? []`; this is
        the render site catching up with it.
      */}
      {packages != null &&
        ((packages.npm?.length ?? 0) > 0 || (packages.pypi?.length ?? 0) > 0) && (
          <p className="mt-3 text-[13px] text-muted-foreground" data-testid="grant-packages">
            {PACKAGES_LINE}
          </p>
        )}

      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
        {GRANT_REASSURANCE}
      </p>

      {failure}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || !allSlotsFilled || conversationId === null}
          onClick={() => void connect()}
        >
          {busy ? GRANT_CONNECTING_LABEL : GRANT_CONNECT_LABEL}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={reject}>
          {GRANT_REJECT_LABEL}
        </Button>
        {!allSlotsFilled ? (
          <span className="text-[11.5px] text-muted-foreground">{SLOT_HINT}</span>
        ) : conversationId === null ? (
          // The one disabled state typing cannot fix. Say so rather than
          // leaving a dead button on a surface whose whole job is asking.
          <span className="text-[11.5px] text-muted-foreground">
            {GRANT_NO_CONVERSATION}
          </span>
        ) : null}
      </div>
    </div>
  );
}
