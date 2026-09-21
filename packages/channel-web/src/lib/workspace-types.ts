/**
 * Agent-workspace — the shapes the `/api/workspace/*` routes speak.
 *
 * These started life in `mock/` next to the clickable prototype. They now sit
 * in `src/lib/` because they are the real wire contract: `routes-workspace.ts`
 * produces them and the workspace components consume them.
 *
 * One shape is load-bearing and deliberately mirrors an existing contract:
 *
 *   - `Attendance` is the axis the whole design turns on. `tool.pre-call` has a
 *     10s ceiling (`@ax/ipc-protocol` IPC_TIMEOUTS_MS) and converts timeouts to
 *     `deny`, so a human can never be waited for inside it. Instead the host
 *     returns `hold` immediately in BOTH cases and the difference shows up one
 *     level up: an attended conversation parks on `session.next-message` and the
 *     agent executes the tool itself when the decision arrives; an unattended one
 *     ends the turn and the host replays the recorded call later.
 *
 * `Decision` is a PROJECTION of the row `@ax/decisions` owns, not a copy of it.
 * The projection is the point — see the interface below for what is dropped and
 * why. It is mirrored here rather than imported because plugins talk through
 * the hook bus, never through each other's modules (invariant 2).
 */

/**
 * Where the conversation that produced this decision is being watched, which
 * determines the park budget and therefore the execution path on approval.
 *
 *   - `attended`   — a live channel with a human expected to answer inside the
 *                    keepalive budget (web thread; Slack, with a longer budget).
 *                    The agent is still warm: it executes the call itself.
 *   - `unattended` — routine tick or webhook. Turn already ended, sandbox
 *                    reaped. The host replays the recorded call.
 *
 * An attended decision DEGRADES to unattended when the reaper gives up. That is
 * the same row either way, which is why the Today queue needs no special case
 * for "the user walked away mid-approval".
 */
/*
  The step row's shape has ONE home, and it is the module that builds rows
  (invariant 4). Mirroring it here would put the status vocabulary in two
  places, which is how a renderer ends up drawing a state the shaper stopped
  producing. The `.js` is deliberate: this file is reachable from the server
  (`server/routes-workspace.ts`), and Node's ESM resolver does not guess.
*/
import type { WorkspaceStep } from './workspace-steps.js';

export type Attendance = 'attended' | 'unattended';

export type DecisionKind = 'action' | 'grant';

/**
 * Which side runs the call once a human says yes — a consequence of
 * `Attendance`, not an independent choice.
 */
export type ExecutionPath = 'agent-executes' | 'host-replays';

/**
 * `stale` is not a failure — it is the freshness guard doing its job. The world
 * moved between hold-time and approval, so the decision RE-OPENS with what
 * changed instead of executing something the human would not have approved had
 * they seen the current state. Silent staleness is the failure mode that would
 * destroy trust in the whole surface.
 */
export type DecisionStatus =
  | 'pending'
  | 'executed'
  | 'approved-pending-agent'
  | 'dismissed'
  | 'stale'
  | 'expired'
  | 'failed';

/**
 * The two statuses that are still a QUESTION. Everything else is a receipt.
 *
 * Exported because three things have to agree on which rows are still open —
 * the queue's headline count, the queue's row list, and the sidebar's pending
 * badge — and three copies of a status list is how they stop agreeing.
 */
export const OPEN_DECISION_STATUSES: readonly DecisionStatus[] = [
  'pending',
  'stale',
];

/** True while a decision is still waiting on a human. */
export function isOpenDecision(d: { status: DecisionStatus }): boolean {
  return OPEN_DECISION_STATUSES.includes(d.status);
}

/**
 * Captured WITH the decision at hold-time. `value` is opaque to the UI — the
 * tool that produced the call decides what "unchanged" means (a thread's head
 * message id, a calendar slot etag, a document revision). `label` is the only
 * part a human reads, and the ONLY part a renderer may print: `kind` and
 * `value` are tokens, and nothing here parses one.
 *
 * `label` IS NULLABLE, and the guard is why (AW-7). The "checked against…"
 * clause describes hold-time; the instant the guard trips, that sentence is
 * false, so `@ax/decisions` strips it as it moves the row to `stale`. Repeating
 * it under an alert saying the world moved would be worse than silence (design
 * §3.4). A renderer therefore has to handle `label === null` — it is not a
 * defensive branch, it is the stale row's normal shape.
 *
 * Mirrors `packages/decisions/src/types.ts`. A divergence between the two is a
 * bug in one of them, not a variation.
 */
