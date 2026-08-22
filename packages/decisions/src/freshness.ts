/**
 * Capture at hold-time, re-check at approve-time.
 *
 * A decision drafted at 7am and approved at 1pm may be approving a world that
 * no longer exists. Replaying the recorded call is byte-faithful to what the
 * human read and blind to everything that changed since — so we re-read the
 * predicate the tool captured, and if it moved, NOTHING executes. The decision
 * re-opens carrying what changed, with the predicate re-captured so a second
 * approval (now an informed one) proceeds.
 *
 * Both hooks are optional. A tool with neither is unguarded and executes on
 * approval, which is correct for a call with nothing meaningful to re-check and
 * WRONG for one that spends money — see the open question this task carries
 * forward (plan AW-7).
 *
 * THE TWO ASYMMETRIES, STATED OUT LOUD, because they are the whole design:
 *
 *   1. CAPTURE fails OPEN. It runs inside `tool:pre-call`, on the hold branch,
 *      inside a 10 s ceiling. A capture that throws must not turn a hold into a
 *      deny — that would let one broken producer take the entire approval
 *      surface down, and "we could not capture a predicate" is not a reason to
 *      refuse a call a human was about to be asked about. The row is written
 *      with `freshness: null`, which CLAIMS NOTHING: no "checked against…"
 *      clause is rendered, so the surface never asserts a guard it does not
 *      have. The loss is logged at error level, loudly, because a silently
 *      unguarded row is the one outcome worth finding in a log.
 *
 *   2. CHECK fails CLOSED. An unreadable world is a changed world. A check hook
 *      that is gone, that throws, or that answers with a shape we cannot read
 *      all resolve to "changed", which re-opens the decision and executes
 *      nothing. That is the honest reading: we were asked to confirm the world
 *      still matches and we could not, so we must not act.
 *
 * Both hook names are DYNAMIC — `tool-freshness:capture:<toolName>`, built from
 * `call.name`, which is MODEL-AUTHORED. That is the same documented
 * dynamic-service-hook exception `tool:execute:<name>` takes in `replay.ts` and
 * in `ipc-core`'s `tool-execute-host.ts`, and it is safe for the same one
 * narrow reason: `hasService` is an exact-match lookup in a map the HOST
 * populated at boot, so the worst a hostile name can do is MISS. It cannot
 * traverse, glob or escalate — and a miss means "unguarded" on the capture side
 * and "changed" on the check side, never "run it".
 */
import type { AgentContext, HookBus, ToolCall } from '@ax/core';
import type { FreshnessPredicate } from './types.js';

/**
 * The plugin name on this module's log lines. A literal rather than an import
 * from `pre-call.ts`: that module imports nothing from here, and keeping the
 * dependency one-way stops the gate and the guard from becoming a cycle.
 */
const FRESHNESS_LOG_PLUGIN = '@ax/decisions';

export const FRESHNESS_CAPTURE_PREFIX = 'tool-freshness:capture:';
export const FRESHNESS_CHECK_PREFIX = 'tool-freshness:check:';

export function freshnessCaptureHook(toolName: string): string {
  return `${FRESHNESS_CAPTURE_PREFIX}${toolName}`;
}

export function freshnessCheckHook(toolName: string): string {
  return `${FRESHNESS_CHECK_PREFIX}${toolName}`;
}

/** `tool-freshness:capture:<tool>` input. */
export interface FreshnessCaptureInput {
  /** The call about to be held, verbatim. */
  call: ToolCall;
}

/** `tool-freshness:capture:<tool>` output. `null` means "nothing to guard". */
export interface FreshnessCaptureOutput {
  predicate: FreshnessPredicate | null;
}

/** `tool-freshness:check:<tool>` input. */
export interface FreshnessCheckInput {
  /** What the tool captured at hold-time, exactly as it was stored. */
  predicate: FreshnessPredicate;
}

/** `tool-freshness:check:<tool>` output. */
export interface FreshnessCheckOutput {
  /** The predicate's value RIGHT NOW. Compared against the captured one. */
  value: string;
  /** One human-readable sentence naming what moved. Optional. */
  changed?: string | undefined;
}

