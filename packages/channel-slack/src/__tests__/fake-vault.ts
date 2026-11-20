import { PluginError, type HookBus } from '@ax/core';

/**
 * A fake vault behind the bus's `credentials:*` hooks, in memory. Each call is
 * recorded in `vaultCalls`/`vaultAs` and in `trail` (`vault:<hook> <name>`),
 * and `vaultFailures` makes one fail.
 */
export function busVault(bus: HookBus, trail: string[]) {
  const vault = new Map<string, string>();
  const vaultCalls: Array<{ hook: string; ref: string }> = [];
  /**
   * Whom each vault call names (TASK-1128): a read's `userId`, a write's or
   * delete's ctx user. Apart from vaultCalls, whose entries tests compare whole.
   */
  const vaultAs: Array<{ hook: string; name: string; userId: string }> = [];
  /**
   * `<hook> <secret name>` → what that call throws. `<hook> <ref>` names one
   * ref only, so one person's configuration token can fail while another's
   * doesn't (both end in `config-refresh-token`); it wins over the name.
   */
  const vaultFailures = new Map<string, unknown>();
  const nameOf = (ref: string): string => ref.slice(ref.lastIndexOf(':') + 1);
  const vaultHook = (hook: string, run: (input: Record<string, unknown>) => unknown): void => {
    bus.registerService(hook, '@ax/credentials', async (ctx, raw) => {
      const input = raw as Record<string, unknown>;
      const ref = String(input['ref']);
      vaultCalls.push({ hook, ref });
      vaultAs.push({
        hook,
        name: nameOf(ref),
        userId: hook === 'credentials:get' ? String(input['userId']) : ctx.userId,
      });
      trail.push(`vault:${hook.slice('credentials:'.length)} ${nameOf(ref)}`);
      const failure = vaultFailures.get(`${hook} ${ref}`) ?? vaultFailures.get(`${hook} ${nameOf(ref)}`);
      if (failure !== undefined) throw failure;
      return run(input);
    });
  };
  vaultHook('credentials:set', (i) => {
    vault.set(String(i['ref']), new TextDecoder().decode(i['payload'] as Uint8Array));
  });
  vaultHook('credentials:get', (i) => {
    const value = vault.get(String(i['ref']));
    if (value === undefined) {
      throw new PluginError({ code: 'credential-not-found', plugin: '@ax/credentials', message: 'none' });
    }
    return value;
  });
  vaultHook('credentials:delete', (i) => {
    vault.delete(String(i['ref']));
  });

  return { vault, vaultCalls, vaultAs, vaultFailures };
}