export interface FreshnessPredicate {
  kind: string;
  value: string;
  label: string | null;
}

/**
 * One decision, as the BROWSER sees it.
 *
 * This is a PROJECTION of `@ax/decisions`' `Decision`, and the difference is
 * deliberate — capability minimisation applies to a wire shape exactly as it
 * applies to a filesystem path (invariant 5). What the plugin stores and what a
 * renderer needs are not the same set, so the route hands over the second one:
 *
 *   - `call` is DROPPED, `input` and all. It is MODEL-AUTHORED, it is the one
 *     field on the row nothing here renders, and shipping it would put raw
 *     model output on a trust surface for no reader's benefit (design H6). The
 *     WYSIWYG promise is kept by `preview`, which is host-authored. The SSE
 *     frame drops it for the same reason, and a test asserts both.
 *   - `ownerUserId` is DROPPED: it is always the caller, so it says nothing,
 *     and a user id on a page is one more identifier to leak.
 *   - `callFingerprint` / `ruleId` / `consumedAt` / `replayClaimedAt` /
 *     `replayedAt` / `replayError` are DROPPED: host bookkeeping. What a reader
 *     needs out of them is whether this can still be taken back, and that is
 *     `undoable` below — one derived boolean instead of four raw fields a
 *     client would have to re-derive it from, which is how a second copy of the
 *     decision machine gets built by accident (invariant 4).
 *
 * Everything kept is either something a renderer puts on screen or something it
 * has to branch on.
 */
export interface Decision {
  id: string;
  agentId: string;
  conversationId: string;
  kind: DecisionKind;
  attendance: Attendance;
  status: DecisionStatus;
  /**
   * Whether the rule that held this call said approving it cannot be taken
   * back. Captured at hold time. An irreversible call is DEFERRED by the undo
   * window rather than run immediately, so the grace period sits before the
   * outward action instead of pretending to reverse one.
   */
  irreversible: boolean;
  /** null when the action has nothing meaningful to re-check. */
  freshness: FreshnessPredicate | null;
  /** One line, the queue row. */
  summary: string;
  /** The paragraph shown when the row is expanded. */
  detail: string;
  /** The quoted artifact — the actual email body, the actual invite. */
  preview: { meta: string; body: string } | null;
  primaryLabel: string;
  secondaryLabel: string;
  ghostLabel: string;
  /**
   * Authored outcome strings. Deliberately BOTH stored rather than derived:
   * the prototype this came from built the dismissed line by regexing the
   * approved one, which produced "You took over from Inbox — sent your reply"
   * for a reply that was never sent. Never derive a factual claim by string
   * surgery.
   */
  approvedText: string;
  dismissedText: string;
  createdAt: string;
  expiresAt: string;
  /** ISO, set when the decision left `pending`. Drives the undo window. */
  resolvedAt: string | null;
  /** Set only when the freshness guard fails. Human-readable. */
  staleReason: string | null;
  /**
   * ISO instant an approved action will ACTUALLY happen, when it has not
   * happened yet. Non-null only for an `irreversible` call whose execution the
   * host deferred until the undo window closes.
   *
   * This is what stops the row claiming an outcome it has not observed (design
   * H1): for those ten seconds the status reads `executed` because the
   * AUTHORISATION is final, but nothing has gone out, and the row says so.
   *
   * Named for what it means to a reader, not for the host mechanism behind it:
   * `replayDueAt` is the plugin's word for its own replay queue, and a replay
   * queue is not a thing a browser knows about (invariant 1).
   */
  pendingUntil: string | null;
  /**
   * Can this still be taken back? SERVER-DERIVED, and the only reason the raw
   * bookkeeping fields above are not on the wire.
   *
   * False the moment the call has actually been made — either the agent
   * re-issued it and the gate let it through, or the host performed it. Undo
   * cannot un-send an email, so once something has gone out the affordance is
   * not shown at all. A button that cannot do the thing it names is the worst
   * control this surface could ship.
   *
   * It does NOT include the time window: that is `UNDO_WINDOW_MS` measured
   * from `resolvedAt`, and the client counts it down itself so the button
   * disappears on a clock rather than on the next poll.
   */
  undoable: boolean;
}

/**
 * `working` and `resting` are the only two the host can derive today (a live
 * session on one of the agent's conversations, or not). `waiting` arrives with
 * the `hold` verdict (AW-2) and `stopped` with the halted-agent state (AW-11);
 * both stay in the union so the renderers that already handle them keep
 * compiling, and neither is ever produced by `/api/workspace/state` yet.
 */
