import { randomUUID } from 'node:crypto';
import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type Plugin,
  type ToolCall,
} from '@ax/core';
import type { Kysely } from 'kysely';
import {
  conversationChannel,
  createAttendanceResolver,
  CONVERSATION_METADATA_HOOK,
} from './attendance.js';
import { deliverResolution, SESSION_QUEUE_HOOK, validContinuationReqId } from './delivery.js';
import {
  reclaimStrandedReplays,
  runDueDeliveries,
  runDueReplays,
  sweepExpired,
} from './expiry.js';
import { auditFreshnessPairs, checkFreshness } from './freshness.js';
import {
  approveDecision,
  dismissDecision,
  undoDecision,
  UNDO_WINDOW_MS,
  type ApproveWorld,
} from './machine.js';
import { runDecisionsMigration, type DecisionsDatabase } from './migrations.js';
import { createPreCallSubscriber, PLUGIN_NAME, type PolicyAnswer } from './pre-call.js';
import { receiptFor } from './receipts.js';
import { replayContext, settleReplay } from './replay.js';
import {
  createDecisionsStore,
  DuplicateAuthorisationError,
  type DecisionStore,
} from './store.js';
import { CLAIM_REFUSED_DETAIL } from './templates.js';
import { CONNECTOR_TOOL_LABELS_HOOK } from './tool-label.js';
import {
  DecisionsApproveOutputSchema,
  DecisionsCountOutputSchema,
  DecisionsDismissOutputSchema,
  DecisionsGetOutputSchema,
  DecisionsListOutputSchema,
  DecisionsRecentReceiptsOutputSchema,
  DecisionsSweepOutputSchema,
  DecisionsUndoOutputSchema,
  type Attendance,
  type Decision,
  type DecisionsApproveInput,
  type DecisionsApproveOutput,
  type DecisionsCountInput,
  type DecisionsCountOutput,
  type DecisionsDismissInput,
  type DecisionsDismissOutput,
  type DecisionsGetInput,
  type DecisionsGetOutput,
  type DecisionsListInput,
  type DecisionsListOutput,
  type DecisionsRecentReceiptsInput,
  type DecisionsRecentReceiptsOutput,
  type DecisionsSweepInput,
  type DecisionsSweepOutput,
  type DecisionsUndoInput,
  type DecisionsUndoOutput,
} from './types.js';

/**
 * How long a held call waits for a person before it stops being a live
 * question. Two days: long enough to survive a weekend-adjacent hold, short
 * enough that the Today queue is not an archive.
 */
export const DEFAULT_DECISION_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * How often the maintenance sweep runs. Matches the routines tick's default,
 * because it is doing the same kind of work and there is no reason for two
 * different answers to "how quickly does a timer notice something".
 *
 * The floor that matters is the undo window (10 s): a deferred replay is late
 * by at most one interval, and being a few seconds late to send is fine.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 5_000;

/**
 * How long after the undo window's close the TASK-574 nudge runs its pass.
 * Enough to be past the due-time on this host's clock through timer jitter;
 * small enough that nobody waits on it.
 */
export const NUDGE_MARGIN_MS = 250;

/**
 * The receipt page size, and its ceiling.
 *
 * The caller asks and we decide — a page size that arrives from a query string
 * is untrusted input, and an unbounded one is a read that can be pointed at the
 * whole table. The ceiling is generous because the Activity feed's own cap is
 * 100 and it fans out across a roster; anything past that is not a page.
 */
export const DEFAULT_RECEIPT_LIMIT = 50;
export const MAX_RECEIPT_LIMIT = 200;

function clampReceiptLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_RECEIPT_LIMIT;
  return Math.min(MAX_RECEIPT_LIMIT, Math.max(1, Math.floor(limit)));
}

export interface DecisionsPluginOptions {
  /** Time seam. */
  now?: () => Date;
  /** Id seam. Tests only — production uses the host-generated form below. */
  idGen?: () => string;
  ttlMs?: number;
  /**
   * Attendance seam. Production leaves it unset and gets
   * `createAttendanceResolver(bus)` — the conversation's own channel (AW-6).
   * Tests inject a resolver so they do not need a conversations store.
   */
  attendanceFor?: (ctx: AgentContext) => Attendance | Promise<Attendance>;
  /**
   * Maintenance-sweep cadence. `0` disables the timer entirely — tests drive
   * `decisions:sweep` directly rather than racing a clock.
   */
  sweepIntervalMs?: number;
  /**
   * TASK-574 — how long after an attended approval the one-shot nudge sweep
   * runs. Production leaves it unset (`UNDO_WINDOW_MS + NUDGE_MARGIN_MS`).
   * Tests shorten it rather than wait ten real seconds. Only armed when the
   * interval sweep is (`sweepIntervalMs > 0`).
   */
  deliveryNudgeMs?: number;
}

/**
 * Host-generated decision id: `dec_` + 32 hex.
 *
 * The id shape is a security property, not a style choice. It is interpolated
 * UNESCAPED into the `hold` note, which is emitted on the runner's stderr and
 * read back by the model. Deriving it from anything the model wrote — the tool
 * name, a field of `call.input` — would hand model output a path onto that
 * line. `randomUUID` is the whole source.
 */
