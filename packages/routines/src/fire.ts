import { makeAgentContext, PluginError, type HookBus } from '@ax/core';
import type { StoredRoutine, AcceptedDispatch, FireSource } from './types.js';
import type { FireResult } from './tick.js';
import { renderTemplate } from './template.js';
import type { RoutinesStore } from './store.js';
import {
  buildSkipWarning, normalizeSkipReason, sanitizeSkipName, type SkipReason,
} from './skip-warning.js';

/**
 * Slice 6 — one connector the turn went without, as `chat:connectors-skipped`
 * reported it. Mirrors chat-orchestrator's `ConnectorsSkippedPayload` entry
 * (invariant 2 keeps the import out).
 */
export interface SkippedConnector {
  connectorId: string;
  name: string;
  reason: SkipReason;
}

export interface PendingFire {
  row: StoredRoutine;
  dispatchId: string;
  conversationId: string;
  source: FireSource;
  renderedPrompt: string;
  /** The agent's display name from `agents:resolve`; null → "this agent". */
  agentName: string | null;
  /** What `chat:connectors-skipped` said this fire's turn went without. */
  skips: SkippedConnector[];
  onTurnEnd: (turn: { contentBlocks?: unknown[] }) => Promise<void>;
}
export type PendingFires = Map<string, PendingFire>;

const MAX_SKIPS_PER_FIRE = 50;

/** Where `stashConnectorsSkipped` reports entries it had to drop. */
export interface StashLogger {
  warn(msg: string, fields: Record<string, unknown>): void;
}

/**
 * Slice 6 — the `chat:connectors-skipped` subscriber's whole job: if `reqId`
 * is an in-flight fire, add the skips to it. A map write and nothing else, so
 * it never holds up the turn (the orchestrator awaits it before the turn
 * runs). An unknown reqId — an interactive chat's turn — is ignored.
 *
 * The payload crosses a plugin boundary, so it is validated here rather than
 * trusted: malformed entries are dropped, a repeat is merged by connector id.
 * A reason this plugin does not know is NOT dropped — it is kept as
 * 'unavailable' and worded generically. When a payload for a real in-flight
 * fire loses entries, that is logged (counts only — never names or ids), so a
 * producer/consumer drift shows up instead of silently shortening a warning.
 */
export function stashConnectorsSkipped(
  pending: PendingFires,
  payload: unknown,
  logger?: StashLogger,
): void {
  if (typeof payload !== 'object' || payload === null) return;
  const { reqId, connectors } = payload as { reqId?: unknown; connectors?: unknown };
  if (typeof reqId !== 'string' || !Array.isArray(connectors)) return;
  const pf = pending.get(reqId);
  if (pf === undefined) return;
  let malformed = 0;
  let overCap = 0;
  for (const c of connectors) {
    // Bounded: the warning shows a few names and is capped at 300 chars, so
    // there is no reason to hold more than this per fire.
    if (pf.skips.length >= MAX_SKIPS_PER_FIRE) {
      overCap += 1;
      continue;
    }
    if (typeof c !== 'object' || c === null) {
      malformed += 1;
      continue;
    }
    const { connectorId, name, reason } = c as Record<string, unknown>;
    if (typeof connectorId !== 'string' || connectorId.length === 0 || typeof name !== 'string') {
      malformed += 1;
      continue;
    }
    if (pf.skips.some((s) => s.connectorId === connectorId)) continue;
    // A name that sanitizes to nothing falls back to the id, as the
    // producer's own label does.
    const label = sanitizeSkipName(name) || sanitizeSkipName(connectorId);
    if (label.length === 0) {
      malformed += 1;
      continue;
    }
    pf.skips.push({ connectorId, name: label, reason: normalizeSkipReason(reason) });
  }
  if (malformed > 0 || overCap > 0) {
    logger?.warn('routines_connectors_skipped_entries_dropped', {
      received: connectors.length, malformed, overCap,
    });
  }
}

/** The warning to record with this fire, or null when nothing was skipped. */
export function warningFor(pf: PendingFire): string | null {
  return buildSkipWarning(pf.agentName, pf.skips);
}