export type AgentRunState = 'working' | 'waiting' | 'resting' | 'stopped';

export interface WorkspaceAgent {
  id: string;
  /** The agent's `displayName`. */
  name: string;
  state: AgentRunState;
  /**
   * What it is doing right now, in plain words — `null` until the activity
   * line has a real producer (design §4.2, AW-8/AW-14). A null renders as the
   * state word alone; it is never filled with a placeholder phrase, because a
   * placeholder is indistinguishable from a claim.
   */
  now: string | null;
  /**
   * A real counter from the loop, or null. Deliberately NOT a percentage and
   * NOT an ETA: an agent cannot know how long it has left, and one wrong
   * "~2 min left" costs more trust than the widget could ever earn. Always
   * null until a tool reports one (AW-8).
   */
  counter: { done: number; total: number; unit: string } | null;
  /** ISO. The UI renders elapsed time from this instead of guessing remaining. */
  startedAt: string | null;
  /** Why it stopped. Only set when `state === 'stopped'`. */
  stoppedReason: string | null;
}

export type CapabilityVerdict = 'allow' | 'hold' | 'deny';

/**
 * Where a rail row's claim comes from. Mirrors `@ax/tool-policy`'s union rather
 * than importing it (invariant 2), and widens it with nothing: the two members
 * the policy plugin never emits — `grant` and `mcp` — are produced by the BFF,
 * from the grant record and the tool catalog respectively.
 *
 *   - `rule`     — an in-repo policy decision, reviewed in a diff.
 *   - `catalog`  — "this tool is reachable and no rule gates it". True about
 *                  the system, and NOT a reviewed policy decision. The rail
 *                  must not dress it up as one.
 *   - `grant`    — a durable grant a human made at runtime.
 *   - `mcp`      — a mechanical row for a third-party tool.
 *   - `unmapped` — reach we cannot describe (design §4.3.5).
 *
 * THE RENDERER SWITCHES ON THIS, NEVER ON `source`. `source` is an opaque
 * display token; parsing its prefix to decide rendering is the exact coupling
 * AW-3's boundary review called out, and it breaks the moment the alternate
 * per-tenant policy impl ships with different id shapes.
 */
export type CapabilityProvenance = 'rule' | 'catalog' | 'grant' | 'mcp' | 'unmapped';

/**
 * The declared real-world consequence of a rail row's call, orthogonal to
 * whether we allow it. Mirrors `@ax/tool-policy`'s `ToolEffect` rather than
 * importing it (invariant 2), same as `CapabilityProvenance` above.
 *
 *   - `spends`  — the call costs money, on EVERY use, not just the first.
 *     THIS IS A MONEY-ONLY CLAIM. It does not say the call is safe, and it
 *     says nothing at all about whether the same call is also `outward`.
 *     `web.extract` is the tool that proved why: it spends AND it hands the
 *     URL (and anything encoded in it) to a third party that sees the
 *     request, so it declares BOTH, and the rail shows both (TASK-330). Do
 *     not let a reader, or a future renderer, read `spends` as "harmless" or
 *     "contained" — a row that carries it may well carry `outward` too.
 *   - `outward` — a third party sees the call, or it cannot be taken back: a
 *     message sent, something posted where others can see it, a payment
 *     made. `lintRuleEffect` in `@ax/tool-policy` reads the declared SET with
 *     STRICTEST MEMBER WINS: an `outward` anywhere in it forbids `allow`, and
 *     a rule cannot buy its way back to `allow` by declaring something milder
 *     alongside it. So on the wire a row whose effects INCLUDE `outward` is
 *     always `hold` or `deny` — never `allow`.
 *
 * A row declares the whole SET of true things about its call, not one of
 * them. AN EMPTY SET MEANS UNCLASSIFIED — nobody has declared an effect for
 * this tool. It is not a claim that the call is free or contained; it is the
 * honest gap for a rule that predates TASK-263, or a catalog/MCP/grant row
 * with no rule behind it at all. There is exactly ONE spelling of that gap:
 * `[]`. Nothing here is nullable, because two spellings of "we don't know" is
 * how somebody comes to read one of them as "we checked, and it's fine".
 *
 * ONE OF FOUR HAND-COPIES (TASK-408). Widening this union alone is caught by
 * `tsc`, via `EFFECT_DISCLOSURES`'s `Record<CapabilityEffect, …>` — but that is
 * the harmless direction. A member that exists in `@ax/tool-policy`'s
 * `ToolEffect` and is MISSING here, or missing from the `KNOWN_EFFECTS`
 * allow-list, compiles clean and is dropped on the way to the wire, so the rail
 * claims less reach than the tool has. `__tests__/server/effect-mirror-drift.test.ts`
 * is what covers that: it pins all four copies as text and round-trips every
 * member through the real wire projection.
 */
