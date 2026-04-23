import {
  PluginError,
  type ChatContext,
  type HookBus,
  type Plugin,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
  type ToolDescriptor,
} from '@ax/core';
import { BashInputSchema, type BashResult } from './types.js';

const PLUGIN_NAME = '@ax/tool-bash';
const HOOK_NAME = 'tool:execute:bash';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Published descriptor for the `bash` tool. The JSON Schema mirrors
 * `BashInputSchema` (Zod) — keep them in sync.
 */
export const bashToolDescriptor: ToolDescriptor = {
  name: 'bash',
  description:
    'Run a shell command via /bin/bash -c in the workspace. Returns stdout, stderr, exit code, and whether output was truncated or the command timed out.',
  inputSchema: {
    type: 'object',
    required: ['command'],
    additionalProperties: false,
    properties: {
      command: {
        type: 'string',
        minLength: 1,
        maxLength: 16384,
        description: 'Shell command to execute.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: 300000,
        description: 'Optional timeout in milliseconds. Max 5 minutes.',
      },
    },
  },
};

export function toolBashPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [HOOK_NAME],
      calls: ['sandbox:spawn'],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<unknown, BashResult>(
        HOOK_NAME,
        PLUGIN_NAME,
        async (ctx, input) => execute(bus, ctx, input),
      );
    },
  };
}

async function execute(bus: HookBus, ctx: ChatContext, input: unknown): Promise<BashResult> {
  const parsed = BashInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `invalid bash input: ${parsed.error.message}`,
    });
  }
  const result = await bus.call<SandboxSpawnInput, SandboxSpawnResult>(
    'sandbox:spawn',
    ctx,
    {
      argv: ['/bin/bash', '-c', parsed.data.command],
      cwd: ctx.workspace.rootPath,
      env: {},
      timeoutMs: parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
  };
}