/**
 * The value recorded when the world could not be read at all.
 *
 * It is a value like any other, and that is what makes the second approval
 * work: the first approval stales the row and re-captures THIS token, so a
 * second approval — with the check still broken — observes the same token,
 * matches, and proceeds. The human was told once that we could not confirm
 * anything; after that it is their call. Bouncing forever is the alternative,
 * and the acceptance criteria rule it out by name.
 */
export const UNREADABLE_VALUE = 'ax:freshness-unreadable';

/** What a human is told when the guard could not read the world. */
export const UNREADABLE_SENTENCE =
  'We could not re-check whether this is still current, so it is being treated ' +
  'as changed. Nothing was done.';

/**
 * The shape a predicate `kind` is allowed to have before we are willing to
 * store it.
 *
 * Tighter than "any string" because `kind` IS RENDERED: the machine's fallback
 * `staleReason` is built by de-hyphenating it, and that sentence lands in front
 * of a human. A producer is in-repo code, but a producer's own inputs may not
 * be — so the grammar is checked here rather than assumed.
 */
const KIND_GRAMMAR = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * How long a producer gets, enforced HERE rather than left to the bus.
 *
 * THE HOLE THIS CLOSES. `HookBus`'s default service timeout is 120 s, and a
 * service's timeout is set by whoever REGISTERED it — a caller cannot cap it.
 * `tool.pre-call` has a 10 s IPC ceiling (`IPC_TIMEOUTS_MS['tool.pre-call']`),
 * and the runner turns a blown ceiling into a DENY. So a producer that hangs
 * would do exactly what asymmetry 1 exists to prevent: take the approval
 * surface down for its tool, from the outside, without ever throwing.
 *
 * Both producers AW-7 ships also declare their own `timeoutMs`, which is the
 * tidier half — the bus stops waiting rather than us walking away from a call
 * still in flight. This budget is the half that holds for a producer we do not
 * own, and it is the one that makes the guarantee unconditional.
 *
 * CAPTURE's budget is well inside the pre-call ceiling, which it shares with a
 * policy call, an attendance read and a row write. CHECK runs on an approval
 * request, where the only deadline is a human watching a button, so it gets
 * more room.
 */
const CAPTURE_BUDGET_MS = 3_000;
const CHECK_BUDGET_MS = 10_000;

const TIMED_OUT = Symbol('freshness-budget-exceeded');

/**
 * Run `work`, but never wait longer than `ms`.
 *
 * The settle-then-race shape is deliberate: racing the raw promise leaves an
 * UNHANDLED REJECTION behind whenever the loser rejects after the budget has
 * already won, and an unhandled rejection in a host process is a crash on some
 * Node configurations. Folding the outcome into a value first means the loser
 * can never reject at all.
 */