export type CapabilityEffect = 'outward' | 'spends';

/**
 * One row of "What it may do alone".
 *
 * GENERATED, never authored here. A row is one of two things and the boolean
 * says which:
 *
 *   - `described: true`  — `capability` is OUR claim, authored on the rule that
 *     enforces it and CI-linted for shape. Rendered through the verdict's frame
 *     (`permission-frames.ts`), so an author cannot write an allow phrase that
 *     reads like a deny.
 *   - `described: false` — we cannot describe this reach in our own words. The
 *     row goes MECHANICAL: the tool's name (which we control) plus the verdict
 *     (which we enforce), with the third party's own description available
 *     behind an affordance and clearly attributed. Their prose is evidence,
 *     never our claim.
 *
 * An undescribable capability is rendered EXPLICITLY, never omitted (design
 * H4): a row that is not there reads to a human as "it cannot do that", and
 * understating blast radius is the dangerous direction to be wrong in.
 */
export interface PermissionRow {
  verdict: CapabilityVerdict;
  /** Our own authored clause. Empty string exactly when `described` is false. */
  capability: string;
  /** Opaque display provenance (`rule:web.search`, `mcp:linear.create_issue`). */
  source: string;
  provenance: CapabilityProvenance;
  described: boolean;
  /**
   * The rule behind this row applies to SOME calls and not others — it carries
   * a predicate over the call's arguments.
   *
   * A separate flag from the verdict on purpose. "Asks you first" and "asks you
   * first, in some cases" are different claims about what we enforce, and a
   * reader told the first about a rule that does the second has been promised a
   * gate that is not always there. False for every row with no rule behind it:
   * a catalog, MCP or grant row has no predicate to be conditional on.
   */
  conditional: boolean;
  /**
   * A DISCLOSURE, not a gate — `verdict` is the gate that decides whether the
   * call happens at all, and this is a separate claim about what happens
   * when it does. A row is routinely `allow` AND `spends` at the same time
   * (that is `web_search`): the call goes through, and it costs money every
   * time it does.
   *
   * EVERY declared effect, not the first one. A single-valued field made the
   * row pick which true thing to say, and `web_extract` is the call that made
   * that a lie — it spends money AND it hands data to a third party, and the
   * outward half went undisclosed because the field had room for only the
   * convenient truth (TASK-330). A renderer draws each member; dropping one
   * is understating reach, which is the one direction design H4 forbids.
   *
   * `[]` means nobody classified this tool's effect, which is the honest
   * answer for a rule that predates TASK-263 or a catalog/MCP row with no
   * rule behind it — it is NOT a claim that the call is free or has no effect
   * beyond AX. Never null: the empty array is the only spelling of the gap.
   */
  effect: CapabilityEffect[];
  /** `described: false` only — what we DO control: the tool's own name. */
  mechanicalLabel: string | null;
  /** `described: false` only — the third party's words, fenced and attributed. */
  theirDescription: string | null;
  /** `described: false` only — who wrote them ("linear"). Fenced. */
  theirName: string | null;
}

/**
 * What a "Granted by you" row points back at, so the revoke control can undo
 * exactly the grant the row describes.
 *
 * The client NEVER builds one of these — it echoes back the object the server
 * handed it. That is why there is no id to parse and no string to split: a
 * revoke that had to re-derive its target from a display string is a revoke
 * that can target the wrong thing.
 */
export type GrantRef =
  | { grant: 'site'; host: string }
  | {
      grant: 'approved-capability';
      capKind: 'host' | 'slot' | 'npm' | 'pypi' | 'mcp';
      value: string;
      /** Exactly one of these is non-null — the grant's subject. */
      skillId: string | null;
      connectorId: string | null;
    };

/**
 * One row of "Granted by you" — design §4.3.4.
 *
 * A separate group from the built-in rules, because this is the group a person
 * can act on and the one they are most likely to have forgotten they created.
 *
 * `action` is OURS (authored, one of a fixed set) and `label` is THE THING
 * (a hostname, a package name, a saved-key name) — mechanical, fenced, and
 * rendered as data rather than folded into our sentence. Keeping them apart is
 * what stops a grant value from ever reading as our prose.
 */
