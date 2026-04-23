import type { ChatContext } from './context.js';
import { PluginError } from './errors.js';

export type ServiceHandler<I = unknown, O = unknown> = (
  ctx: ChatContext,
  input: I,
) => Promise<O>;

interface RegisteredService {
  plugin: string;
  handler: ServiceHandler;
}

export class HookBus {
  private services = new Map<string, RegisteredService>();

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
        message: `service hook '${hookName}' threw: ${(err as Error).message ?? String(err)}`,
        cause: err,
      });
    }
  }
}