async function withBudget<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown } | typeof TIMED_OUT> {
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Never hold the process open for a producer that is not coming back.
    timer.unref?.();
  });
  try {
    return await Promise.race([settled, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const VALUE_MAX_CHARS = 512;
const LABEL_MAX_CHARS = 120;
const CHANGED_MAX_CHARS = 200;

/**
 * Everything that can make rendered text say something other than what is on
 * the wire: C0/C1 controls (a newline forges a separate line in a log or a hold
 * note), the zero-width family, and the bidi overrides/isolates behind Trojan
 * Source (CVE-2021-42574) — a lone U+202E reverses the visual order of
 * everything after it, and an unterminated isolate leaks that reordering into
 * whatever the renderer draws next.
 *
 * Written as `\uXXXX` escapes rather than literal bytes: a raw control byte in
 * a source file makes git treat it as binary and the diff unreviewable.
 *
 * A deliberate local twin of `@ax/channel-web`'s `fenceLine` and
 * `@ax/agent-activity`'s `fencePhrase` rather than an import — plugins talk
 * through the hook bus, never through each other's modules (invariant 2).
 */
const REWRITES_THE_SURFACE =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/g;

/**
 * One line, plain text, bounded — or `null` when nothing legible survives.
 *
 * The cap counts CODE POINTS, not UTF-16 units, so truncation can never split a
 * surrogate pair and leave a lone half behind.
 */
function fenceLine(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const flattened = value.replace(REWRITES_THE_SURFACE, ' ').replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) return null;
  const points = [...flattened];
  if (points.length <= maxChars) return flattened;
  return `${points.slice(0, maxChars - 1).join('').trimEnd()}…`;
}

/**
 * A value token, made safe to store.
 *
 * `value` is never rendered — it is compared, and only ever against another
 * value from the same producer — so it is stripped and clamped rather than
 * fenced for legibility. Stripping rather than replacing with a space matters
 * here: the token has to survive a round trip unchanged or the guard trips on
 * its own normalisation.
 */
function normalizeValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(REWRITES_THE_SURFACE, '').trim();
  if (stripped.length === 0) return null;
  const points = [...stripped];
  return points.length <= VALUE_MAX_CHARS ? stripped : points.slice(0, VALUE_MAX_CHARS).join('');
}

/**
 * A producer's captured predicate, made safe to store.
 *
 * `kind` and `label` DO reach a human, so they are held to the grammar and the
 * fence above. A predicate that fails any of it is dropped WHOLE: half a
 * predicate would guard against half a world.
 */
function normalizePredicate(raw: unknown): FreshnessPredicate | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const kind = typeof p.kind === 'string' ? p.kind.trim() : '';
  if (!KIND_GRAMMAR.test(kind)) return null;
  const value = normalizeValue(p.value);
  if (value === null) return null;
  return {
    kind,
    value,
    // Nullable since AW-7: a stale row DROPS its "checked against…" clause,
    // because that sentence describes hold-time and is false once the guard has
    // tripped. A producer with nothing readable to say may also send null.
    label: fenceLine(p.label, LABEL_MAX_CHARS),
  };
}

/**
 * Ask the tool for a predicate to guard this call with.
 *
 * TOTAL — it never throws. It is called from the `tool:pre-call` gate, where a
 * throw would be caught by that module's fail-closed wrapper and turn a hold
 * into a deny. See asymmetry 1 in this file's header.
 */
export async function captureFreshness(
  bus: HookBus | undefined,
  ctx: AgentContext,
  call: ToolCall,
): Promise<FreshnessPredicate | null> {
  if (bus === undefined) return null;
  const hook = freshnessCaptureHook(call.name);
  // Not a degradation worth logging: most tools have nothing to re-check, and
  // an unguarded row for one of them is the designed outcome, not a gap.
  if (!bus.hasService(hook)) return null;

  const outcome = await withBudget(
    bus.call<FreshnessCaptureInput, FreshnessCaptureOutput>(hook, ctx, { call }),
    CAPTURE_BUDGET_MS,
  );

  if (outcome === TIMED_OUT) {
    ctx.logger.error('decision_freshness_capture_timeout', {
      plugin: FRESHNESS_LOG_PLUGIN,
      tool: call.name,
      budgetMs: CAPTURE_BUDGET_MS,
    });
    return null;
  }

  if (!outcome.ok) {
    ctx.logger.error('decision_freshness_capture_failed', {
      plugin: FRESHNESS_LOG_PLUGIN,
      tool: call.name,
      err: outcome.err instanceof Error ? outcome.err : new Error(String(outcome.err)),
    });
    // Fails OPEN, on purpose, and the row then says nothing about freshness
    // rather than claiming a guard it does not have. See asymmetry 1.
    return null;
  }

  const raw = outcome.value?.predicate;
  const predicate = normalizePredicate(raw);
  if (predicate === null && raw !== null && raw !== undefined) {
    // The producer answered, and we could not read the answer. Distinct from
    // "this call has nothing to guard", and worth saying so.
    ctx.logger.error('decision_freshness_capture_unreadable', {
      plugin: FRESHNESS_LOG_PLUGIN,
      tool: call.name,
    });
  }
  return predicate;
}

/**
 * Re-read the predicate. Fails CLOSED: anything we cannot read comes back as
 * `UNREADABLE_VALUE`, which will not match what was captured, which re-opens
 * the decision without executing.
 *
 * TOTAL — it never throws. The caller is mid-approval with a durable row to
 * update either way.
 */
