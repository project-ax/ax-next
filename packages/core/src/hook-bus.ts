import type { ZodType } from 'zod';
import { createLogger, type AgentContext } from './context.js';
import { isRejection, PluginError, type Rejection } from './errors.js';
import type { FireResult } from './types.js';
import { withTimeout } from './util/with-timeout.js';

export type ServiceHandler<I = unknown, O = unknown> = (
  ctx: AgentContext,
  input: I,
) => Promise<O>;

/**
 * What the bus hands a subscriber alongside its ctx and payload (TASK-552).
 *
 * `signal` is this subscriber's own `AbortSignal` for this one fire. The bus
 * aborts it at the moment it stops waiting — when the caller's
 * `subscriberTimeoutMs` elapses — with a `DOMException` named `TimeoutError`
 * as its reason. It is never aborted for any other reason, and never aborted
 * at all on an unbounded fire or for a subscriber that settles in time.
 *
 * Honouring it is voluntary, and it is the only way a subscriber's WORK stops
 * once the bus has given up on its RESULT: JavaScript cannot cancel a promise.
 * A subscriber doing something long or side-effecting (a storage write, a
 * network call, a model call) should check `signal.aborted` before each step
 * that commits something, or pass the signal down to an API that takes one.
 * Stopping with `signal.throwIfAborted()` is fine — the bus recognises its own
 * abort reason and logs it at debug rather than as a failure.
 *
 * Deliberately NOT on `AgentContext`: the ctx flows on into every service
 * call a subscriber makes, and a signal there would read as a contract those
 * services honour, which none do today. It is per-subscriber, not per-fire,
 * so one slow subscriber being told to stop never tells its neighbours to.
 */
export interface SubscriberInvocation {
  readonly signal: AbortSignal;
}

export type SubscriberHandler<P = unknown> = (
  ctx: AgentContext,
  payload: P,
  invocation: SubscriberInvocation,
) => Promise<P | undefined | Rejection>;

/** Default per-service-call timeout. A hang backstop, not a latency SLA. */
export const DEFAULT_SERVICE_TIMEOUT_MS = 120_000;

/**
 * How long a single service call or subscriber may stay in flight before the
 * bus says so, out loud, WHILE IT IS STILL RUNNING.
 *
 * Why this exists (TASK-505). A turn used to be able to sit for the full
 * 120 s service timeout and emit nothing at all — not even at `LOG_LEVEL=debug`
 * — and then fail with `service hook 'agent:invoke' exceeded 120000ms`. That
 * message names the OUTERMOST call, which is the one thing an operator already
 * knew. The thing actually stuck was a subscriber several frames down, and
 * `fire()` had no timeout at all, so it was never going to name itself.
 * (Since TASK-514 a caller may bound its subscribers with
 * `subscriberTimeoutMs`; the default is still unbounded.)
 *
 * Three properties matter, and each one is load-bearing:
 *
 *  1. It fires *during* the stall, not after. A report that only arrives on
 *     settle never arrives for a hang that never settles.
 *  2. It covers `fire()` too. Subscribers are the untimed half of the bus, so
 *     they were exactly where a hang could hide.
 *  3. It names the plugin and hook. "Something is slow" is not a thread to
 *     pull; "@ax/memory-strata is 15 s into chat:start" is.
 *
 * 15 s is chosen to be far above what a hook on a per-turn path costs when it
 * is healthy, and far below the 120 s timeout, so a stalling call reports
 * itself with 105 s of runway left.
 *
 * It is deliberately NOT right for every hook. The ones it is wrong for are the
 * ones for which running for minutes is NORMAL, not merely possible:
 * `agent:invoke` spans a whole turn, an LLM call spans a whole generation.
 * Warning at 15 s on those fires on the healthy case every time and trains
 * everyone to filter the exact message this exists to surface — so they pass
 * their own `stallWarnMs` at registration.
 *
 * "Normal", not "possible", is the test, and it is why a long declared
 * `timeoutMs` alone does not earn an override. `sandbox:open-session` declares
 * 300 s too, but its warm path is a couple of seconds and that 300 s is a
 * worst-case backstop for a cold image pull. A spawn still running at 15 s is
 * a fact worth a line, so it keeps the default on purpose — see the note at
 * its registration.
 */