function newDecisionId(): string {
  return `dec_${randomUUID().replace(/-/g, '')}`;
}

function requireField(value: string | undefined, name: string): string {
  if (!value) {
    throw new PluginError({
      code: 'missing-field',
      plugin: PLUGIN_NAME,
      message: `${name} is required`,
    });
  }
  return value;
}

/**
 * A field that has to be an instant — checked HERE, never at the database.
 *
 * `decisions:count`'s window arrives from a caller that computed it, and the
 * one caller today is careful. A hook is reachable by everything on the bus
 * though, and an unparseable string becomes an `Invalid Date` on its way into
 * the query: the driver may throw, or may serialise it into a bound that
 * matches everything. The second outcome is the bad one — a window that
 * silently becomes "all of history" is the unbounded read a required `since`
 * exists to prevent, and it would report as a plausible number rather than as
 * a failure. Refused by name, before it can get near SQL.
 */
function requireInstant(value: string | undefined, name: string): string {
  const raw = requireField(value, name);
  if (Number.isNaN(Date.parse(raw))) {
    throw new PluginError({
      code: 'invalid-field',
      plugin: PLUGIN_NAME,
      message: `${name} must be an ISO instant`,
    });
  }
  return raw;
}

export function createDecisionsPlugin(opts?: DecisionsPluginOptions): Plugin {
  const now = opts?.now ?? (() => new Date());
  const idGen = opts?.idGen ?? newDecisionId;
  const ttlMs = opts?.ttlMs ?? DEFAULT_DECISION_TTL_MS;
  const sweepIntervalMs = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const deliveryNudgeMs = opts?.deliveryNudgeMs ?? UNDO_WINDOW_MS + NUDGE_MARGIN_MS;
  let store: DecisionStore | undefined;
  let busRef: { unsubscribe(hook: string, plugin: string): number } | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * TASK-574 — one-shot wake-ups at the close of an attended approval's undo
   * window, so the warm agent is told ~10 s after the click rather than up to
   * one sweep interval later. A LATENCY aid only: the durable due-time and the
   * interval sweep are the guarantee (patterns: a grace period is a due-time
   * plus a sweep, never a `setTimeout`), and a nudge lost to a restart or
   * landing on another replica costs at most one interval.
   */
  const nudges = new Set<ReturnType<typeof setTimeout>>();
  let nudge: (() => void) | null = null;

  /**
   * Nothing ran and nothing is pending — the shape every "we did not act"
   * branch returns. Written once so a new branch cannot forget a field and
   * accidentally report `executed` from a stale default.
   */
  const inert = (decision: Decision | null): DecisionsApproveOutput => ({
    decision,
    executed: false,
    path: null,
    error: null,
    pendingUntil: null,
    // No turn runs on any inert path, so there is never a stream to watch.
    streamReqId: null,
  });

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'decisions:list',
        'decisions:count',
        'decisions:get',
        'decisions:recent-receipts-for-agent',
        'decisions:approve',
        'decisions:dismiss',
        'decisions:undo',
        'decisions:sweep',
      ],
      // `tool:execute:<name>` is deliberately ABSENT, and so are AW-7's
      // `tool-freshness:capture:<name>` / `tool-freshness:check:<name>`. All
      // three are the documented dynamic-service-hook exception — the hook name
      // depends on the recorded call, so no manifest can list it — and all three
      // are reached through `hasService` + `call`, exactly as
      // `tool.execute-host` does. A wildcard here would be a lie the
      // cycle-detector cannot check.
      //
      // They are not `optionalCalls` either, for the same reason: an
      // `optionalCalls` entry is a NAMED hook whose absence has a stated
      // degradation, and there is no name to write. What replaces that
      // documentation is `presets/k8s`' test asserting that the two producers
      // AW-7 ships are actually loaded — an unpaired or missing producer is
      // otherwise a silent, permanent downgrade nobody can catch.
      calls: ['database:get-instance', 'tool-policy:evaluate'],
      // OPTIONAL, not required, and the distinction is load-bearing in both
      // directions. A host with no conversations store has no channels to read
      // attendance from, so every decision is unattended — which is the
      // fail-safe, not a degradation worth failing a boot over. A host with no
      // session store has nowhere to deliver a resolution to, and the standing
      // authorisation on the row already covers that: the agent picks it up on
      // its next run. Declaring either as a hard `call` would make @ax/decisions
      // unloadable in a preset that is perfectly capable of running it.
      optionalCalls: [
        {
          // TASK-744 — names the connector behind a held connector tool
          // (`mcp.<toolNamespace>.<tool>`) so the approval card reads
          // "Linear · Create issue" instead of an opaque hash.
          hook: CONNECTOR_TOOL_LABELS_HOOK,
          degradation:
            'A held connector tool with no capability clause is named by its tool name ' +
            'alone ("Create issue"), without the connector it belongs to.',
        },
        {
          hook: CONVERSATION_METADATA_HOOK,
          degradation:
            'Attendance cannot be derived from the conversation channel; every held ' +
            'call is treated as unattended (the fail-safe) and approvals replay ' +
            'host-side instead of returning to a warm agent.',
        },
        {
          hook: SESSION_QUEUE_HOOK,
          degradation:
            'A resolved attended decision is not delivered to the warm agent, so it ' +
            'is never told a person answered. An approval then falls back to the ' +
            'host replay and the call is made host-side; only a call the host ' +
            'cannot replay at all is left standing on the row for the agent to ' +
            'perform on its next run. A dismissal loses its narration and nothing ' +
            'else — there is no authorisation behind it.',
        },
      ],
      // `agents:deleted` (TASK-718): `@ax/agents` fires it after the agent row
      // is gone; `decisions_v1_decisions` has no FK to it, so this subscriber is
      // the only cleanup.
      subscribes: ['tool:pre-call', 'agents:deleted'],
    },

    async init({ bus }) {
      const initCtx = makeAgentContext({
        sessionId: 'init',
        agentId: PLUGIN_NAME,
        userId: 'system',
      });
      const { db } = await bus.call<unknown, { db: Kysely<unknown> }>(
        'database:get-instance',
        initCtx,
        {},
      );
      const typed = db as Kysely<DecisionsDatabase>;
      await runDecisionsMigration(typed);
      store = createDecisionsStore(typed);
      busRef = bus;

      // ---------------------------------------------------------------------
      // The gate.
      //
      // Registered LAST among this preset's `tool:pre-call` subscribers, on
      // purpose: `HookBus.fire` stops at the first rejection, so a hold
      // returned before another subscriber's outright deny would pre-empt it —
      // asking a human whether to permit something the system already forbids.
      // `presets/k8s` asserts the ordering.
      // ---------------------------------------------------------------------
      const subscriber = createPreCallSubscriber({
        // The half-wired window on `tool-policy:evaluate` (opened deliberately
        // by TASK-224) closes HERE. This is its production caller.
        evaluate: async (ctx, call): Promise<PolicyAnswer> =>
          bus.call<{ call: { name: string; input: unknown }; agentId: string }, PolicyAnswer>(
            'tool-policy:evaluate',
            ctx,
            { call: { name: call.name, input: call.input }, agentId: ctx.agentId },
          ),
        store,
        now,
        idGen,
        ttlMs,
        // AW-6: attendance is the conversation's channel, resolved through the
        // bus. AW-4's `ctx.source === 'routine'` default is gone — it answered
        // "was this a scheduled fire", which is a different question that
        // happened to have the same answer while `packages/` held exactly two
        // channels.
        attendanceFor: opts?.attendanceFor ?? createAttendanceResolver(bus),
        bus,
        connectorNameFor: async (ctx, toolNamespace) => {
          if (!bus.hasService(CONNECTOR_TOOL_LABELS_HOOK)) return null;
          const out = await bus.call<
            { userId: string },
            { connectors: Array<{ toolNamespace: string; name: string }> }
          >(CONNECTOR_TOOL_LABELS_HOOK, ctx, { userId: ctx.userId });
          return out.connectors.find((c) => c.toolNamespace === toolNamespace)?.name ?? null;
        },
      });
      bus.subscribe<ToolCall>('tool:pre-call', PLUGIN_NAME, subscriber);

      // ---------------------------------------------------------------------
      // TASK-718 — a deleted agent's decisions must go with it.
      //
      // Payload (declared locally, no cross-plugin import): `{ agentId,
      // ownerId, ownerType }`; only `agentId` matters, and it is keyed on ALONE
      // because a team agent raises holds for several owner users. A different
      // hook from the gate, so the `tool:pre-call` ordering note above does not
      // apply to it.
      //
      // K10: a subscriber must never throw. A failed purge is logged loudly and
      // swallowed — the agent is already gone, and there is nobody to tell.
      // ---------------------------------------------------------------------
      const decisionStore = store;
      bus.subscribe<unknown>('agents:deleted', PLUGIN_NAME, async (ctx, payload) => {
        const agentId = (payload as { agentId?: unknown } | null | undefined)?.agentId;
        if (typeof agentId !== 'string' || agentId.length === 0) {
          ctx.logger.warn('decisions_purge_for_deleted_agent_skipped', {
            reason: 'agents:deleted payload has no non-empty string agentId',
          });
          return undefined;
        }
        try {
          const { deleted } = await decisionStore.deleteAllForAgent(agentId);
          ctx.logger.info('decisions_purged_for_deleted_agent', { agentId, deleted });
        } catch (err) {
          ctx.logger.error('decisions_purge_for_deleted_agent_failed', { agentId, err });
        }
        return undefined;
      });

      // ---------------------------------------------------------------------
      // AW-7 — the freshness producers have to come in PAIRS.
      //
      // A `check` hook with no matching `capture` never guards anything and
      // never says so: nothing writes the predicate it exists to re-read, so
      // every decision for that tool is silently unguarded while the surface
      // looks fine. It LOGS and never throws — a tool that wired itself up
      // wrong must not stop the host booting.
      //
      // Run twice, and both times are needed. At init it catches every producer
      // that loaded BEFORE this plugin. But plugin init order is the preset's
      // array order, and a producer pushed after @ax/decisions (the k8s
      // preset's `connector_propose` is exactly that) has not registered
      // anything yet — so the audit runs again on the first maintenance pass,
      // by which time the whole boot is done. `reportedPairs` keeps each gap to
      // one log line however many times it is seen.
      // ---------------------------------------------------------------------
      const reportedPairs = new Set<string>();
      auditFreshnessPairs(bus, initCtx, reportedPairs);
      let auditedAfterBoot = false;

      /** One maintenance pass: expire what nobody answered, run what is due. */
      const runSweep = async (
        ctx: AgentContext,
        limit?: number,
      ): Promise<DecisionsSweepOutput> => {
        if (!auditedAfterBoot) {
          auditedAfterBoot = true;
          auditFreshnessPairs(bus, ctx, reportedPairs);
        }
        return {
          expired: await sweepExpired(store!, now()),
          // BEFORE the due replays, not after, and the order is not cosmetic.
          // A stranded flight holds the `(agent, fingerprint)` slot its own
          // decision needs; releasing it first means a re-held call approved
          // in the same window is already unblocked by the time anything else
          // in this pass runs. Nothing here runs a call, so putting it first
          // costs nothing and cannot reorder any outward action.
          reclaimed: await reclaimStrandedReplays({
            store: store!,
            now: now(),
            logCtx: ctx,
          }),
          replayed: await runDueReplays({
            store: store!,
            bus,
            now: now(),
            limit,
            logCtx: ctx,
          }),
          // AFTER the replays: a delivery that finds nobody there falls back
          // to a host replay of its own, and nothing about that should wait on
          // or reorder the irreversible calls already due in this pass.
          delivered: await runDueDeliveries({
            store: store!,
            bus,
            now: now(),
            limit,
            logCtx: ctx,
          }),
        };
      };

      // ---------------------------------------------------------------------
      // Reads
      // ---------------------------------------------------------------------
      bus.registerService<DecisionsListInput, DecisionsListOutput>(
        'decisions:list',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const ownerUserId = requireField(input.userId, 'userId');
          // Sweep before reading. An expired decision that still renders as
          // pending is a button that lies about what it will do.
          await store!.expireDue(now().toISOString());
          return {
            decisions: await store!.list({
              ownerUserId,
              agentId: input.agentId,
              status: input.status,
            }),
          };
        },
        { returns: DecisionsListOutputSchema },
      );

      /**
       * HOW MANY this agent raised for this person in a window — one read.
       *
       * THE WHOLE POINT IS THE ARITHMETIC ABOVE IT (TASK-266). The workspace
       * rail draws one integer: "brought to you in the last 7 days, whatever
       * you decided, including the ones that expired." `decisions:list` takes
       * ONE exact status, so the rail answered that by walking all seven — and
       * every one of those reads swept the expiry table before returning.
       * Seven writes to draw one number, every time somebody opened an agent's
       * rail.
       *
       * AND THIS ONE DOES NOT SWEEP, which is the half worth reading twice.
       * Skipping it is not a speed-for-freshness trade here, because there is
       * no freshness to trade: the sweep rewrites `status` and stamps
       * `resolvedAt`, it never touches `createdAt` and never deletes a row, and
       * this count filters on `createdAt` and names no status. A row that
       * expired one millisecond ago is counted identically before and after the
       * sweep that moves it. The number is exact, not bounded-stale, and
       * `store.test.ts` pins that by counting either side of an `expireDue`.
       *
       * That is a property of THIS query, not a general licence: a count that
       * ever filters by status is a count expiry can move, and whoever adds one
       * has to answer the staleness question this read gets to skip.
       *
       * Expiry itself is unaffected. It runs on the maintenance timer
       * (`DEFAULT_SWEEP_INTERVAL_MS`), on `decisions:sweep` for an operator or
       * a test, and still on `decisions:list` — the queue read, where a
       * `pending` card that has actually expired is a button that lies about
       * what it will do. Nothing depended on the counter's incidental sweeps.
       */
      bus.registerService<DecisionsCountInput, DecisionsCountOutput>(
        'decisions:count',
        PLUGIN_NAME,
        async (_ctx, input) => ({
          count: await store!.count({
            ownerUserId: requireField(input.userId, 'userId'),
            agentId: input.agentId,
            since: requireInstant(input.since, 'since'),
          }),
        }),
        { returns: DecisionsCountOutputSchema },
      );

      bus.registerService<DecisionsGetInput, DecisionsGetOutput>(
        'decisions:get',
        PLUGIN_NAME,
        async (_ctx, input) => ({
          // Owner-scoped read: another user's decision is `null`, not a 403 —
          // "you cannot see this" and "this does not exist" are the same
          // answer to someone who is not the owner.
          decision: await store!.get(
            requireField(input.decisionId, 'decisionId'),
            requireField(input.userId, 'userId'),
          ),
        }),
        { returns: DecisionsGetOutputSchema },
      );

      /**
       * The receipts, DERIVED from the rows, newest first, one page at a time.
       *
       * This is what replaced `decisions:executed` (TASK-279). The old hook
       * pushed a receipt at whoever was listening the instant an outcome
       * landed; nobody ever was, so no receipt existed anywhere and undo's
       * retraction fired into the void. Reading them off the rows instead means
       * there is exactly one place the outcome is recorded, undo removes a
       * receipt by simply putting the row back, and a reader that was offline
       * for the fire still sees everything that happened.
       *
       * Paged to match `routines:recent-fires-for-agent` field for field,
       * because the Activity feed merges the two into one time-ordered
       * collection and two sources that page differently cannot be merged
       * without losing rows at the seam.
       */
      bus.registerService<DecisionsRecentReceiptsInput, DecisionsRecentReceiptsOutput>(
        'decisions:recent-receipts-for-agent',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const ownerUserId = requireField(input.userId, 'userId');
          const agentId = requireField(input.agentId, 'agentId');
          const rows = await store!.listReceiptCandidates({
            ownerUserId,
            agentId,
            limit: clampReceiptLimit(input.limit),
            before: input.before,
          });
          // `receiptFor` cannot answer null for anything the store selected —
          // the query is the same rule — but it is typed to allow it and this
          // is a read, not a claim. Filtering rather than asserting means a
          // future divergence costs a missing row, not a crashed feed.
          return {
            receipts: rows
              .map(receiptFor)
              .filter((r): r is NonNullable<typeof r> => r !== null),
          };
        },
        { returns: DecisionsRecentReceiptsOutputSchema },
      );

      // ---------------------------------------------------------------------
      // Resolutions
      // ---------------------------------------------------------------------
      bus.registerService<DecisionsApproveInput, DecisionsApproveOutput>(
        'decisions:approve',
        PLUGIN_NAME,
        async (ctx, input) => {
          const decisionId = requireField(input.decisionId, 'decisionId');
          const ownerUserId = requireField(input.userId, 'userId');
          const current = await store!.get(decisionId, ownerUserId);
          if (current === null) return inert(null);

          // Already resolved — expired, dismissed, or approved a moment ago in
          // another tab. The click is absorbed silently and we hand back what
          // is actually STORED. Returning null here would report "no such
          // decision" for a decision the caller is looking at.
          if (current.status !== 'pending' && current.status !== 'stale') {
            return inert(current);
          }

          const nowIso = now().toISOString();

          // -----------------------------------------------------------------
          // AW-7 — THE FRESHNESS GUARD, BEFORE ANYTHING IS CLAIMED OR RUN.
          //
          // The world is re-read here and nowhere else: the machine is pure, so
          // it can only compare what it is handed. A decision with no predicate
          // hands it an EMPTY world, which the guard reads as "no observation"
          // rather than pretending one matched.
          //
          // The read runs under a ctx built for the DECISION's owner and agent
          // — never the approving request's. Hooks downstream of a producer
          // route by `agentId` (TASK-257 — `workspace:apply` no longer keys on
          // `userId` too), so checking with the wrong ctx would re-read
          // somebody else's world and answer confidently about it. This repo
          // has been bitten by exactly that on `workspace:apply`.
          //
          // `checkFreshness` is TOTAL and fails CLOSED: a check hook that is
          // gone, throws, or answers unreadably resolves to a value that cannot
          // match, which re-opens the decision and runs nothing. An unreadable
          // world is a changed world.
          // -----------------------------------------------------------------
          let world: ApproveWorld = { now: nowIso, freshness: {} };
          if (current.freshness !== null) {
            const observed = await checkFreshness(
              bus,
              replayContext(current),
              current.call.name,
              current.freshness,
            );
            world = {
              now: nowIso,
              freshness: { [current.freshness.kind]: observed.value },
              ...(observed.changed !== undefined
                ? { changed: { [current.freshness.kind]: observed.changed } }
                : {}),
            };
          }

          // The pure machine owns the rules: expiry, the freshness guard, and
          // "anything already resolved absorbs the click silently".
          const outcome = approveDecision(current, world);

          // Every branch re-reads on a null: a conditional update that changed
          // nothing means someone else resolved the row between our read and
          // our write, and the honest answer is their outcome, not ours.
          const settle = async (saved: Decision | null): Promise<DecisionsApproveOutput> =>
            inert(saved ?? (await store!.get(decisionId, ownerUserId)) ?? current);

          if (outcome.decision.status === 'expired') {
            return settle(await store!.markExpired(decisionId, nowIso));
          }
          if (outcome.decision.status === 'stale') {
            return settle(
              await store!.markStale(decisionId, {
                staleReason: outcome.decision.staleReason ?? 'The world changed.',
                freshness: outcome.decision.freshness,
              }),
            );
          }
          if (!outcome.executed) return inert(current);

          // -----------------------------------------------------------------
          // Which side runs it, decided BEFORE the claim so the row lands in
          // its terminal status in one write.
          //
          //   attended                  -> the agent is still warm; it
          //                                re-issues its own call and the
          //                                fingerprint gate authorises it once.
          //   unattended, no executor   -> the host physically cannot make this
          //                                call. `approved-pending-agent`: the
          //                                approval waits at the gate for the
          //                                agent's next run. NOT "Sent".
          //   unattended, irreversible  -> claim now, replay when the undo
          //                                window closes.
          //   unattended, reversible    -> claim now, replay now.
          //
          // ATTENDED IS TWO QUESTIONS AND THE ROW ANSWERS ONLY ONE (TASK-277).
          // `decision.attendance` is captured at hold time and says which
          // CHANNEL opened the conversation — so a web thread is `attended`
          // forever, including hours after its runner was reaped. Routing on
          // the row alone sent an idle-expired approval down the attended
          // branch anyway: the row was claimed `executed`, no replay was
          // scheduled, the delivery found no session and logged, and the call
          // never happened. The person's yes was consumed in silence.
          //
          // So the ROW says whether an agent could ever be there and the LIVE
          // READ below says whether one is, and both have to hold. The read is
          // gated on the stored value, so a routine-origin row costs nothing
          // extra — it can never be attended.
          //
          // `conversationChannel` answers null for every "we do not know": no
          // conversations store, an unreadable row, a throw. Null means
          // unattended, which means the host replays, which means THE CALL
          // STILL HAPPENS — the recoverable one of the two mistakes. See the
          // asymmetry at the top of `attendance.ts`.
          //
          // Under the DECISION's ctx, never the approving request's, for the
          // same reason the freshness read above uses one:
          // `conversations:get-metadata` pre-filters on `(conversationId,
          // userId)`, so an approver whose ctx named a different user would
          // read back nothing and be told, wrongly but plausibly, that the
          // session is gone.
          //
          // The undo window is honoured on BOTH paths now (TASK-574). On the
          // host path the replay waits for it; on the attended path the
          // hand-over to the warm agent does, because the agent re-issues its
          // own call the moment it hears — and once it has heard, no Undo can
          // recall that. What the attended window still cannot stop is an
          // agent woken by something ELSE inside it (a new message) re-issuing
          // the call on its own: the gate lets that through, the approval is
          // consumed, and the Undo is then refused rather than lying.
          // -----------------------------------------------------------------
          const liveSessionId =
            current.attendance === 'attended'
              ? ((
                  await conversationChannel(
                    bus,
                    replayContext(current),
                    current.conversationId,
                  )
                )?.activeSessionId ?? null)
              : null;
          const attended = liveSessionId !== null;
          const hasExecutor = bus.hasService(`tool:execute:${current.call.name}`);
          const parked = !attended && !hasExecutor;
          const deferred = !attended && hasExecutor && current.irreversible;
          const immediate = !attended && hasExecutor && !current.irreversible;
          const replayDueAt = deferred
            ? new Date(Date.parse(nowIso) + UNDO_WINDOW_MS).toISOString()
            : null;
          // TASK-574. The attended twin: when the warm agent gets told. The
          // continuation id is validated HERE, once, because it is stored for a
          // delivery ten seconds away and echoed to the caller now — the two
          // must be the same value.
          const deliveryDueAt = attended
            ? new Date(Date.parse(nowIso) + UNDO_WINDOW_MS).toISOString()
            : null;
          const continuationReqId = attended
            ? validContinuationReqId(input.continuationReqId)
            : null;
          if (attended && input.continuationReqId !== undefined && continuationReqId === null) {
            ctx.logger.warn('decision_delivery_dropped_bad_continuation', {
              plugin: PLUGIN_NAME,
              decisionId,
              outcome: 'approved',
            });
          }

          // THE CLAIM. One conditional UPDATE off the open statuses, so of two
          // concurrent approvals exactly one gets a row back — and only that one
          // is entitled to run anything.
          //
          // It can also THROW, and the throw is meaningful: the partial unique
          // index refuses a second unconsumed authorisation for the same
          // (agent, call shape). That happens when the agent held the SAME call
          // twice and a human approves both rows. Turning it into a 500 would
          // be the worst reading of it — the call is already authorised, and
          // nothing about that is an internal error. We absorb it and report
          // what is stored, exactly as we do when we lose the claim race.
          //
          // AND IT IS THE ONLY THROW THIS BRANCH SPEAKS FOR. `claimForApproval`
          // translates the index's refusal into `DuplicateAuthorisationError`
          // and lets every other failure through as itself, so the check below
          // is a real test of the cause rather than an assumption about it.
          // The first cut of this branch assumed: it answered "an identical
          // request is already approved" for anything the write threw. Under
          // exactly the turbulence this whole area exists for — eviction,
          // failover, load — that write can fail with a deadlock, a lock
          // timeout or a statement timeout, all of which are gone by the time
          // the re-read below runs. The person would then be told their
          // approval was not recorded because an identical one is pending,
          // and the correct recovery — press it again — is precisely what
          // that sentence talks them out of. A confident sentence about a
          // cause nobody checked is the defect this epic keeps producing.
          //
          // So a fault reaches the caller as a fault: it propagates, the bus
          // wraps it, and it surfaces as a 500 an operator can see. Losing an
          // approval loudly beats keeping it and lying about why.
          //
          // WHAT WE NO LONGER DO IS ABSORB IT IN SILENCE (TASK-253). The
          // benign reading above is not the only one: a replay stranded by a
          // host crash occupies the same slot and nothing will ever cash it,
          // so the refusal reached a person as an approve button that did
          // nothing and said nothing. The click is still absorbed — the row
          // stays open, because a decision this handler could not claim has
          // not been answered — but the answer now carries WHY. The reclaim
          // sweep is what eventually clears the stranded case; until it runs,
          // saying so is the difference between a slow recovery and an
          // invisible one.
          //
          // We do NOT try to tell the two apart here by reading the row that
          // holds the slot. That row is keyed on `(agent, fingerprint)` and
          // not on the owner, so on a team agent it can belong to somebody
          // else — and this handler has already established only that the
          // caller owns THIS decision.
          let claimed: Decision | null;
          try {
            claimed = await store!.claimForApproval(decisionId, {
              nowIso,
              status: parked ? 'approved-pending-agent' : 'executed',
              replayDueAt,
              // The host is taking this replay RIGHT NOW, so the row closes to
              // the agent's gate and to undo in the same statement that claims
              // it. Skipping this leaves a window — small, but exactly wide
              // enough for a concurrent byte-identical agent call to consume
              // the authorisation and run the call a second time.
              replayClaimedAt: immediate ? nowIso : null,
              deliveryDueAt,
              continuationReqId,
            });
          } catch (err) {
            if (!(err instanceof DuplicateAuthorisationError)) throw err;
            ctx.logger.warn('decision_claim_refused', {
              plugin: PLUGIN_NAME,
              decisionId,
              err: err instanceof Error ? err : new Error(String(err)),
            });
            return {
              ...(await settle(null)),
              // AUTHORED, and never the driver's own words. A unique-violation
              // message names the index, the table and the conflicting values —
              // one of which is a call fingerprint derived from model output.
              error: CLAIM_REFUSED_DETAIL,
            };
          }
          // We LOST the race. That is not "no such decision" — it is "somebody
          // else already resolved this one", and the honest answer is their
          // stored outcome.
          if (claimed === null) return settle(null);

          if (attended) {
            // AW-6, deferred (TASK-574): the warm agent is handed this as its
            // next inbox message once the undo window closes — the sweep does
            // it (`runDueDeliveries`), nudged at exactly the window's edge. It
            // then re-issues its own held call and the fingerprint gate
            // authorises that exactly once. Nothing has happened yet, so
            // nothing claims it has: no receipt is fired, and `pendingUntil`
            // tells the caller when the hand-over will be.
            //
            // The fallback for a session that is gone by then (TASK-277) moved
            // with the delivery: it is decided at delivery time, where the
            // answer is true, not here, ten seconds early.
            //
            // TASK-278: the caller's continuation id rides the row to that
            // delivery, and is echoed now so the open thread can attach its
            // stream consumer to it — at `pendingUntil`, not before.
            nudge?.();
            return {
              decision: claimed,
              executed: false,
              path: 'agent-executes',
              error: null,
              pendingUntil: deliveryDueAt,
              streamReqId: continuationReqId,
            };
          }

          if (parked) {
            // The row IS the receipt. `approved-pending-agent` with nothing yet
            // consumed reads back as "Approved — it will do this the next time
            // it runs" (see `receiptFor`), so there is nothing to announce here
            // and nothing that can announce it wrongly.
            return inert(claimed);
          }

          if (deferred) {
            // Approved, and it WILL run — just not yet. `executed: false` is
            // the literal truth for the next ten seconds, and the undo window
            // is the only reason this branch exists. The replay is a host
            // tool call behind the undo window, not a turn: no stream.
            return {
              decision: claimed,
              executed: false,
              path: 'host-replays',
              error: null,
              pendingUntil: replayDueAt,
              streamReqId: null,
            };
          }

          // The replay runs under a ctx built for the DECISION's owner and
          // agent — never the approving request's, which may be a different
          // session entirely and would land the work in the wrong workspace.
          const replayed = await settleReplay({
            store: store!,
            bus,
            ctx: replayContext(claimed),
            decision: claimed,
            now,
          });
          return {
            decision: (await store!.get(decisionId, ownerUserId)) ?? claimed,
            executed: replayed.executed,
            path: replayed.path,
            error: replayed.error,
            pendingUntil: null,
            // Host replay, immediate or failed: a tool call, not a turn.
            streamReqId: null,
          };
        },
        { returns: DecisionsApproveOutputSchema },
      );

      // ---------------------------------------------------------------------
      // Maintenance. Registered as a hook as well as run on a timer so a test
      // or an operator can drive it deterministically instead of waiting.
      // ---------------------------------------------------------------------
      bus.registerService<DecisionsSweepInput, DecisionsSweepOutput>(
        'decisions:sweep',
        PLUGIN_NAME,
        async (ctx, sweepInput) => runSweep(ctx, sweepInput?.limit),
        { returns: DecisionsSweepOutputSchema },
      );

      bus.registerService<DecisionsDismissInput, DecisionsDismissOutput>(
        'decisions:dismiss',
        PLUGIN_NAME,
        async (ctx, input) => {
          const decisionId = requireField(input.decisionId, 'decisionId');
          const ownerUserId = requireField(input.userId, 'userId');
          const current = await store!.get(decisionId, ownerUserId);
          if (current === null) return { decision: null };

          const nowIso = now().toISOString();
          const outcome = dismissDecision(current, { now: nowIso });
          // No event means the machine made no transition: already resolved.
          if (outcome.event === null) return { decision: current };
          const saved = await store!.markDismissed(decisionId, nowIso);
          const settled = saved ?? (await store!.get(decisionId, ownerUserId)) ?? current;
          // AW-6: an ATTENDED agent is parked waiting for this answer. Telling
          // it "no" matters as much as telling it "yes" — without the delivery
          // it sits on the inbox until the idle floor expires and then dies
          // mid-thought, having never learned the call was turned down.
          //
          // Gated on `saved`: only the caller who actually made the transition
          // delivers. A second tab's click loses the conditional update and
          // must not wake the agent a second time with the same news.
          //
          // `settled.attendance`, not `current`: same row, but read the value
          // we are actually reporting.
          //
          // AND DELIBERATELY NOT THE APPROVE PATH'S TREATMENT (TASK-277). This
          // routes on the STORED attendance with no live session read, and it
          // discards `deliverResolution`'s return — the two things approve just
          // stopped doing. It is benign here for one reason, and it is the whole
          // reason: a dismissal creates no standing authorisation and schedules
          // no replay, so a delivery that never lands costs the agent its
          // narration and nothing else. There is no call waiting to be made, so
          // there is nothing for a fallback to run and nothing to be silently
          // consumed. Adding a liveness read would buy an extra round-trip to
          // reach the same `deliverResolution` no-op it already reaches.
          if (saved !== null && settled.attendance === 'attended') {
            await deliverResolution({ bus, ctx, decision: settled, outcome: 'dismissed' });
          }
          return { decision: settled };
        },
        { returns: DecisionsDismissOutputSchema },
      );

      bus.registerService<DecisionsUndoInput, DecisionsUndoOutput>(
        'decisions:undo',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const decisionId = requireField(input.decisionId, 'decisionId');
          const ownerUserId = requireField(input.userId, 'userId');
          const current = await store!.get(decisionId, ownerUserId);
          if (current === null) return { decision: null, undone: false };

          // The call has already been made — either the agent re-issued it and
          // the gate let it through (`consumedAt`), or the host replayed it
          // itself (`replayedAt`). Undoing to `pending` would let a second
          // approval authorise a SECOND execution of a call that already ran,
          // so we refuse rather than pretend. Both halves are checked HERE as
          // well as in `store.restore`'s predicates: the store is the guarantee
          // under concurrency, this is the one that keeps the two enforcement
          // points from drifting apart silently.
          // And (TASK-574) once the warm agent has been TOLD: the resolution is
          // on its inbox, and reopening the row would leave its re-issued call
          // to meet a pending question and be held a second time.
          if (
            current.consumedAt !== null ||
            current.replayedAt !== null ||
            current.deliveredAt !== null
          ) {
            return { decision: current, undone: false };
          }

          const outcome = undoDecision(current, { now: now().toISOString() });
          if (!outcome.undone) return { decision: current, undone: false };

          const saved = await store!.restore(decisionId);
          // Lost the race with a concurrent resolve or a consume. Report what
          // is stored; never report an undo that did not happen.
          if (saved === null) {
            return { decision: (await store!.get(decisionId, ownerUserId)) ?? current, undone: false };
          }

          // THE RECEIPT IS ALREADY GONE, and nothing here had to remove it.
          //
          // `restore` wrote `pending` and cleared `resolvedAt`, and `receiptFor`
          // answers null for that row — so the line that said what happened
          // stops existing the instant the row stops saying it happened. There
          // is no removal to get wrong and no window in which the two disagree.
          //
          // This used to be a `decisions:executed` fire carrying
          // `outcome: 'retracted'`, i.e. "delete the row you wrote for me
          // earlier". It was fired for both authorising statuses even though
          // only one of them was guaranteed to have a receipt, on the reasoning
          // that a subscriber should not have to work out which execution path
          // an approval took. That reasoning was sound and the mechanism was
          // not: nothing ever subscribed, so no receipt existed to retract, and
          // the whole scheme only ever needed to exist because the receipt was
          // being pushed instead of read. See TASK-279.
          return { decision: saved, undone: true };
        },
        { returns: DecisionsUndoOutputSchema },
      );

      // ---------------------------------------------------------------------
      // The timer. `unref` so it never keeps a process alive on its own — a
      // host that is shutting down has nothing useful to sweep.
      // ---------------------------------------------------------------------
      if (sweepIntervalMs > 0) {
        const sweepCtx = makeAgentContext({
          sessionId: 'decisions-sweep',
          agentId: PLUGIN_NAME,
          userId: 'system',
        });
        const sweepOnce = (): void => {
          void runSweep(sweepCtx).catch((err: unknown) => {
            sweepCtx.logger.error('decisions_sweep_failed', {
              plugin: PLUGIN_NAME,
              err: err instanceof Error ? err : new Error(String(err)),
            });
          });
        };
        sweepTimer = setInterval(sweepOnce, sweepIntervalMs);
        sweepTimer.unref?.();
        // The nudge: one pass just after the window closes. The margin covers
        // timer jitter so the pass finds the row due; a pass that finds
        // nothing (an Undo won, another replica got there) is a no-op.
        nudge = () => {
          const t = setTimeout(() => {
            nudges.delete(t);
            sweepOnce();
          }, deliveryNudgeMs);
          t.unref?.();
          nudges.add(t);
        };
      }
    },

    shutdown() {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      for (const t of nudges) clearTimeout(t);
      nudges.clear();
      nudge = null;
      if (busRef !== null) {
        busRef.unsubscribe('tool:pre-call', PLUGIN_NAME);
        busRef = null;
      }
    },
  };
}
