import {
  HookBus,
  makeChatContext,
  bootstrap,
  type ChatContext,
  type Plugin,
  type ServiceHandler,
} from '@ax/core';

export interface TestHarness {
  bus: HookBus;
  ctx(overrides?: Partial<Parameters<typeof makeChatContext>[0]>): ChatContext;
  /**
   * Drain plugin resources held by this harness. Calls each plugin's
   * optional `shutdown()` in reverse load order (mirrors what a future
   * kernel-shutdown lifecycle will do for SIGTERM). Per-plugin failures
   * are logged but never block other shutdowns. Per-plugin timeout
   * defaults to 10 s; pass `{ timeoutMs }` to override.
   *
   * Idempotent: calling `close()` twice on the same harness no-ops the
   * second call. Plugins without `shutdown` are skipped silently.
   *
   * Tests that boot plugins with long-lived resources (HTTP listeners,
   * postgres pools, timers) should call this in `afterEach` so vitest
   * watch mode + parallel-test runs don't accumulate them.
   */
  close(opts?: CloseOptions): Promise<void>;
}

export interface CloseOptions {
  /** Per-plugin timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /**
   * Optional sink for shutdown errors. Defaults to writing to
   * `process.stderr`. Pass a no-op to silence in tests where you're
   * exercising failure paths.
   */
  onError?: (pluginName: string, err: unknown) => void;
}

export interface CreateTestHarnessOptions {
  services?: Record<string, ServiceHandler>;
  plugins?: Plugin[];
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// createTestHarness
//
// Spins up a bare bus + ctx factory, optionally with service-hook mocks and
// real plugins booted through `bootstrap`. The returned `close()` drains
// plugin-held resources in reverse load order — see TestHarness above.
//
// The Week 1-2 `withChatLoop` option is GONE — chat:run is no longer a
// kernel primitive. Tests that want chat:run construct
// `@ax/chat-orchestrator` explicitly and pass it via `plugins:`.
// ---------------------------------------------------------------------------

export async function createTestHarness(
  opts: CreateTestHarnessOptions = {},
): Promise<TestHarness> {
  const bus = new HookBus();

  if (opts.services) {
    for (const [hook, handler] of Object.entries(opts.services)) {
      if (!bus.hasService(hook)) {
        bus.registerService(hook, 'mock', handler);
      }
    }
  }

  // Track the plugin list so close() can shut down in reverse order. We
  // capture the input order, NOT bootstrap's resolved topological order,
  // because bootstrap doesn't surface its order. Reverse-of-input is good
  // enough for tests; the production kernel-shutdown lifecycle (followups
  // doc #3) will use the canonical reverse-topological order.
  const plugins = opts.plugins ?? [];
  if (plugins.length > 0) {
    await bootstrap({ bus, plugins, config: {} });
  }

  let closed = false;

  return {
    bus,
    ctx(overrides) {
      return makeChatContext({
        sessionId: 'test-session',
        agentId: 'test-agent',
        userId: 'test-user',
        ...overrides,
      });
    },
    async close(closeOpts: CloseOptions = {}) {
      if (closed) return;
      closed = true;
      const timeoutMs = closeOpts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      const onError =
        closeOpts.onError ??
        ((name: string, err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `test-harness: plugin '${name}' shutdown failed: ${msg}\n`,
          );
        });

      // Reverse load order: a plugin that depends on another's resources
      // should shut down first. Same posture the production kernel-
      // shutdown slice will adopt for SIGTERM.
      for (let i = plugins.length - 1; i >= 0; i--) {
        const p = plugins[i]!;
        if (typeof p.shutdown !== 'function') continue;
        try {
          await withTimeout(
            Promise.resolve(p.shutdown()),
            timeoutMs,
            `plugin '${p.manifest.name}' shutdown exceeded ${timeoutMs}ms`,
          );
        } catch (err) {
          onError(p.manifest.name, err);
        }
      }
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    // Don't keep the event loop alive on the timer alone — if the test
    // process is otherwise idle, vitest can exit cleanly.
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