export const DEFAULT_STALL_WARN_MS = 15_000;

export interface HookBusOptions {
  /** Default timeout applied to every service call without its own override. */
  defaultServiceTimeoutMs?: number;
  /**
   * How long a service call or subscriber may run before the bus logs that it
   * is still in flight. `Infinity` disables the watch entirely (tests that
   * assert on log output and don't care about it can opt out this way).
   */
  stallWarnMs?: number;
}

/**
 * A timeout is valid if it is `Infinity` (the explicit "no timeout" sentinel) or
 * a finite, non-negative number. We reject `NaN`, negatives, and `-Infinity`
 * loudly at config time: a negative delay clamps to ~1ms and would spuriously
 * time out every call, while `NaN`/`-Infinity` would silently disable the timer
 * and quietly drop the hang protection. Only `Infinity` may disable it, on purpose.
 */
function isValidTimeoutMs(value: number): boolean {
  return value === Number.POSITIVE_INFINITY || (Number.isFinite(value) && value >= 0);
}

interface RegisteredService {
  plugin: string;
  handler: ServiceHandler;
  returns?: ZodType;
  timeoutMs?: number;
  stallWarnMs?: number;
}

interface RegisteredSubscriber {
  plugin: string;
  handler: SubscriberHandler;
}

/** Per-call options for `HookBus.fire`. */
export interface FireOptions {
  /**
   * Bound on EACH subscriber, in ms (TASK-514). A subscriber still running
   * when it elapses is skipped — logged as `hook_subscriber_timed_out`, its
   * result discarded, its `invocation.signal` aborted (TASK-552) — and the
   * fire moves on. Omitted or `Infinity` means no
   * bound. `NaN`, negatives and `-Infinity` are rejected, never treated as
   * "no bound", for the same reason as a service `timeoutMs`.
   */
  subscriberTimeoutMs?: number;
}

/** How one subscriber's run ended, from `fire`'s point of view. */
type SubscriberOutcome<P> =
  | { kind: 'settled'; result: P | undefined | Rejection }
  | { kind: 'failed' }
  | { kind: 'timed-out' };

/**
 * Warn through `ctx.logger` without ever becoming the reason a hook failed.
 *
 * The stall watch is diagnostics. Plenty of call sites (tests, canaries,
 * synthetic contexts) hand the bus a partial ctx, and a watchdog that throws
 * because there was no logger to complain to would be a new silent-failure
 * source bolted onto the fix for one.
 */
function warnQuietly(
  ctx: AgentContext,
  msg: string,
  bindings: Record<string, unknown>,
): void {
  try {
    ctx.logger?.warn(msg, bindings);
  } catch {
    /* a logger that throws must not take the hook down with it */
  }
}

/**
 * Report a subscriber that threw, without ever throwing from the report.
 *
 * This used to be a bare `ctx.logger.error(...)`. Under a ctx with no logger
 * (canaries, synthetic contexts) — or one whose `error` throws — the log line
 * raised its own TypeError out of `fire()`'s catch block. That skipped EVERY
 * REMAINING SUBSCRIBER and handed the caller the TypeError instead of anything
 * about the subscriber that failed: diagnostics changing control flow, and
 * erasing the very error they were reporting (TASK-512).
 *
 * Unlike `warnQuietly`, this does not go silent when the logger is unusable.
 * A subscriber that really threw is worth a line even on a partial ctx, so it
 * falls back to one structured JSON line on stderr carrying the same message
 * and the ORIGINAL error. Only if that write fails too does it give up — at
 * that point there is nowhere left to say it, and throwing would bring back
 * the bug.
 *
 * `fire()`'s contract is unchanged: it never propagates subscriber errors to
 * the caller, and this function does not start doing so.
 */
