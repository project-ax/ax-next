import { faultLogFields, makeAgentContext, PluginError, type HookBus } from '@ax/core';
import type { StoredRoutine, AcceptedDispatch, FireSource, DispatchMiss, RepeatDelivery } from './types.js';
import type { FireResult } from './tick.js';
import { renderLastCompletedRun, renderTemplate, usesLastCompletedRun, usesPayload } from './template.js';
import { createRoutineLifetime, type RoutineLifetime } from './lifetime.js';
import { RUN_CLOSED, type RoutinesStore } from './store.js';
import { briefRunError, briefRunMiss, isTaskRun } from './brief.js';
import { CHECK_IN_REPLIES, CHECK_IN_REPORTS, renderCheckInMessage } from './checkin-message.js';
import { readTaskEventContent, renderTaskEvents, repeatUpdateNotice, taskEventPreview } from './task-event-content.js';
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
  /**
   * When the run was accepted (`AcceptedDispatch.acceptedAt`). Its brief counts
   * a finish date's days from this day, in the task's time zone, as its row is
   * the snapshot read then (TASK-951).
   */
  acceptedAt: Date;
  /**
   * The prompt this fire's row records. Null for a task run (TASK-908): its
   * check-in message stays in the run's own hidden conversation, which only the
   * owner reads, and off its history row, which every member of a team agent
   * can read.
   */
  renderedPrompt: string | null;
  /** The agent's display name from `agents:resolve`; null → "this agent". */
  agentName: string | null;
  /** What `chat:connectors-skipped` said this fire's turn went without. */
  skips: SkippedConnector[];
  /**
   * Where a task check-in's brief stands (TASK-908): `waiting` until the
   * routines provider hands the orchestrator the brief (`sent`), then `landed`
   * once `chat:system-prompt-landed` lists the provider for a brief it really
   * sent. `too-long` when the provider found it over the prompt cap and didn't
   * send it. A task run that ends its turn short of `landed` is recorded as
   * failed. Unused for a repeat routine's run.
   */
  brief: 'waiting' | 'sent' | 'landed' | 'too-long';
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
  lifetime?: RoutineLifetime;
  pending: PendingFires;
  /**
   * Writes the fire's one row when the invoke fails before its turn ends
   * (TASK-679). The rule that keeps it to ONE row: whoever removes the
   * `pending` entry for a reqId writes that fire's row — the chat:turn-end
   * subscriber (`ok` / `silenced`) or the invoke-failure path here (`error`).
   * `Map#delete` returns true to exactly one of them. It also binds each
   * fire's conversation onto its dispatch row before the invoke (TASK-907),
   * reads a task's latest reports (TASK-908) and its owner's own latest
   * replies on it (TASK-931) for its check-in message, and reads a repeat
   * routine's last completed run when its prompt asks for it (TASK-991).
   */
  store: Pick<RoutinesStore, 'finishDispatch' | 'bindDispatchConversation' | 'recentReports' | 'recentReplies' | 'taskEventsForDispatch' | 'lastCompletedRun'>;
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
 * (`chat:start:<reason>`), an `agents:resolve` refusal
 * (`agent-resolve:<code>`; the orchestrator documents the prefix for callers
 * to branch on), or a `chat:system-prompt-landed` veto
 * (`system-prompt:<reason>`, TASK-908), which the orchestrator fires right
 * after building the system prompt and before connector assembly. A message the
 * orchestrator couldn't save (`conversation:message-not-saved`, TASK-1059) is
 * also refused before routing, and a turn whose conversation's session is busy
 * with a turn of another mode (`conversation:busy`, TASK-1091) is refused while
 * routing, before anything spawns. Such a fire
 * never chose its connectors, so it leaves the routine's last warning alone.
 */
function refusedBeforeAssembly(reason: string): boolean {
  return reason.startsWith('chat:start:') || reason.startsWith('agent-resolve:') || reason.startsWith('system-prompt:') || reason === 'conversation:message-not-saved' || reason === 'conversation:busy';
}

/**
 * TASK-1031 — what a run's error says when it failed for a host reason: fixed
 * words and, when there is one, the failure's code. Never the error's message:
 * the run's error is the routine's `lastError` and its run history, both shown
 * to the owner, and a hook's message can quote a database or a provider. The
 * log (`routines_fire_failed` / `routines_fire_invoke_failed`) carries every
 * code and class name, never the message either (TASK-1058).
 * The error's own code is shown; its cause's only when the own code is the
 * bus's `unknown` wrap. Only a plain word-shaped code is shown: the log helper
 * also accepts `.` and `:` (errno, SQLSTATE), which could spell a host here.
 */
