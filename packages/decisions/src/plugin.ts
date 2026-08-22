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
import { deliverResolution, SESSION_QUEUE_HOOK } from './delivery.js';
import { runDueReplays, sweepExpired } from './expiry.js';
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
import { emitExecuted, replayContext, settleReplay } from './replay.js';
import { createDecisionsStore, type DecisionStore } from './store.js';
import { PENDING_AGENT_RECEIPT, RETRACTED_RECEIPT } from './templates.js';
import {
  DecisionsApproveOutputSchema,
  DecisionsDismissOutputSchema,
  DecisionsGetOutputSchema,
  DecisionsListOutputSchema,
  DecisionsSweepOutputSchema,
  DecisionsUndoOutputSchema,
  type Attendance,
  type Decision,
  type DecisionsApproveInput,
  type DecisionsApproveOutput,
  type DecisionsDismissInput,
  type DecisionsDismissOutput,
  type DecisionsGetInput,
  type DecisionsGetOutput,
  type DecisionsListInput,
  type DecisionsListOutput,
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

export function createDecisionsPlugin(opts?: DecisionsPluginOptions): Plugin {
  const now = opts?.now ?? (() => new Date());
  const idGen = opts?.idGen ?? newDecisionId;
  const ttlMs = opts?.ttlMs ?? DEFAULT_DECISION_TTL_MS;
  const sweepIntervalMs = opts?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let store: DecisionStore | undefined;
  let busRef: { unsubscribe(hook: string, plugin: string): number } | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

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
  });

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'decisions:list',
        'decisions:get',
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
          hook: CONVERSATION_METADATA_HOOK,
          degradation:
            'Attendance cannot be derived from the conversation channel; every held ' +
            'call is treated as unattended (the fail-safe) and approvals replay ' +
            'host-side instead of returning to a warm agent.',
        },
        {
          hook: SESSION_QUEUE_HOOK,
          degradation:
            'A resolved attended decision is not delivered to the warm agent. The ' +
            'standing authorisation still stands on the row, so the agent performs ' +
            'the call the next time it runs.',
        },
      ],
      subscribes: ['tool:pre-call'],
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
      });
      bus.subscribe<ToolCall>('tool:pre-call', PLUGIN_NAME, subscriber);

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
          replayed: await runDueReplays({
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
          // route by `(userId, agentId)`, so checking with the wrong one would
          // re-read somebody else's world and answer confidently about it. This
          // repo has been bitten by exactly that on `workspace:apply`.
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
          // The undo window is honoured on the HOST path only, and that is a
          // real limit rather than an oversight: on the attended path the
          // still-warm agent re-issues its own call the moment the gate lets it
          // through, and nothing here can hold the agent back for ten seconds.
          // An irreversible rule whose calls need the grace period must be
          // raised unattended. Recorded rather than papered over — though a web
          // decision whose session has since died is on the host path now, and
          // does get its grace period.
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
            });
          } catch (err) {
            ctx.logger.warn('decision_claim_refused', {
              plugin: PLUGIN_NAME,
              decisionId,
              err: err instanceof Error ? err : new Error(String(err)),
            });
            return settle(null);
          }
          // We LOST the race. That is not "no such decision" — it is "somebody
          // else already resolved this one", and the honest answer is their
          // stored outcome.
          if (claimed === null) return settle(null);

          if (attended) {
            // AW-6: hand it to the warm agent as its next inbox message. It
            // re-issues its own held call and the fingerprint gate authorises
            // that exactly once. Nothing has happened yet, so nothing claims it
            // has: no receipt is fired here.
            const delivery = await deliverResolution({
              bus,
              ctx,
              decision: claimed,
              outcome: 'approved',
            });
            if (!delivery.delivered) {
              // The liveness read closed the hours-wide hole; this is the
              // milliseconds-wide one left over — the session ended between the
              // lookup and the queue, or the queue refused outright. All three
              // reasons mean the same thing, and it is the thing that matters:
              // the agent was NOT told. So the host does not get to assume it
              // was and leave a standing yes on a row nobody may ever come back
              // for. It takes the replay itself.
              //
              // Double execution is not reachable from here: `settleReplay`
              // stamps `replayed_at`, which takes the row out of the
              // standing-authorisation set, so a late agent re-issue finds no
              // yes to cash in. The row does go un-`replayClaimedAt`-stamped
              // for the few milliseconds this takes — but that is only a window
              // at all if a warm agent exists, and a warm agent is precisely
              // what we have just failed to find.
              ctx.logger.warn('decision_delivery_fell_back_to_replay', {
                plugin: PLUGIN_NAME,
                decisionId,
                reason: delivery.reason,
              });
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
              };
            }
            return {
              decision: claimed,
              executed: false,
              path: 'agent-executes',
              error: null,
              pendingUntil: null,
            };
          }

          if (parked) {
            await emitExecuted(
              bus,
              replayContext(claimed),
              claimed,
              'pending-agent',
              PENDING_AGENT_RECEIPT,
            );
            return inert(claimed);
          }

          if (deferred) {
            // Approved, and it WILL run — just not yet. `executed: false` is
            // the literal truth for the next ten seconds, and the undo window
            // is the only reason this branch exists.
            return {
              decision: claimed,
              executed: false,
              path: 'host-replays',
              error: null,
              pendingUntil: replayDueAt,
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
          if (current.consumedAt !== null || current.replayedAt !== null) {
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

          // RETRACT THE RECEIPT. `outcome: 'retracted'` is a REMOVE instruction
          // keyed on the decision id, not a new line of history: a receipt
          // still standing next to a decision that is open again is the same
          // class of lie as claiming an unsent email was sent (design H1).
          //
          // Fired for both authorising statuses even though only
          // `approved-pending-agent` is guaranteed to have emitted a receipt —
          // an attended approval emits none, and a deferred replay has not run
          // yet. On those paths a subscriber keyed on the decision id finds
          // nothing to remove, which is the correct no-op. Firing anyway is the
          // deliberate choice: a subscriber should never have to work out which
          // execution path an approval took in order to keep its own list
          // honest. (A row the host ALREADY replayed cannot reach here at all —
          // the `replayedAt` guard above refuses that undo outright.)
          if (current.status === 'executed' || current.status === 'approved-pending-agent') {
            await emitExecuted(bus, replayContext(saved), saved, 'retracted', RETRACTED_RECEIPT);
          }
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
        sweepTimer = setInterval(() => {
          void runSweep(sweepCtx).catch((err: unknown) => {
            sweepCtx.logger.error('decisions_sweep_failed', {
              plugin: PLUGIN_NAME,
              err: err instanceof Error ? err : new Error(String(err)),
            });
          });
        }, sweepIntervalMs);
        sweepTimer.unref?.();
      }
    },

    shutdown() {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      if (busRef !== null) {
        busRef.unsubscribe('tool:pre-call', PLUGIN_NAME);
        busRef = null;
      }
    },
  };
}
