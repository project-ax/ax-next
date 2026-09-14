import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, PluginError, bootstrap, type Plugin } from '@ax/core';
import { createMemoryStrataPlugin, DEFAULT_MEMORY_OPS_MODEL } from '../plugin.js';
import { isMissingCredential, memoryFailureEvent, NO_CREDENTIAL_EVENT } from '../llm-failure.js';

/**
 * A host that cannot reach its memory provider must fail LOUDLY, and there are
 * two different "cannot reach" cases with two different right answers.
 *
 * 1. No provider plugin at all. Static, knowable before a single turn runs, so
 *    it fails at BOOT — the kernel refuses a declared `calls` entry that
 *    nothing registers.
 * 2. Provider present, no credential resolved. Only knowable per call, because
 *    keys resolve per user and one stored in the credentials UI has to start
 *    working without a redeploy. So the turn survives and the log carries it —
 *    but under its own event, at its own volume, not buried in the transient
 *    warns it used to look identical to.
 */
describe('missing memory provider fails at boot', () => {
  const memoryOpsProvider = DEFAULT_MEMORY_OPS_MODEL.slice(0, DEFAULT_MEMORY_OPS_MODEL.indexOf('/'));

  /**
   * Satisfies every OTHER hard dependency memory-strata declares, so the only
   * thing missing from the graph is the provider under test. Graph validation
   * reads plugin MANIFESTS, not runtime bus registrations — a stub registered
   * on the bus is invisible to it.
   */
  function supportingPlugins(extraHooks: string[] = []): Plugin[] {
    const registers = [
      'agents:resolve',
      'memory:index:upsert',
      'memory:index:delete',
      'tool:register',
      ...extraHooks,
    ];
    return registers.map((hook) => ({
      manifest: { name: `stub-${hook}`, version: '0.0.0', registers: [hook], calls: [], subscribes: [] },
      init({ bus }: { bus: HookBus }) {
        bus.registerService(hook, `stub-${hook}`, async () => ({}) as never);
      },
    }));
  }

  it('refuses to boot when nothing registers the memory-ops provider hook', async () => {
    const bus = new HookBus();
    await expect(
      bootstrap({ bus, plugins: [...supportingPlugins(), createMemoryStrataPlugin()], config: {} }),
    ).rejects.toThrow(new RegExp(`llm:call:${memoryOpsProvider}`));
  });

  it('names the missing hook when memoryOpsModel points at a provider nobody registers', async () => {
    // The case a runtime-only `bus.hasService` guard would miss: the operator
    // moved the memory role to a provider this host does not load, and every
    // turn's extraction would be skipped with nothing but a warn.
    const bus = new HookBus();
    await expect(
      bootstrap({
        bus,
        plugins: [
          // The fixed-tier hook IS registered here, so the ONLY gap is the
          // memory-ops provider — otherwise this passes for the wrong reason,
          // failing on llmCallHook and never exercising the new declaration.
          ...supportingPlugins([`llm:call:${memoryOpsProvider}`]),
          createMemoryStrataPlugin({ memoryOpsModel: 'nobody-loads-this/some-model' }),
        ],
        config: {},
      }),
    ).rejects.toThrow(/llm:call:nobody-loads-this/);
  });

  it('rejects an unparseable memoryOpsModel at construction, not per turn', async () => {
    // No turn at which a malformed ref starts working, so there is no reason to
    // discover it one turn at a time.
    expect(() => createMemoryStrataPlugin({ memoryOpsModel: 'bare-id-no-provider' })).toThrow();
  });
});

describe('missing credential is loud, and distinct from transient failure', () => {
  it('classifies a provider no-credential error', () => {
    const err = new PluginError({
      code: 'no-openrouter-credential',
      plugin: '@ax/llm-openrouter',
      message: 'no key',
    });
    expect(isMissingCredential(err)).toBe(true);
  });

  it('matches any provider by code SHAPE, so a new provider needs no edit here', () => {
    const err = new PluginError({ code: 'no-acme-credential', plugin: '@ax/llm-acme', message: 'x' });
    expect(isMissingCredential(err)).toBe(true);
  });

  it('does NOT classify the transient failures that share these catch blocks', () => {
    expect(isMissingCredential(new Error('socket hang up'))).toBe(false);
    expect(
      isMissingCredential(
        new PluginError({ code: 'upstream-5xx', plugin: '@ax/llm-openrouter', message: '503' }),
      ),
    ).toBe(false);
    // The near-miss worth pinning: a credential error for something that is not
    // a credential miss must not be swept into the loud bucket.
    expect(
      isMissingCredential(
        new PluginError({ code: 'credential-expired', plugin: '@ax/llm-openrouter', message: 'x' }),
      ),
    ).toBe(false);
  });

  it('routes the credential case to its own event and leaves everything else alone', () => {
    const cred = new PluginError({ code: 'no-openrouter-credential', plugin: 'p', message: 'x' });
    expect(memoryFailureEvent(cred, 'memory_strata_map_densify_failed')).toBe(NO_CREDENTIAL_EVENT);
    expect(memoryFailureEvent(new Error('timeout'), 'memory_strata_map_densify_failed')).toBe(
      'memory_strata_map_densify_failed',
    );
  });
});

describe('observer path logs a missing credential at error', () => {
  it('emits the credential event at error level, not a generic warn', async () => {
    const bus = new HookBus();
    const provider = `llm:call:${DEFAULT_MEMORY_OPS_MODEL.slice(0, DEFAULT_MEMORY_OPS_MODEL.indexOf('/'))}`;
    bus.registerService(provider, 'stub-provider', async () => {
      throw new PluginError({
        code: 'no-openrouter-credential',
        plugin: '@ax/llm-openrouter',
        message: 'no key resolved',
      });
    });
    bus.registerService('agents:resolve', 'stub-agents', async () => ({
      agent: { model: 'anthropic/claude-sonnet-4-6' },
    }));
    bus.registerService('tool:register', 'stub-tools', async () => ({ ok: true as const }));

    let settle: ((agentId: string) => Promise<void>) | undefined;
    const plugin = createMemoryStrataPlugin({
      consolidatorDebounceMs: 600_000,
      testHooks: { onObserverSettleReady(s) { settle = s; } },
    });
    await plugin.init({ bus, config: {} });

    const ctx = makeAgentContext({
      sessionId: 's', agentId: 'a', userId: 'u',
      workspace: { rootPath: process.cwd() },
    });
    const error = vi.spyOn(ctx.logger, 'error');
    const warn = vi.spyOn(ctx.logger, 'warn');

    await bus.fire('chat:end', ctx, {
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'I prefer React.' },
          { role: 'assistant', content: 'Noted.' },
        ],
      },
    });
    await settle!(ctx.agentId);

    expect(error).toHaveBeenCalledWith(NO_CREDENTIAL_EVENT, expect.objectContaining({ path: 'observer' }));
    expect(warn).not.toHaveBeenCalledWith('memory_strata_observer_failed', expect.anything());
  });
});