export interface GrantRow {
  ref: GrantRef;
  /** Always `allow`. A grant you made is a thing the agent may now do alone. */
  verdict: 'allow';
  /** Our authored verb phrase: "reach", "install the npm package", … */
  action: string;
  /** The granted thing itself. Mechanical and fenced. */
  label: string;
  source: string;
  provenance: 'grant';
  /** ISO, when the grant record carries one. */
  grantedAt: string | null;
  /** What the grant was made FOR, when it has a subject. Fenced. */
  grantedFor: { kind: 'skill' | 'connection'; id: string } | null;
  /**
   * False when this deployment has no writer for that grant kind. The control
   * is then absent rather than present-and-inert: a Revoke button that revokes
   * nothing is worse than no button.
   */
  revocable: boolean;
}

/**
 * One "This week" number — design §4.4.
 *
 * `definition` is the row's WRITTEN definition, shipped alongside the number
 * and shown to the reader. "You overruled it: 1" is the most valuable number on
 * this surface and it is worthless the moment its meaning drifts, so the
 * meaning travels with it instead of living only in a design doc.
 */
export interface CounterRow {
  id: string;
  label: string;
  value: number;
  definition: string;
}

/**
 * How one of this surface's reads went.
 *
 * On this surface an empty array is a CLAIM, so "nothing" is not one state.
 * `unavailable` means this deployment has no producer for that read at all;
 * `failed` means it has one and we could not read it. Both are answers a human
 * can act on; a bare `[]` standing in for either is a quiet lie.
 *
 * Deliberately NOT named `Rail*`. It started on the rail's three blocks and
 * the detail panel's approval read needed exactly the same three answers — a
 * `Rail`-prefixed name on a field that is not a rail section is how a second,
 * identical copy of this union gets written six weeks from now.
 */
export type WorkspaceReadStatus = 'ok' | 'unavailable' | 'failed';

/** The "Right now" line — see `@ax/agent-activity`'s `AgentActivity`. */
export interface RailActivity {
  phrase: string;
  counter: { done: number; total: number; unit: string } | null;
  startedAt: string;
  /**
   * The step stream went quiet long enough that `phrase` stopped being a claim
   * about the present. When true, `phrase` is the system's own replacement line
   * and the counter is gone — a counter frozen at 29 of 41 is a claim that
   * stopped being true.
   */
  stale: boolean;
  /** Which tier produced the phrase. Debugging only; nothing renders it. */
  source: 'declared' | 'tool' | 'trigger';
}

/** `GET /api/workspace/agents/:agentId/rail`. */
export interface AgentRailData {
  activity: { status: WorkspaceReadStatus; activity: RailActivity | null };
  permissions: {
    status: WorkspaceReadStatus;
    rows: PermissionRow[];
    /**
     * True when at least one source of reach could not be read, so this list is
     * known-incomplete. H4 again: a short list must never be allowed to read as
     * a short leash, so the surface says so out loud.
     */
    incomplete: boolean;
    /**
     * True when the agent carries NO tool allow-list — the wildcard scope every
     * bootstrapped personal agent gets. Its reach is then whatever this
     * deployment has installed, present and future, and the list below is a
     * snapshot of that rather than a boundary.
     *
     * Deliberately a separate flag from `incomplete`. "We could not read one of
     * the sources" and "there is no restriction to read" are different facts, a
     * reader needs to be told which, and one boolean carrying both would be a
     * banner that means two things.
     */
    unrestrictedTools: boolean;
  };
  grants: { status: WorkspaceReadStatus; rows: GrantRow[]; incomplete: boolean };
  counters: {
    status: WorkspaceReadStatus;
    rows: CounterRow[];
    /** How many days back the numbers cover. */
    windowDays: number;
  };
}

export type ActivityKind =
  | 'done'
  | 'held'
  | 'approved'
  | 'dismissed'
  | 'working'
  // Nobody answered in time (TASK-447). Its own value rather than a reuse of
  // `dismissed`: the icon and tone happen to be quiet for both, but a kind is
  // what the row MEANS, and "you turned this down" and "you never got to it"
  // are different things to the person reading their own history.
  | 'expired'
  | 'stopped';

