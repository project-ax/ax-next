import { PluginError, type ChatContext, type HookBus, type Plugin, type ToolCall } from '@ax/core';

const PLUGIN_NAME = '@ax/tool-dispatcher';

export function toolDispatcherPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool:execute'],
      // Sub-service names (tool:execute:<name>) are chosen at call time from the
      // model's ToolCall.name, so they can't be statically declared for verifyCalls.
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<ToolCall, unknown>(
        'tool:execute',
        PLUGIN_NAME,
        async (ctx: ChatContext, input: ToolCall) => dispatch(bus, ctx, input),
      );
    },
  };
}

async function dispatch(bus: HookBus, ctx: ChatContext, input: ToolCall): Promise<unknown> {
  const subService = `tool:execute:${input.name}`;
  if (!bus.hasService(subService)) {
    throw new PluginError({
      code: 'no-service',
      plugin: PLUGIN_NAME,
      hookName: subService,
      message: `no tool plugin registers '${subService}'`,
    });
  }
  return bus.call(subService, ctx, input.input);
}
