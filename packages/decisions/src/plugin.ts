import { randomUUID } from 'node:crypto';
import {
  makeAgentContext,
  PluginError,
  type AgentContext,
  type Plugin,
  type ToolCall,
} from '@ax/core';
import type { Kysely } from 'kysely';
import { approveDecision, dismissDecision, undoDecision } from './machine.js';
import { runDecisionsMigration, type DecisionsDatabase } from './migrations.js';
import { createPreCallSubscriber, PLUGIN_NAME, type PolicyAnswer } from './pre-call.js';
import { createDecisionsStore, type DecisionStore } from './store.js';
import {
  DecisionsApproveOutputSchema,
  DecisionsDismissOutputSchema,
  DecisionsGetOutputSchema,
  DecisionsListOutputSchema,
  DecisionsUndoOutputSchema,
  type Attendance,
  type DecisionsApproveInput,
  type DecisionsApproveOutput,
  type DecisionsDismissInput,
  type DecisionsDismissOutput,
  type DecisionsGetInput,
  type DecisionsGetOutput,
  type DecisionsListInput,
  type DecisionsListOutput,
  type DecisionsUndoInput,
  type DecisionsUndoOutput,
} from './types.js';

/**
 * How long a held call waits for a person before it stops being a live
 * question. Two days: long enough to survive a weekend-adjacent hold, short
 * enough that the Today queue is not an archive.
 */
export const DEFAULT_DECISION_TTL_MS = 48 * 60 * 60 * 1000;

export interface DecisionsPluginOptions {
  /** Time seam. */
  now?: () => Date;
  /** Id seam. Tests only — production uses the host-generated form below. */
  idGen?: () => string;
  ttlMs?: number;
  /** Attendance seam. AW-6 replaces the default with the conversation's channel. */
  attendanceFor?: (ctx: AgentContext) => Attendance;
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
  let store: DecisionStore | undefined;
  let busRef: { unsubscribe(hook: string, plugin: string): number } | null = null;

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
      ],
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
        async (_ctx, input) => {
          const decisionId = requireField(input.decisionId, 'decisionId');
          const ownerUserId = requireField(input.userId, 'userId');
          const current = await store!.get(decisionId, ownerUserId);
          if (current === null) return { decision: null, executed: false, path: null };

          // Already resolved — expired, dismissed, or approved a moment ago in
          // another tab. The click is absorbed silently and we hand back what
          // is actually STORED. Returning null here would report "no such
          // decision" for a decision the caller is looking at.
          if (current.status !== 'pending' && current.status !== 'stale') {
            return { decision: current, executed: false, path: null };
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
          const settle = async (
            saved: Awaited<ReturnType<DecisionStore['markExecuted']>>,
          ): Promise<DecisionsApproveOutput> => ({
            decision: saved ?? (await store!.get(decisionId, ownerUserId)) ?? current,
            // `executed` and `path` describe what the HOST ran, and the host
            // runs nothing in this PR — approval leaves a standing
            // authorisation that the warm agent consumes at the gate. AW-5
            // adds the replay and fills both fields in.
            executed: false,
            path: null,
          });

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
          if (!outcome.executed) return { decision: current, executed: false, path: null };
          return settle(await store!.markExecuted(decisionId, nowIso));
        },
        { returns: DecisionsApproveOutputSchema },
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

          // The authorisation has already been taken up: the agent re-issued
          // its call and the gate let it through. Undoing to `pending` would
          // let a second approval authorise a SECOND execution of a call that
          // already ran, so we refuse rather than pretend.
          if (current.consumedAt !== null) return { decision: current, undone: false };

          const outcome = undoDecision(current, { now: now().toISOString() });
          if (!outcome.undone) return { decision: current, undone: false };

          const saved = await store!.restore(decisionId);
          // Lost the race with a concurrent resolve or a consume. Report what
          // is stored; never report an undo that did not happen.
          if (saved === null) {
            return { decision: (await store!.get(decisionId, ownerUserId)) ?? current, undone: false };
          }
          return { decision: saved, undone: true };
        },
        { returns: DecisionsUndoOutputSchema },
      );
    },

    shutdown() {
      if (busRef !== null) {
        busRef.unsubscribe('tool:pre-call', PLUGIN_NAME);
        busRef = null;
      }
    },
  };
}