/**
 * One row of the single event feed (design §7).
 *
 * There is deliberately no `day` and no `time`. The prototype carried both as
 * SERVER-COMPUTED display strings — "Today", "4:12 PM" — which are only right
 * for a reader sitting in the server's timezone. Everyone else got a row
 * confidently filed under the wrong day. The row now carries the instant and
 * nothing else; the CLIENT buckets by its own local date and formats its own
 * clock. A display string is a rendering decision, and rendering decisions do
 * not belong on the wire.
 *
 * `id` is a composite of the things that identify the event on any backend
 * (agent, routine path, instant). It is NOT the fire's row id: that is a
 * `BIGSERIAL`, i.e. storage vocabulary, and it never crosses this wire.
 */
export interface ActivityEvent {
  id: string;
  agentId: string;
  /** ISO instant. The client buckets by LOCAL date — see above. */
  at: string;
  text: string;
  kind: ActivityKind;
  /**
   * The second line: the real error on a `stopped` row, `null` otherwise.
   * Carried separately from `text` so a failure keeps the same scannable
   * subject line as a success, and so nothing has to be assembled by string
   * surgery to say what went wrong.
   */
  detail: string | null;
  tag: string | null;
  /** Links a receipt back to the decision that produced it. */
  decisionId: string | null;
}

/**
 * One file the person attached to a message, as the transcript remembers it
 * (TASK-424).
 *
 * This is the user's own record of what they sent, so it is carried on the
 * message rather than derived at render time: the walk found a turn whose image
 * reached the model and left NOTHING on screen, which made the agent look like
 * it was describing a picture nobody had sent.
 *
 * `path` is `null` in exactly one case — the live frame, between the composer
 * handing the message over and `attachments:commit` minting a durable
 * workspace path. The name and type are known from the person's own pick in
 * that window, and a chip that names the file is the honest thing to draw;
 * the thumbnail arrives with the path on the next read. Null is therefore
 * "no download URL yet", never "no attachment" — the renderer must still show
 * the name.
 */
export interface ThreadAttachment {
  path: string | null;
  displayName: string;
  mediaType: string;
  sizeBytes?: number;
}

export type ThreadMessage =
  | {
      kind: 'agent';
      id: string;
      text: string;
      /**
       * An ISO-8601 instant, the same vocabulary `ActivityEvent.at` uses
       * (TASK-435) — the client formats it, the server never does (see that
       * type's doc comment for why: "a display string is a rendering
       * decision, and rendering decisions do not belong on the wire"). The
       * empty string means "no committed instant yet": the LIVE streaming
       * frame has no server-assigned `createdAt` until the turn commits, and
       * a renderer must draw no clock at all for it rather than a clock
       * reading midnight-UTC-epoch or an empty row.
       */
      at: string;
    }
  | {
      kind: 'user';
      id: string;
      text: string;
      /**
       * Files this message carried. Omitted / empty on the overwhelming
       * majority of turns — a plain text message is byte-identical to before.
       */
      attachments?: readonly ThreadAttachment[];
    }
  | {
      kind: 'steps';
      id: string;
      text: string;
      /** See `at` on the `agent` variant above — same field, same rule. */
      at: string;
      stepsLabel: string;
      steps: WorkspaceStep[];
    }
  | { kind: 'approval'; id: string; decisionId: string }
  | { kind: 'status'; id: string; text: string }
  /**
   * A turn that ended badly, replayed from the durable record (TASK-498).
   *
   * THIS IS THE RELOAD HALF OF FAULT A, and before this card there wasn't one.
   * `chat:turn-error` has been persisted as a host-only display event since
   * TASK-66, and `conversations:get` has projected it onto `displayEvents`
   * ever since — but NOTHING in the repo read that field. So a turn that died
   * flipped the live surface out of "Thinking…" and then vanished completely
   * on the next read: the person's message sat alone, and the failure looked
   * like a reply that had simply never been asked for.
   *
   * `reason` IS A STABLE CODE AND NEVER PROSE — the same backend-agnostic
   * vocabulary the SSE `error` frame carries (`chat-run-timeout`,
   * `dev-service-failed`, …), wired the way `phase` is: the wire says what
   * happened, the client says it in words. `lib/turn-error-labels.ts` owns
   * the wording for the live frame and this row alike, so a reloaded failure
   * cannot word itself differently from the live one it replaces.
   *
   * `detail` is the optional TASK-160 author-facing line underneath —
   * untrusted text, bounded and sanitized server-side, rendered as a plain
   * text node and never as markup.
   */
  | {
      kind: 'error';
      id: string;
      reason: string;
      detail?: string;
      /** See `at` on the `agent` variant above — same field, same rule. */
      at: string;
    }
  /** The compaction summarize rung, surfaced. */
  /**
   * Compaction's summarize rung, surfaced. NOTHING PRODUCES THIS TODAY: the
   * rung-3 summarizer rewrites the transcript rather than recording how many
   * turns it swallowed, so the host has no count to report and the route never
   * emits a fold. The renderer is kept because the variant is real and the
   * moment compaction records a count this is where it lands — but until then
   * the honest number of folded turns is "unknown", not zero, which is why the
   * prototype's `0 messages folded` marker was deleted rather than defaulted.
   *
   * `approval` NOW HAS A PRODUCER (AW-11): `GET /api/workspace/agents/:id`
   * appends one message per still-open decision on the conversation it read,
   * so the in-thread card is the same row the Today queue shows rather than a
   * second copy of it. `steps` GOT ONE TOO (TASK-352): `lib/workspace-steps.ts`
   * shapes it for the reload path (`buildThread`) and the live stream
   * (`AgentView`) alike. `error` GOT ONE IN TASK-498: `buildThread` now reads
   * the persisted `turn-error` display events off `conversations:get` and
   * interleaves them with the turns. `status` (AW-8) is the one still
   * waiting, and `fold` above. This list is meant to be exhaustive — if you add a
   * producer, say so here, because the next card scoped off this comment
   * will believe it.
   */
  | { kind: 'fold'; id: string; text: string };

