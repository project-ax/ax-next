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

export interface HookBusOptions {
  /** Default timeout applied to every service call without its own override. */
  defaultServiceTimeoutMs?: number;
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
}

interface RegisteredSubscriber {
  plugin: string;
  handler: SubscriberHandler;
}

export class HookBus {
  private services = new Map<string, RegisteredService>();
  private subscribers = new Map<string, RegisteredSubscriber[]>();
  private readonly defaultServiceTimeoutMs: number;

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
  }

  registerService<I, O>(
    hookName: string,
    plugin: string,
    handler: ServiceHandler<I, O>,
    opts?: { returns?: ZodType<O>; timeoutMs?: number },
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
      try {
        result = (await sub.handler(ctx, current)) as P | undefined | Rejection;
      } catch (err) {
        ctx.logger.error('hook_subscriber_failed', {
          hook: hookName,
          plugin: sub.plugin,
          err: err instanceof Error ? err : new Error(String(err)),
        });
        continue;
      }
      if (isRejection(result)) {
        return { rejected: true, reason: result.reason, source: result.source ?? sub.plugin };
      }
      if (result !== undefined) {
        current = result as P;
      }
    }
    return { rejected: false, payload: current };
  }
}