export interface FireDeps {
  bus: HookBus;
  pending: PendingFires;
  /**
   * Writes the fire's one row when the invoke fails before its turn ends
   * (TASK-679). The rule that keeps it to ONE row: whoever removes the
   * `pending` entry for a reqId writes that fire's row — the chat:turn-end
   * subscriber (`ok` / `silenced`) or the invoke-failure path here (`error`).
   * `Map#delete` returns true to exactly one of them.
   */
  store: Pick<RoutinesStore, 'finishDispatch'>;
  purgeAgent: (agentId: string) => Promise<void>;
  /**
   * How long after an invoke settles `complete` to wait for its turn end
   * before giving up and recording the fire as an error. Default 60s. The
   * turn end normally arrives BEFORE the invoke settles; the grace only
   * absorbs callback ordering, and the backstop means a turn end that never
   * matches (a runner bug, a lost reqId) can't make a fire vanish from the
   * log or leave its pending entry behind forever.
   */
  turnEndGraceMs?: number;
}

const DEFAULT_TURN_END_GRACE_MS = 60_000;

/**
 * Slice 6 — a `terminated` reason from one of agent:invoke's front gates,
 * which refuse a turn before anything else runs: a `chat:start` veto
 * (`chat:start:<reason>`) or an `agents:resolve` refusal
 * (`agent-resolve:<code>`; the orchestrator documents the prefix for callers
 * to branch on). Such a fire never chose its connectors, so it leaves the
 * routine's last warning alone.
 */
function refusedBeforeAssembly(reason: string): boolean {
  return reason.startsWith('chat:start:') || reason.startsWith('agent-resolve:');
}

