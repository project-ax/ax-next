import type { ChatContext } from './context.js';
import { isRejection, PluginError, type Rejection } from './errors.js';
import type { FireResult } from './types.js';

export type ServiceHandler<I = unknown, O = unknown> = (
  ctx: ChatContext,
  input: I,
) => Promise<O>;

export type SubscriberHandler<P = unknown> = (
  ctx: ChatContext,
  payload: P,
) => Promise<P | undefined | Rejection>;

interface RegisteredService {
  plugin: string;
  handler: ServiceHandler;
}

interface RegisteredSubscriber {
  plugin: string;
  handler: SubscriberHandler;
}

export class HookBus {
  private services = new Map<string, RegisteredService>();
  private subscribers = new Map<string, RegisteredSubscriber[]>();

  registerService<I, O>(hookName: string, plugin: string, handler: ServiceHandler<I, O>): void {
    const existing = this.services.get(hookName);
    if (existing !== undefined) {
      throw new PluginError({
        code: 'duplicate-service',
        plugin,
        message: `service hook '${hookName}' already registered by plugin '${existing.plugin}'`,
      });
    }
    this.services.set(hookName, { plugin, handler: handler as ServiceHandler });
  }

  hasService(hookName: string): boolean {
    return this.services.has(hookName);
  }

  async call<I, O>(hookName: string, ctx: ChatContext, input: I): Promise<O> {
    const registered = this.services.get(hookName);
    if (registered === undefined) {
      throw new PluginError({
        code: 'no-service',
        plugin: 'core',
        message: `no plugin registered for service hook '${hookName}'`,
      });
    }
    try {
      return (await registered.handler(ctx, input)) as O;
    } catch (err) {
      if (err instanceof PluginError) throw err;
      throw new PluginError({
        code: 'unknown',
        plugin: registered.plugin,
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

  async fire<P>(hookName: string, ctx: ChatContext, payload: P): Promise<FireResult<P>> {
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
        return { rejected: true, reason: result.reason, source: sub.plugin };
      }
      if (result !== undefined) {
        current = result as P;
      }
    }
    return { rejected: false, payload: current };
  }
}