/**
 * Memory is split because two different writers own it. Collapsing them into
 * one editor invites a human to hand-write something the agent's rollup later
 * eats.
 *
 *   - `rules`   — the human's, verbatim, always injected, safe to hand-edit.
 *   - `learned` — the agent's, subject to rollup and GC. Read-only on this
 *                 surface, and the UI says why: it is folded and dropped over
 *                 time, so anything that needs to stick belongs in `rules`.
 */
export interface MemoryDoc {
  name: string;
  scope: 'rules' | 'learned';
  body: string;
}

/**
 * How the Memory tab's two reads went — status first, rows second.
 *
 * `MemoryDoc[]` on its own could not carry this, and the gap was a live bug
 * (TASK-417). On a deployment with no memory plugin loaded at all, the server
 * answered `[]` and the tab drew two different lies out of it: the agent's half
 * rendered "Nothing yet", which is a claim about the agent, and the human's
 * half offered "try again in a moment", which is a promise nothing can keep —
 * there is no backend to come back. An empty array is a CLAIM on this surface;
 * see `WorkspaceReadStatus` for the same argument made once for the rail.
 *
 * The two tiers carry their own status rather than sharing one because they are
 * two different service hooks (`memory:rules:read`, `memory:learned:read`) and
 * either can be absent or fail on its own. One status for both would have to
 * pick a winner, and the loser's section would then word itself off a fact that
 * is not about it.
 *
 * THE SHAPE IS `{ status, payload }`, FLAT, and deliberately not a
 * discriminated union. A union would make `ok`-with-no-doc unrepresentable,
 * which is tempting — but every other read on this surface (`activity`,
 * `permissions`, `grants`, `counters` on `AgentRailData`) is flat, and one
 * union in the middle of four flat siblings costs more in surprise than it
 * buys in precision. `readMemory` sets `doc` on every `ok`, so the impossible
 * pair is a contract the producer keeps rather than one the type enforces, and
 * `AgentMemory` still handles it defensively — see the comment at that call
 * site for which of the three it picks and why.
 *
 * So: `rules.doc` is non-null whenever `rules.status === 'ok'`, and the editor
 * appears only over storage we actually read. `learned.docs` is meaningful only
 * when `learned.status === 'ok'`; on any other status it is empty and means
 * nothing.
 */
export interface AgentMemoryRead {
  rules: { status: WorkspaceReadStatus; doc: MemoryDoc | null };
  learned: { status: WorkspaceReadStatus; docs: MemoryDoc[] };
  factsAvailable?: boolean;
  factsVisibility?: 'personal' | 'team';
}

export interface FactMemoryStatement {
  id: string;
  about: string;
  relation: string;
  value: string;
  when: string;
  until?: string;
  kind?: string;
  slot?: string;
  closedBy?: string;
  closure?: 'replaced' | 'forgotten';
  whenText?: string;
  aboutText?: string;
}

export interface FactMemoryPage {
  statements: FactMemoryStatement[];
  degraded: string[];
  visibility?: 'personal' | 'team';
}