export function createFireRoutine(deps: FireDeps) {
  return async (accepted: AcceptedDispatch, payload?: unknown): Promise<FireResult> => {
    const { row, source, reqId, dispatchId } = accepted;
    const sessionId = `routine-${row.agentId}-${row.routineId}-${reqId}`;
    const fail = async (err: unknown, agentGone = false): Promise<FireResult> => {
      const error = err instanceof PluginError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
      if (agentGone) await deps.purgeAgent(row.agentId);
      else await deps.store.finishDispatch({ dispatchId, outcome: { status: 'error', error, conversationId: null, renderedPrompt: null, warning: row.lastWarning } });
      return { status: 'error', error, conversationId: null, renderedPrompt: null, ...(agentGone ? { agentGone: true as const } : {}) };
    };
    const baseCtx = makeAgentContext({
      reqId,
      sessionId,
      agentId: row.agentId,
      userId: row.ownerUserId,
    });

    let agentName: string | null = null;
    try {
      const resolved = await deps.bus.call<
        { agentId: string; userId: string },
        { agent: { id: string; ownerId?: string; workspaceRef?: string | null; displayName?: unknown } }
      >('agents:resolve', baseCtx, { agentId: row.agentId, userId: row.ownerUserId });
      // Slice 6 — only used to word a skipped-connector warning.
      const displayName = resolved?.agent?.displayName;
      if (typeof displayName === 'string') agentName = displayName;
    } catch (err) {
      return fail(err, err instanceof PluginError && err.code === 'not-found' && err.hookName === 'agents:resolve');
    }

    let conversationId: string;
    try {
      if (row.conversation === 'shared') {
        const out = await deps.bus.call<
          unknown,
          { conversation: { conversationId: string }; created: boolean }
        >('conversations:find-or-create', baseCtx, {
          userId: row.ownerUserId,
          agentId: row.agentId,
          externalKey: row.routineId,
          // AW-6: `origin: 'routine'` is what makes a tool call held inside a
          // scheduled fire resolve as UNATTENDED — the host replays the
          // approved call itself, because by the time anyone answers, the turn
          // that raised it is long over and there is no warm agent to hand it
          // back to.
          fallback: { title: row.name, hidden: true, origin: 'routine' },
        });
        conversationId = out.conversation.conversationId;
      } else {
        const conv = await deps.bus.call<
          unknown,
          { conversationId: string }
        >('conversations:create', baseCtx, {
          userId: row.ownerUserId,
          agentId: row.agentId,
          title: `${row.name} @ ${new Date().toISOString()}`,
          hidden: true,
          // AW-6: see the shared-conversation branch above.
          origin: 'routine',
        });
        conversationId = conv.conversationId;
      }
    } catch (err) { return fail(err); }

    const fireCtx = makeAgentContext({
      reqId,
      sessionId,
      agentId: row.agentId,
      userId: row.ownerUserId,
      conversationId,
      // Mark this as a routine-originated (non-user) turn. A subscriber that
      // must not act on internally-generated turns would key off ctx.source.
      // None in-tree does since @ax/memory-strata's deletion (TASK-608);
      // @ax/memory stores routine turns too, but with no conversation, so a
      // routine run never counts as one the person had (TASK-616). See
      // AgentContext.source.
      source: 'routine',
      // Human-authored label for a status line ("Right now this agent is…").
      // Must be set here, at the moment the turn starts: @ax/routines only
      // writes its fire row (the conversationId→routine join) at
      // chat:turn-end, i.e. AFTER the turn it would describe, so there is no
      // way to recover which routine is mid-flight once work has begun.
      triggerLabel: row.name,
    });

    // Phase D: render whenever payload is provided, regardless of source.
    // fire-now can carry a payload with source='manual' (Task 2 plan).
    const prompt =
      payload !== undefined
        ? renderTemplate(row.promptBody, { payload })
        : row.promptBody;

    deps.pending.set(reqId, {
      row, dispatchId, conversationId, source,
      renderedPrompt: prompt,
      agentName, skips: [],
      onTurnEnd: async () => {},
    });

    // The invoke settles AFTER its turn in the ordinary case, so on success
    // the chat:turn-end subscriber has already taken the pending entry and
    // written the row. Only when the entry is still ours — the invoke threw,
    // came back `terminated` without a turn ever ending, or came back
    // `complete` and no turn end claimed it within the grace — is this the
    // fire's one row, and then it is an error: a fire that never produced a
    // turn must not vanish from the log (routines design §5.2, "errors are
    // visible").
    //
    // Slice 6 — `last_warning` moves only for a fire that reached turn
    // assembly (where the orchestrator decides which connectors to go
    // without). Here the entry exists and the invoke was dispatched, so
    // assembly MAY have happened: write the warning (or null) unless the
    // outcome proves the turn stopped before it — the invoke threw (a
    // dispatch error: agent:invoke otherwise always answers an outcome), or
    // it was refused at the gates in front of everything else, chat:start
    // or agents:resolve (`reachedAssembly: false`). Other `terminated`
    // reasons are not classified: a pre-assembly config error clears a
    // stale warning, which is the cheaper mistake than a post-assembly
    // failure keeping one.
    const settleWithoutTurn = async (error: string, reachedAssembly: boolean): Promise<void> => {
      const entry = deps.pending.get(reqId);
      if (entry === undefined || !deps.pending.delete(reqId)) return;
      process.stderr.write(
        `[ax/routines] agent:invoke failed for ${row.agentId}/${row.routineId}: ${error}\n`,
      );
      try {
        await deps.store.finishDispatch({ dispatchId, outcome: {
          conversationId, status: 'error', error, renderedPrompt: prompt,
          warning: reachedAssembly || entry.skips.length > 0 ? warningFor(entry) : row.lastWarning,
        } });
      } catch (err) {
        process.stderr.write(
          `[ax/routines] recording failed fire for ${row.agentId}/${row.routineId} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    };

    void deps.bus.call<unknown, { kind?: string; reason?: unknown } | undefined>(
      'agent:invoke', fireCtx, {
        message: { role: 'user', content: prompt },
      },
    ).then(
      (outcome) => {
        if (outcome?.kind === 'terminated') {
          const reason = String(outcome.reason ?? 'unknown');
          return settleWithoutTurn(`terminated: ${reason}`, !refusedBeforeAssembly(reason));
        }
        if (deps.pending.has(reqId)) {
          const timer = setTimeout(() => {
            void settleWithoutTurn('the run finished without reporting a result', true);
          }, deps.turnEndGraceMs ?? DEFAULT_TURN_END_GRACE_MS);
          timer.unref?.();
        }
        return undefined;
      },
      (err: unknown) => settleWithoutTurn(err instanceof Error ? err.message : String(err), false),
    );

    // TASK-679: the row for this fire is written when the turn settles, not
    // here — see FireResult.recordedAtTurnEnd.
    return {
      status: 'ok', conversationId, error: null, renderedPrompt: prompt,
      recordedAtTurnEnd: true,
    };
  };
}