export function runFailedText(err: unknown): string {
  const { code, causeCode } = faultLogFields(err);
  const pick = code !== undefined && code !== 'unknown' ? code : causeCode;
  const shown = pick !== undefined && OWNER_CODE_RE.test(pick) ? pick : undefined;
  return `This run failed because of a problem on our side${shown === undefined ? '' : ` (code: ${shown})`}.`;
}
const OWNER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * TASK-1038 — what a run's error says when its invoke ended `terminated`:
 * runFailedText's fixed words and a code. A runner that fails gives its own
 * error as the reason (`${name}: ${message}`, agent-runner-core
 * `run-runner.ts`). Runner output is untrusted, and this text becomes the
 * routine's `lastError`, which owners, team members and the agent read.
 *
 * The reason is the code only when it has the host-code shape. Every
 * orchestrator reason and gate code (`chat:start:`, `agent-resolve:`,
 * `system-prompt:`) has it. Anything else, which today is always a runner's
 * own text, becomes `runner-error`.
 *
 * A runner can still choose a reason with that shape. It shows as one token
 * of at most 64 lowercase letters, digits, `-` and `:`. With no space, `.` or
 * `/`, it can't spell a sentence, a URL, a path or a dotted host name. It can
 * still spell a bare `name:port`, which is why runFailedText's own codes (from
 * host errors, which can carry infrastructure) keep excluding `:`.
 *
 * The scrub's keep-list (`packages/routines/sql/scrub-leaked-run-errors.sql`)
 * repeats this pattern. Change both together.
 */
export function terminatedRunText(reason: string): string {
  const code = HOST_REASON_RE.test(reason) ? reason : 'runner-error';
  return `This run failed because of a problem on our side (code: ${code}).`;
}
const HOST_REASON_RE = /^[a-z0-9][a-z0-9:-]{0,63}$/;

/** The store's `RUN_CLOSED` refusal, read without trusting the error's getters. */
function isRunClosed(err: unknown): boolean {
  try {
    return err instanceof Error && err.message === RUN_CLOSED;
  } catch {
    return false;
  }
}

/**
 * `agents:resolve`'s own `not-found`: the agent is gone. Read without trusting
 * the error's getters. It decides a purge, so an error that can't be read is
 * never a reason to purge (TASK-1036).
 */
function isAgentGone(err: unknown): boolean {
  try {
    return err instanceof PluginError && err.code === 'not-found' && err.hookName === 'agents:resolve';
  } catch {
    return false;
  }
}