function reportSubscriberFailure(
  ctx: AgentContext,
  // `timedOut` marks a throw that arrived AFTER the subscriber had already
  // blown its `subscriberTimeoutMs` — the fire it belonged to has moved on.
  bindings: { hook: string; plugin: string; err: Error; timedOut?: true },
): void {
  try {
    const logger = ctx?.logger;
    if (typeof logger?.error === 'function') {
      logger.error('hook_subscriber_failed', bindings);
      return;
    }
  } catch {
    /* the ctx's logger is broken — fall through to the last-resort line */
  }
  try {
    const reqId = typeof ctx?.reqId === 'string' ? ctx.reqId : 'unknown';
    createLogger({
      reqId,
      writer: (line) => process.stderr.write(line + '\n'),
    }).error('hook_subscriber_failed', bindings);
  } catch {
    /* nowhere left to report to; throwing here would skip the remaining subscribers */
  }
}

export class HookBus {
  private services = new Map<string, RegisteredService>();
  private subscribers = new Map<string, RegisteredSubscriber[]>();
  private readonly defaultServiceTimeoutMs: number;
  private readonly stallWarnMs: number;

  constructor(opts?: HookBusOptions) {
    const configured = opts?.defaultServiceTimeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS;
    if (!isValidTimeoutMs(configured)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: 'core',
        message: `HookBus defaultServiceTimeoutMs must be a non-negative finite number or Infinity (got ${configured})`,
      });
    }
    this.defaultServiceTimeoutMs = configured;
    const stall = opts?.stallWarnMs ?? DEFAULT_STALL_WARN_MS;
    if (!isValidTimeoutMs(stall)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: 'core',
        message: `HookBus stallWarnMs must be a non-negative finite number or Infinity (got ${stall})`,
      });
    }
    this.stallWarnMs = stall;
  }

  /**
   * Start the stall watch for one in-flight hook. Returns the settle function
   * — call it exactly once, in a `finally`, however the hook ends.
   *
   * On stall we emit `<kind>_stalled` while the work is still running, and on
   * a late settle we emit `<kind>_slow` with the real duration. The pair is
   * what lets an operator tell "slow but finished" from "never finished":
   * a `_stalled` with no matching `_slow` IS the hang, named.
   */
  private watchStall(
    ctx: AgentContext,
    kind: 'hook_call' | 'hook_subscriber',
    hookName: string,
    plugin: string,
    // Required, with no default: the caller resolves it, so there is exactly
    // one place the effective threshold is decided per call site.
    warnMs: number,
  ): () => void {
    if (!Number.isFinite(warnMs)) return () => undefined;
    const startedAt = Date.now();
    let stalled = false;
    const timer = setTimeout(() => {
      stalled = true;
      warnQuietly(ctx, `${kind}_stalled`, {
        hook: hookName,
        plugin,
        stalledForMs: Date.now() - startedAt,
      });
    }, warnMs);
    timer.unref?.();
    return () => {
      clearTimeout(timer);
      if (stalled) {
        warnQuietly(ctx, `${kind}_slow`, {
          hook: hookName,
          plugin,
          durationMs: Date.now() - startedAt,
        });
      }
    };
  }

  registerService<I, O>(
    hookName: string,
    plugin: string,
    handler: ServiceHandler<I, O>,
    opts?: {
      returns?: ZodType<O>;
      timeoutMs?: number;
      /**
       * Override the bus-wide stall threshold for THIS hook. Pass it when the
       * hook legitimately runs long — a whole turn, a whole generation — so the
       * stall warning stays a signal instead of becoming background noise.
       * `Infinity` opts the hook out of the stall watch entirely, which is the
       * right answer for a frame whose own timeout is already its report.
       */
      stallWarnMs?: number;
    },
  ): void {
    const existing = this.services.get(hookName);
    if (existing !== undefined) {
      throw new PluginError({
        code: 'duplicate-service',
        plugin,
        message: `service hook '${hookName}' already registered by plugin '${existing.plugin}'`,
      });
    }
    const record: RegisteredService = { plugin, handler: handler as ServiceHandler };
    if (opts?.returns !== undefined) record.returns = opts.returns as ZodType;
    if (opts?.timeoutMs !== undefined) {
      if (!isValidTimeoutMs(opts.timeoutMs)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin,
          hookName,
          message: `service hook '${hookName}' timeoutMs must be a non-negative finite number or Infinity (got ${opts.timeoutMs})`,
        });
      }
      record.timeoutMs = opts.timeoutMs;
    }
    if (opts?.stallWarnMs !== undefined) {
      if (!isValidTimeoutMs(opts.stallWarnMs)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin,
          hookName,
          message: `service hook '${hookName}' stallWarnMs must be a non-negative finite number or Infinity (got ${opts.stallWarnMs})`,
        });
      }
      record.stallWarnMs = opts.stallWarnMs;
    }
    this.services.set(hookName, record);
  }

  hasService(hookName: string): boolean {
    return this.services.has(hookName);
  }

  /**
   * Snapshot of currently-registered service-hook names. Order is
   * registration order (Map iteration order). Returned as a fresh array
   * so callers can't mutate internal state.
   */
  listServices(): string[] {
    return [...this.services.keys()];
  }

  async call<I, O>(hookName: string, ctx: AgentContext, input: I): Promise<O> {
    const registered = this.services.get(hookName);
    if (registered === undefined) {
      throw new PluginError({
        code: 'no-service',
        plugin: 'core',
        hookName,
        message: `no plugin registered for service hook '${hookName}'`,
      });
    }
    const timeoutMs = registered.timeoutMs ?? this.defaultServiceTimeoutMs;
    // Report a call that is TAKING too long while it still is, not only if it
    // eventually blows the timeout. See DEFAULT_STALL_WARN_MS.
    const settleStallWatch = this.watchStall(
      ctx,
      'hook_call',
      hookName,
      registered.plugin,
      registered.stallWarnMs ?? this.stallWarnMs,
    );
    try {
      const result = await withTimeout(
        registered.handler(ctx, input),
        timeoutMs,
        () =>
          new PluginError({
            code: 'timeout',
            plugin: registered.plugin,
            hookName,
            message: `service hook '${hookName}' exceeded ${timeoutMs}ms`,
          }),
      );
      if (registered.returns !== undefined) {
        const parsed = registered.returns.safeParse(result);
        if (!parsed.success) {
          throw new PluginError({
            code: 'invalid-return',
            plugin: registered.plugin,
            hookName,
            message: `service hook '${hookName}' returned an invalid shape: ${parsed.error.message}`,
          });
        }
        // Return the parsed value, not the raw result: this applies any zod
        // coercion/defaults the schema declares. Note zod object schemas
        // *strip* undeclared keys by default, so a `returns` schema is the
        // authoritative shape — a handler field absent from the schema is
        // dropped here. Declare `returns` as a faithful shape assertion (add
        // `.passthrough()` if a hook intentionally returns extra keys).
        return parsed.data as O;
      }
      return result as O;
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError({
        code: 'unknown',
        plugin: registered.plugin,
        hookName,
        message: `service hook '${hookName}' threw: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    } finally {
      settleStallWatch();
    }
  }

  subscribe<P>(hookName: string, plugin: string, handler: SubscriberHandler<P>): void {
    const list = this.subscribers.get(hookName) ?? [];
    list.push({ plugin, handler: handler as SubscriberHandler });
    this.subscribers.set(hookName, list);
  }

  /**
   * Remove every subscriber registered by `plugin` on `hookName`. Returns
   * the count removed (0 if none matched). Plugins call this in `shutdown`
   * so a re-init of the same kernel doesn't leave stale closures running.
   */
  unsubscribe(hookName: string, plugin: string): number {
    const list = this.subscribers.get(hookName);
    if (list === undefined) return 0;
    const before = list.length;
    const filtered = list.filter((s) => s.plugin !== plugin);
    if (filtered.length === before) return 0;
    if (filtered.length === 0) {
      this.subscribers.delete(hookName);
    } else {
      this.subscribers.set(hookName, filtered);
    }
    return before - filtered.length;
  }

  /**
   * Run ONE subscriber under a finite `timeoutMs` (the unbounded path lives
   * inline in `fire`, see there for why).
   *
   * A subscriber that blows the bound is abandoned and TOLD to stop: its
   * `invocation.signal` is aborted at the bound (TASK-552). JavaScript has no
   * way to stop a promise, so stopping is up to the subscriber — one that
   * ignores the signal keeps running. What we guarantee regardless is narrower
   * and checkable — once the bound passes, its RESULT has no say over this
   * fire. Its eventual return value (a transform or a veto) is discarded; a
   * late throw is still reported, flagged `timedOut: true`, so it is never
   * swallowed — unless the throw IS our abort reason, which means it stopped
   * because we asked, and that is logged at debug as `hook_subscriber_aborted`;
   * and its stall watch stays armed until it really settles, so `_stalled`
   * without `_slow` keeps meaning "never finished".
   *
   * What it can still do: anything by side effect — including MUTATING the
   * payload object in place, since it holds the same reference later
   * subscribers (and the caller's returned `payload`) see. That window is new
   * with the bound: before, an in-place mutation could only land before fire
   * returned. Subscribers are expected to return a new payload rather than
   * mutate (every subscriber in the tree today does, or ignores the payload),
   * so we document it rather than freeze the payload out from under them.
   */
  private async runBoundedSubscriber<P>(
    sub: RegisteredSubscriber,
    hookName: string,
    ctx: AgentContext,
    current: P,
    timeoutMs: number,
  ): Promise<SubscriberOutcome<P>> {
    const settleStallWatch = this.watchStall(
      ctx,
      'hook_subscriber',
      hookName,
      sub.plugin,
      this.stallWarnMs,
    );
    let timedOut = false;
    const controller = new AbortController();
    let run: Promise<unknown>;
    try {
      run = Promise.resolve(sub.handler(ctx, current, { signal: controller.signal }));
    } catch (err) {
      // A non-async handler can throw synchronously; treat it like any throw.
      run = Promise.reject(err);
    }
    const tracked: Promise<SubscriberOutcome<P>> = run
      .then(
        (result): SubscriberOutcome<P> => ({
          kind: 'settled',
          result: result as P | undefined | Rejection,
        }),
        (err: unknown): SubscriberOutcome<P> => {
          // Thrown our own abort reason back at us (`signal.throwIfAborted()`):
          // the subscriber stopped because we asked it to. The timeout was
          // already warned; an error line here would report compliance as a
          // failure. Identity, not shape — only OUR reason object counts.
          if (timedOut && controller.signal.aborted && err === controller.signal.reason) {
            try {
              ctx.logger?.debug('hook_subscriber_aborted', {
                hook: hookName,
                plugin: sub.plugin,
              });
            } catch {
              /* diagnostics must not change control flow */
            }
            return { kind: 'failed' };
          }
          // Isolation is the contract: a throwing subscriber is reported and
          // the chain continues. The report must never break that contract
          // itself — see `reportSubscriberFailure` for why it cannot throw.
          reportSubscriberFailure(ctx, {
            hook: hookName,
            plugin: sub.plugin,
            err: err instanceof Error ? err : new Error(String(err)),
            ...(timedOut ? { timedOut: true as const } : {}),
          });
          return { kind: 'failed' };
        },
      )
      .finally(settleStallWatch);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<SubscriberOutcome<P>>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        warnQuietly(ctx, 'hook_subscriber_timed_out', {
          hook: hookName,
          plugin: sub.plugin,
          timeoutMs,
        });
        resolve({ kind: 'timed-out' });
        // Tell the subscriber to stop, AFTER the fire has its answer: abort
        // listeners run synchronously inside `abort()`, and whatever they do
        // is the subscriber's business, not this fire's. The reason matches
        // what `AbortSignal.timeout()` would give, so code that already knows
        // how to read a timeout abort reads this one.
        controller.abort(
          new DOMException(
            `subscriber '${sub.plugin}' on '${hookName}' exceeded ${timeoutMs}ms`,
            'TimeoutError',
          ),
        );
      }, timeoutMs);
      // Same posture as `withTimeout`: the bound never keeps the process alive.
      timer.unref?.();
    });
    try {
      return await Promise.race([tracked, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run every subscriber on `hookName`, in registration order.
   *
   * `opts.subscriberTimeoutMs` (TASK-514) bounds EACH subscriber. It is
   * opt-in, and the caller — the owner of the hook's latency contract — picks
   * the value, the way a service registrar picks its own `timeoutMs` and
   * `stallWarnMs`. A subscriber that exceeds it is named in a
   * `hook_subscriber_timed_out` warning and SKIPPED: its effect is dropped,
   * its `invocation.signal` is aborted so it can stop its work (TASK-552), and
   * the remaining subscribers run. It never fails the fire. Omitted (or
   * `Infinity`), `fire` waits for its subscribers however long they take,
   * exactly as it always has.
   */
  async fire<P>(
    hookName: string,
    ctx: AgentContext,
    payload: P,
    opts?: FireOptions,
  ): Promise<FireResult<P>> {
    const timeoutMs = opts?.subscriberTimeoutMs ?? Number.POSITIVE_INFINITY;
    if (!isValidTimeoutMs(timeoutMs)) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: 'core',
        hookName,
        message: `fire('${hookName}') subscriberTimeoutMs must be a non-negative finite number or Infinity (got ${timeoutMs})`,
      });
    }
    const list = this.subscribers.get(hookName) ?? [];
    let current: P = payload;
    for (const sub of list) {
      let result: P | undefined | Rejection;
      if (Number.isFinite(timeoutMs)) {
        const outcome = await this.runBoundedSubscriber(sub, hookName, ctx, current, timeoutMs);
        if (outcome.kind !== 'settled') continue;
        result = outcome.result;
      } else {
        // The unbounded path is kept exactly as it was — one `await` on the
        // handler, nothing wrapped around it — ON PURPOSE. The bounded path
        // costs a few extra microtask hops per subscriber, and existing fire
        // sites have come to depend on the old ordering: measured on this
        // branch (TASK-514), routing every subscriber through the helper's
        // promise chain let
        // `agent:invoke`'s caller resume before a LATER `chat:end` subscriber
        // ran, and preset-k8s's once-per-invoke witness saw zero fires.
        //
        // `fire` stays unbounded by default — a subscriber's slowness must not
        // fail the thing it is observing — which makes subscribers the one
        // place on the bus where a hang can burn a caller's budget in silence.
        // The stall watch names such a hang while it is happening. Subscribers
        // keep the bus-wide stall threshold: `subscribe` has no options bag to
        // carry an override, and 15s is right for them.
        const settleStallWatch = this.watchStall(
          ctx,
          'hook_subscriber',
          hookName,
          sub.plugin,
          this.stallWarnMs,
        );
        try {
          // A fresh controller per subscriber even though nothing here ever
          // aborts it: handlers can rely on `signal` always being present, and
          // a shared never-aborting signal would accumulate every listener
          // any subscriber ever added to it. Allocation only — no extra
          // microtask hop, so the ordering note above still holds.
          result = (await sub.handler(ctx, current, {
            signal: new AbortController().signal,
          })) as P | undefined | Rejection;
        } catch (err) {
          // Isolation is the contract: a throwing subscriber is reported and
          // the chain continues. The report must never break that contract
          // itself — see `reportSubscriberFailure` for why it cannot throw.
          reportSubscriberFailure(ctx, {
            hook: hookName,
            plugin: sub.plugin,
            err: err instanceof Error ? err : new Error(String(err)),
          });
          continue;
        } finally {
          settleStallWatch();
        }
      }
      if (isRejection(result)) {
        // SPREAD the subscriber's rejection; do not rebuild it. This used to
        // construct a fresh `{rejected, reason, source}`, which silently
        // dropped every field a SUBTYPE of `Rejection` added — invisible while
        // `Rejection` was the only shape anyone returned, and a real bug the
        // moment one carried payload. `Hold` (see errors.ts) carries `.hold`,
        // and losing it meant the one handler that reads it (`tool.pre-call`)
        // never saw a hold: every one would have flattened into a plain deny,
        // the exact outcome `hold` exists to prevent. Spreading fixes that for
        // Hold AND for whatever subtype comes next. Only `source` is
        // defaulted, to attribute an unattributed veto to its subscriber.
        return { ...result, source: result.source ?? sub.plugin };
      }
      if (result !== undefined) {
        current = result as P;
      }
    }
    return { rejected: false, payload: current };
  }
}