export async function checkFreshness(
  bus: HookBus,
  ctx: AgentContext,
  toolName: string,
  predicate: FreshnessPredicate,
): Promise<FreshnessCheckOutput> {
  const hook = freshnessCheckHook(toolName);
  const unreadable = (): FreshnessCheckOutput => ({
    value: UNREADABLE_VALUE,
    changed: UNREADABLE_SENTENCE,
  });

  if (!bus.hasService(hook)) {
    // The tool captured a predicate and then lost (or never had) the half that
    // re-reads it. We are holding a promise we cannot keep, so we keep the safe
    // half of it.
    ctx.logger.error('decision_freshness_check_missing', {
      plugin: FRESHNESS_LOG_PLUGIN,
      tool: toolName,
      hook,
    });
    return unreadable();
  }

  const outcome = await withBudget(
    bus.call<FreshnessCheckInput, FreshnessCheckOutput>(hook, ctx, { predicate }),
    CHECK_BUDGET_MS,
  );

  if (outcome === TIMED_OUT) {
    // A world we ran out of time to read is a world we did not read.
    ctx.logger.error('decision_freshness_check_timeout', {
      plugin: FRESHNESS_LOG_PLUGIN,
      tool: toolName,
      budgetMs: CHECK_BUDGET_MS,
    });
    return unreadable();
  }

  if (!outcome.ok) {
    ctx.logger.error('decision_freshness_check_failed', {
      plugin: FRESHNESS_LOG_PLUGIN,
      tool: toolName,
      err: outcome.err instanceof Error ? outcome.err : new Error(String(outcome.err)),
    });
    return unreadable();
  }

  const value = normalizeValue(outcome.value?.value);
  if (value === null) {
    ctx.logger.error('decision_freshness_check_unreadable', {
      plugin: FRESHNESS_LOG_PLUGIN,
      tool: toolName,
    });
    return unreadable();
  }
  const changed = fenceLine(outcome.value?.changed, CHANGED_MAX_CHARS);
  return changed === null ? { value } : { value, changed };
}

/**
 * A `check` hook with no matching `capture` never guards anything: nothing
 * writes the predicate it exists to re-read, so every decision for that tool is
 * unguarded and the surface looks fine. That is exactly the failure the
 * boundary review named — silent, permanent, and invisible from either side.
 *
 * The reverse (capture with no check) is not silent — `checkFreshness` fails
 * closed and every guarded decision for that tool stales once — but it is still
 * a misconfiguration a human should hear about at boot rather than discover
 * from a confused user, so both directions are reported.
 *
 * LOGS, NEVER THROWS. A tool that wired its pair up wrong must not stop the
 * host booting; the cost of the mistake is borne by that tool, not by
 * everything else in the process.
 *
 * Returns the unpaired hook names so a caller — a preset test, a unit test —
 * can assert on them instead of scraping a logger.
 */
export function auditFreshnessPairs(
  bus: HookBus,
  ctx: AgentContext,
  alreadyReported?: Set<string>,
): string[] {
  const captures = new Set<string>();
  const checks = new Set<string>();
  for (const name of bus.listServices()) {
    if (name.startsWith(FRESHNESS_CAPTURE_PREFIX)) {
      captures.add(name.slice(FRESHNESS_CAPTURE_PREFIX.length));
    } else if (name.startsWith(FRESHNESS_CHECK_PREFIX)) {
      checks.add(name.slice(FRESHNESS_CHECK_PREFIX.length));
    }
  }

  const unpaired: string[] = [];
  const report = (tool: string, hook: string, event: string): void => {
    unpaired.push(hook);
    if (alreadyReported !== undefined) {
      if (alreadyReported.has(hook)) return;
      alreadyReported.add(hook);
    }
    ctx.logger.error(event, { plugin: FRESHNESS_LOG_PLUGIN, tool, hook });
  };

  for (const tool of checks) {
    if (captures.has(tool)) continue;
    report(tool, freshnessCheckHook(tool), 'decision_freshness_check_without_capture');
  }
  for (const tool of captures) {
    if (checks.has(tool)) continue;
    report(tool, freshnessCaptureHook(tool), 'decision_freshness_capture_without_check');
  }
  return unpaired;
}
