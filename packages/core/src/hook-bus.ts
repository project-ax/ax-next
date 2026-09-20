import type { ZodType } from 'zod';
import type { AgentContext } from './context.js';
import { isRejection, PluginError, type Rejection } from './errors.js';
import type { FireResult } from './types.js';
import { withTimeout } from './util/with-timeout.js';

export type ServiceHandler<I = unknown, O = unknown> = (
  ctx: AgentContext,
  input: I,
) => Promise<O>;

export type SubscriberHandler<P = unknown> = (
  ctx: AgentContext,
  payload: P,
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
 * `fire()` has no timeout at all, so it was never going to name itself.
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

  async fire<P>(hookName: string, ctx: AgentContext, payload: P): Promise<FireResult<P>> {
    const list = this.subscribers.get(hookName) ?? [];
    let current: P = payload;
    for (const sub of list) {
      let result: P | undefined | Rejection;
      // `fire` has no timeout — deliberately, since a subscriber's slowness
      // must not fail the thing it is observing. That makes subscribers the
      // one place on the bus where a hang can burn a caller's entire budget
      // in silence, so they are exactly where the stall watch earns its keep.
      // Subscribers keep the bus-wide threshold: `subscribe` has no options bag
      // to carry an override, and 15s is right for them — a subscriber on a
      // per-turn hook has no business running longer.
      const settleStallWatch = this.watchStall(
        ctx,
        'hook_subscriber',
        hookName,
        sub.plugin,
        this.stallWarnMs,
      );
      try {
        result = (await sub.handler(ctx, current)) as P | undefined | Rejection;
      } catch (err) {
        // NOTE this one is deliberately NOT routed through `warnQuietly`. The
        // stall watch is diagnostics and must never become a failure, but this
        // line reports a subscriber that actually threw — and under a ctx with
        // no usable logger, throwing here beats swallowing a real subscriber
        // error into a void. The guarantee the stall watch offers therefore
        // does not extend to this log; the asymmetry is on purpose.
        //
        // Be precise about what "throwing here" costs, though: the TypeError
        // escapes `fire()`, so it also SKIPS EVERY REMAINING SUBSCRIBER and
        // reaches the caller wearing the wrong error's name. That is a change
        // in control flow, not just in volume. It is reachable only from a ctx
        // with no logger — synthetic and canary ones — which is the same
        // population `warnQuietly` was just hardened for, so if this ever needs
        // revisiting, revisit it on purpose rather than by accident.
        ctx.logger.error('hook_subscriber_failed', {
          hook: hookName,
          plugin: sub.plugin,
          err: err instanceof Error ? err : new Error(String(err)),
        });
        continue;
      } finally {
        settleStallWatch();
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
