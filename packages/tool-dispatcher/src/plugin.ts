import { PluginError, type Plugin, type ToolCall } from '@ax/core';

const PLUGIN_NAME = '@ax/tool-dispatcher';

// Tool names become hook-name suffixes (`tool:execute:${name}`). Restrict to a
// shape that cannot collide with other hook-name segments or reintroduce
// traversal-like tokens from upstream inputs. Belt-and-suspenders — the bus's
// hasService() lookup is a Map read, so an escape character here doesn't open
// a path today, but a future IPC-exposed path would.
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function createToolDispatcherPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool:execute'],
      // `calls` is intentionally empty: sub-services are resolved at dispatch
      // time via bus.hasService() because the set of registered tools is
      // configuration-driven, not a manifest-declared dependency. Documented
      // as the one exception to the "no half-wired plugins" invariant.
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<ToolCall, unknown>(
        'tool:execute',
        PLUGIN_NAME,
        async (ctx, input) => {
          const name = (input as { name?: unknown })?.name;
          if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
            throw new PluginError({
              code: 'invalid-payload',
              plugin: PLUGIN_NAME,
              hookName: 'tool:execute',
              message: `invalid tool name: ${JSON.stringify(name).slice(0, 64)}`,
            });
          }
          const sub = `tool:execute:${name}`;
          if (!bus.hasService(sub)) {
            throw new PluginError({
              code: 'no-service',
              plugin: PLUGIN_NAME,
              hookName: sub,
              message: `no tool plugin registers '${sub}'`,
            });
          }
          return bus.call(sub, ctx, (input as { input?: unknown }).input);
        },
      );
    },
  };
}