export function createFireRoutine(deps: FireDeps) {
  const lifetime = deps.lifetime ?? createRoutineLifetime();
  const fire = async (accepted: AcceptedDispatch, delivery?: RepeatDelivery): Promise<FireResult> => {
    const { row, source, reqId, dispatchId, acceptedAt } = accepted;
    const sessionId = `routine-${row.agentId}-${row.routineId}-${reqId}`;
    const fail = async (err: unknown, agentGone = false): Promise<FireResult> => {
      // The store's own fixed sentence for a run that closed before its bind
      // (TASK-907) is kept: channel-web words a check-in by it.
      // A closed run is an expected race (stopped, or its agent retired,
      // between accept and bind), so it is a warning, not an error.
      const closed = isRunClosed(err);
      const error = source === 'webhook' ? 'This app update could not run.' : closed ? RUN_CLOSED : runFailedText(err);
      if (agentGone) await deps.purgeAgent(row.agentId);
      else {
        // `finally`: if recording fails too, the original failure is still logged.
        try {
          await deps.store.finishDispatch({ dispatchId, outcome: { status: 'error', error, conversationId: null, renderedPrompt: null, warning: row.lastWarning } });
        } finally {
          logFault('routines_fire_failed', err, closed ? 'warn' : 'error');
        }
      }
      return { status: 'error', error, conversationId: null, renderedPrompt: null, ...(agentGone ? { agentGone: true as const } : {}) };
    };
    const baseCtx = makeAgentContext({
      reqId,
      sessionId,
      agentId: row.agentId,
      userId: row.ownerUserId,
    });
    // The detail of a host failure: codes only, for every source (TASK-1058;
    // until then a non-webhook fire logged the whole error, TASK-1031). A
    // driver's message can carry a host, a user or a query value. Never throws:
    // `faultLogFields` reads no throwing getter, and a failed log line must not
    // cost the run its row.
    function logFault(event: 'routines_fire_failed' | 'routines_fire_invoke_failed', err: unknown, level: 'warn' | 'error' = 'error'): void {
      try {
        baseCtx.logger[level](event, { agentId: row.agentId, routineId: row.routineId, source, ...faultLogFields(err) });
      } catch {
        // Best-effort: the run's row doesn't depend on its log line.
      }
    }

    let agentName: string | null = null;
    try {
      const resolved = await deps.bus.callJoined<
        { agentId: string; userId: string },
        { agent: { id: string; ownerId?: string; displayName?: unknown } }
      >('agents:resolve', baseCtx, { agentId: row.agentId, userId: row.ownerUserId });
      // Slice 6 — only used to word a skipped-connector warning.
      const displayName = resolved?.agent?.displayName;
      if (typeof displayName === 'string') agentName = displayName;
    } catch (err) { return fail(err, isAgentGone(err)); }

    let conversationId: string;
    try {
      if (row.conversation === 'shared') {
        const out = await deps.bus.callJoined<
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
        const conv = await deps.bus.callJoined<
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

    // TASK-907: the dispatch row learns its conversation before the agent
    // starts, so routine_report can find the one open run it belongs to. A
    // failed bind (the run or its agent closed meanwhile) is recorded like
    // any other setup failure, and the agent never starts.
    try {
      await deps.store.bindDispatchConversation({ dispatchId, conversationId });
    } catch (err) { return fail(err); }

    const fireCtx = makeAgentContext({
      reqId,
      sessionId,
      agentId: row.agentId,
      userId: row.ownerUserId,
      conversationId,
      // Mark this as a routine-originated (non-user) turn. A subscriber that
      // must not act on internally-generated turns would key off ctx.source.
      // None in-tree does since @ax/memory-strata's deletion (TASK-608).
      // @ax/memory stores routine turns with no conversation, so a routine run
      // never counts as one the person had (TASK-616), except a task
      // check-in's, which @ax/routines refuses through `memory:pre-capture`
      // (TASK-908). See AgentContext.source.
      source: 'routine',
      // Human-authored label for a status line ("Right now this agent is…").
      // Set here, when the turn starts: no hook tells another plugin which
      // routine a turn belongs to. The dispatch row records this run's
      // conversation before the invoke (TASK-907), but only routine_report
      // reads that. A display label only; nothing may key off it (design §13).
      triggerLabel: row.name,
    });

    let prompt: string;
    if (isTaskRun(row)) {
      // TASK-908: a task run starts with its check-in message (why it runs,
      // the agent's notes and its latest reports, the person's latest
      // replies, TASK-931, a get-done task's steps, TASK-948, and whether its
      // latest report claimed it's done, TASK-950), never its instructions,
      // which reach it as its brief instead. The notes, the steps and the
      // claim come from the accepted row, the snapshot the brief is built
      // from; only a get-done task's claim counts, as in its view. Reports
      // and replies are read alike, for the person the run acts as, the
      // accepted row's owner: the store answers only with this task's runs
      // that ran as them (TASK-936) and the replies they wrote, and only
      // while the task is still theirs, so an earlier owner's reports and
      // words never steer it, and one that moved since the accept gets none.
      // A failed read is recorded like any other setup failure, and the agent
      // never starts. Its assigned app updates are outside content, supplied
      // in this user message with explicit framing, never in the trusted brief.
      let reports: Awaited<ReturnType<RoutinesStore['recentReports']>>;
      let replies: Awaited<ReturnType<RoutinesStore['recentReplies']>>;
      let updates: string | null;
      try {
        reports = await deps.store.recentReports({ agentId: row.agentId, routineId: row.routineId, actorUserId: row.ownerUserId, limit: CHECK_IN_REPORTS });
        replies = await deps.store.recentReplies({ agentId: row.agentId, routineId: row.routineId, actorUserId: row.ownerUserId, limit: CHECK_IN_REPLIES });
        const events = await deps.store.taskEventsForDispatch({ agentId: row.agentId, dispatchId, actorUserId: row.ownerUserId });
        const previews = [];
        for (const event of events) {
          const bytes = await readTaskEventContent(deps.bus, fireCtx, event);
          previews.push({ ...event, ...taskEventPreview(bytes) });
        }
        updates = renderTaskEvents(previews);
      } catch (err) { return fail(err); }
      prompt = renderCheckInMessage({
        source, agentNotes: row.task?.agentNotes ?? null, reports, replies, missesInARow: row.noRecentUpdate?.inARow ?? 0,
        steps: row.kind === 'get-done' ? row.steps : null, doneClaimed: row.kind === 'get-done' && row.task?.doneClaimed === true,
        updates,
      });
    } else {
      // TASK-991: the host value first. A prompt that asks for
      // `{{lastCompletedRun}}` gets the start date of this routine's newest
      // run that completed as the person this one acts as (the accepted row's
      // owner; runs made as anyone else don't count), read from the routine's
      // own fire records and nothing else. Rendered BEFORE the payload pass,
      // so a payload can't supply the value and its text is never scanned for
      // the token (template.ts, K9). A failed read is recorded like any other
      // setup failure, and the agent never starts.
      let body = row.promptBody;
      if (usesLastCompletedRun(body)) {
        try {
          body = renderLastCompletedRun(body, await deps.store.lastCompletedRun({ agentId: row.agentId, routineId: row.routineId, actorUserId: row.ownerUserId }));
        } catch (err) { return fail(err); }
      }
      // TASK-1050: a run an app update started (only the delivery pump passes
      // one) gets the update by its eventId, never its content. A prompt that
      // names payload fields keeps exactly its rendered text (renderTemplate,
      // single pass, K9). Any other prompt gets the host's note after it, and
      // the run reads the update with routine_read_update. The content stays
      // out of this user turn because @ax/memory learns from user turns and
      // never from tool results (packages/memory/src/transcript.ts).
      if (delivery === undefined) prompt = body;
      else if (usesPayload(body)) prompt = renderTemplate(body, { payload: delivery.payload });
      else prompt = `${body}\n\n${repeatUpdateNotice({ eventId: delivery.deliveryId, receivedAt: acceptedAt })}`;
    }
    // TASK-908 decisions row 13: no run of a task keeps its check-in message,
    // whatever its outcome. Every member of a team agent can read a routine's
    // run history, and the message carries the owner's notes, reports and
    // replies (TASK-931).
    const renderedPrompt = isTaskRun(row) || source === 'webhook' ? null : prompt;

    deps.pending.set(reqId, {
      row, dispatchId, conversationId, source, acceptedAt,
      renderedPrompt,
      agentName, skips: [], brief: 'waiting',
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
    // `error` may be a function of the entry being settled: a task check-in
    // the landed veto refused records why, in words, from its brief's state.
    // `missFor` (TASK-930) says why a task run left no report, from the code that
    // knows; no answer is `failed`, the store's default.
    const settleWithoutTurn = async (
      errorFor: string | ((entry: PendingFire) => string),
      reachedAssembly: boolean,
      missFor?: (entry: PendingFire) => DispatchMiss | null,
    ): Promise<void> => {
      const entry = deps.pending.get(reqId);
      if (entry === undefined || !deps.pending.delete(reqId)) return;
      const error = source === 'webhook' ? 'This app update could not run.' : typeof errorFor === 'string' ? errorFor : errorFor(entry);
      const miss = missFor?.(entry) ?? null;
      process.stderr.write(
        `[ax/routines] agent:invoke failed for ${row.agentId}/${row.routineId}: ${error}\n`,
      );
      try {
        await deps.store.finishDispatch({ dispatchId, outcome: {
          conversationId, status: 'error', error, renderedPrompt: entry.renderedPrompt,
          warning: reachedAssembly || entry.skips.length > 0 ? warningFor(entry) : row.lastWarning,
          ...(miss === null ? {} : { miss }),
        } });
      } catch (err) {
        process.stderr.write(
          `[ax/routines] recording failed fire for ${row.agentId}/${row.routineId} failed: ${source === 'webhook' ? 'app update accounting unavailable' : JSON.stringify(faultLogFields(err))}\n`,
        );
      }
    };

    void lifetime.track(() => deps.bus.callJoined<unknown, { kind?: string; reason?: unknown } | undefined>(
      'agent:invoke', fireCtx, { message: { role: 'user', content: prompt } },
    ).then(
      async outcome => {
        if (outcome?.kind === 'terminated') {
          // The reason decides a task run's wording (briefRunError), why it left
          // no report (briefRunMiss) and whether the last warning moves
          // (refusedBeforeAssembly). It is stored only through terminatedRunText:
          // a runner that fails gives its own error text as the reason, and
          // runner output is untrusted (TASK-1038).
          const reason = typeof outcome.reason === 'string' ? outcome.reason : 'unknown';
          await settleWithoutTurn(entry => briefRunError(entry, reason) ?? terminatedRunText(reason), !refusedBeforeAssembly(reason), entry => briefRunMiss(entry, reason));
        } else if (deps.pending.has(reqId)) {
          await lifetime.defer(deps.turnEndGraceMs ?? DEFAULT_TURN_END_GRACE_MS,
            () => settleWithoutTurn('the run finished without reporting a result', true));
        }
      },
      async (err: unknown) => {
        await settleWithoutTurn(runFailedText(err), false);
        logFault('routines_fire_invoke_failed', err);
      },
    ));

    // TASK-679: the row for this fire is written when the turn settles, not
    // here — see FireResult.recordedAtTurnEnd.
    return {
      status: 'ok', conversationId, error: null, renderedPrompt,
      recordedAtTurnEnd: true,
    };
  };
  // Setup and early failure writes belong to the same lifetime as the detached turn.
  return Object.assign((accepted: AcceptedDispatch, delivery?: RepeatDelivery) => lifetime.track(() => fire(accepted, delivery)), {
    shutdown: () => lifetime.drain(),
  });
}