/**
 * One row in the Files tab's list.
 *
 * What the prototype's `WorkspaceFile` had and this does not: `meta`
 * ("2 KB · yesterday"), `title` (a heading distinct from the filename), and
 * `blocks` — a hand-shaped `['p' | 'h' | 'mono', string]` document. All four
 * were fixture conveniences with nothing behind them. The workspace listing
 * reports paths and only paths: no size, no timestamp, no separate title. A
 * `meta` line assembled from nothing would be the same class of lie as the
 * `folded: 0` that used to sit on `PastConversation`.
 *
 * The two fields are NOT the same field twice:
 *   - `path` is the key the client sends back to open the file. Raw, opaque,
 *     never rendered.
 *   - `name` is the label, fenced server-side. A filename is agent-authored
 *     text and a file list is the classic Trojan-source surface.
 */
export interface WorkspaceFileSummary {
  path: string;
  name: string;
}

/**
 * One child of a directory in the agent's DURABLE user-files tier.
 *
 * A different tier from `WorkspaceFileSummary` above, and the difference
 * matters: that one is the git-backed tier AX manages, this one is the agent's
 * cwd and HOME — where a deliverable lands when nobody said where.
 *
 * Same `path` / `name` split, same reason. `path` is the raw key, already
 * joined onto its parent by the server, and it is what goes back on the wire.
 * `name` is the fenced label and is the only one of the two ever drawn.
 */
export interface UserFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
}

/**
 * One answer from the durable tier: a directory's children, or a file's text.
 *
 * Discriminated because a tree navigator does not know which it clicked until
 * the server says so — the backing hook answers per PATH, not per kind.
 */
export type UserFilesAnswer =
  | {
      kind: 'dir';
      /** The raw key this answers for. `''` is the tier root. */
      path: string;
      name: string;
      entries: UserFileEntry[];
      /** `true` when the directory holds more children than one response carries. */
      truncated: boolean;
    }
  | {
      kind: 'file';
      path: string;
      name: string;
      body: string | null;
      clipped: 'binary' | 'too-large' | null;
    };

/** One file's text, as the server is willing to show it. */
export interface WorkspaceFileBody {
  path: string;
  name: string;
  /** `null` when there is no text to show — see `clipped`. */
  body: string | null;
  /**
   * Why `body` is missing or short. `null` means the body is the whole file,
   * and that is a promise the tab repeats to the reader.
   */
  clipped: 'binary' | 'too-large' | null;
}

/**
 * One row in the rail's "Previous conversations" list — a pointer, not a copy.
 *
 * There is deliberately no `msgs` and no `folded`:
 *
 *   - the transcript is fetched on demand, by re-reading
 *     `GET /api/workspace/agents/:agentId?conversationId=<id>`. Carrying it
 *     inline meant every roster response shipped every past transcript, and
 *     the field that actually shipped was `[]` — an empty array renders as
 *     "this conversation had nothing in it", which is a claim, not an absence.
 *   - `folded` (turns compaction summarised away before this excerpt) had no
 *     producer at all. The rung-3 summarizer REWRITES the transcript rather
 *     than recording how many turns it swallowed, so every row read `0` and
 *     the UI printed "0 messages folded" over a real conversation. It comes
 *     back if and when compaction records that count on the conversation row.
 */
export interface PastConversation {
  id: string;
  title: string;
  /**
   * An ISO-8601 instant, not a formatted string (TASK-435): this used to be
   * `meta`, a `relativeDay(...)` string the SERVER computed in its own
   * timezone. Same defect and same fix as `ThreadMessage.at` above — see
   * `ActivityEvent`'s doc comment for the rule both are following. The
   * renderer turns this into "today" / "3 days ago" via `relativeDay` in
   * `lib/workspace-time.ts`, now run on the reader's clock.
   */
  lastActivityAt: string;
}

/**
 * How long an approve/dismiss can be taken back — the SURFACE's half of it:
 * how long the undo affordance stays on screen, counted from the server's
 * `resolvedAt`.
 *
 * `@ax/decisions` owns the ENFORCING twin, and the two numbers agreeing is not
 * what makes this correct. The server refuses a late undo whatever this
 * constant says, and it also tells us up front whether a given row can be taken
 * back at all (`Decision.undoable`). This value only decides when the button
 * stops being offered — if it ever drifted, the failure is a button that lingers
 * a second too long and is politely refused, not an undo that silently does
 * nothing.
 */
export const UNDO_WINDOW_MS = 10_000;
