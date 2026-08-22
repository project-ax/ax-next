import { randomUUID } from 'node:crypto';
import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type Plugin,
  type ToolCall,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { runDueReplays, sweepExpired } from './expiry.js';
import {
  approveDecision,
  dismissDecision,
  undoDecision,
  UNDO_WINDOW_MS,
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
  /** Attendance seam. AW-6 replaces the default with the conversation's channel. */
  attendanceFor?: (ctx: AgentContext) => Attendance;
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
      // `tool:execute:<name>` is deliberately ABSENT. It is the documented
      // dynamic-service-hook exception — the hook name depends on the recorded
      // call, so no manifest can list it — and it is reached through
      // `hasService` + `call`, exactly as `tool.execute-host` does. Adding a
      // wildcard here would be a lie the cycle-detector cannot check.
      calls: ['database:get-instance', 'tool-policy:evaluate'],
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
        ...(opts?.attendanceFor !== undefined ? { attendanceFor: opts.attendanceFor } : {}),
        bus,
      });
      bus.subscribe<ToolCall>('tool:pre-call', PLUGIN_NAME, subscriber);

      /** One maintenance pass: expire what nobody answered, run what is due. */
      const runSweep = async (
        ctx: AgentContext,
        limit?: number,
      ): Promise<DecisionsSweepOutput> => ({
        expired: await sweepExpired(store!, now()),
        replayed: await runDueReplays({
          store: store!,
          bus,
          now: now(),
          limit,
          logCtx: ctx,
        }),
      });

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
          // The pure machine owns the rules: expiry, the freshness guard, and
          // "anything already resolved absorbs the click silently".
          const outcome = approveDecision(current, {
            now: nowIso,
            // No producer supplies a predicate yet (AW-7), so there is nothing
            // to re-check. An EMPTY world is the honest input: the guard reads
            // "no observation" and does not pretend one matched.
            freshness: {},
          });

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
          // The undo window is honoured on the HOST path only, and that is a
          // real limit rather than an oversight: on the attended path the
          // still-warm agent re-issues its own call the moment the gate lets it
          // through, and nothing here can hold the agent back for ten seconds.
          // An irreversible rule whose calls need the grace period must be
          // raised unattended. Recorded rather than papered over.
          // -----------------------------------------------------------------
          const attended = current.attendance === 'attended';
          const hasExecutor = bus.hasService(`tool:execute:${current.call.name}`);
          const parked = !attended && !hasExecutor;
          const deferred = !attended && hasExecutor && current.irreversible;
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
            // AW-6 delivers the resolution to the warm agent. Nothing has
            // happened yet, so nothing claims it has: no receipt is fired here.
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
        async (_ctx, input) => {
          const decisionId = requireField(input.decisionId, 'decisionId');
          const ownerUserId = requireField(input.userId, 'userId');
          const current = await store!.get(decisionId, ownerUserId);
          if (current === null) return { decision: null };

          const nowIso = now().toISOString();
          const outcome = dismissDecision(current, { now: nowIso });
          // No event means the machine made no transition: already resolved.
          if (outcome.event === null) return { decision: current };
          const saved = await store!.markDismissed(decisionId, nowIso);
          return {
            decision: saved ?? (await store!.get(decisionId, ownerUserId)) ?? current,
          };
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
