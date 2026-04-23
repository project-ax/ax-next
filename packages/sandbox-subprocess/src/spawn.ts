import { PluginError, type ChatContext } from '@ax/core';
import {
  SandboxSpawnInputSchema,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
} from './types.js';

export const PLUGIN_NAME = '@ax/sandbox-subprocess';
export const HOOK_NAME = 'sandbox:spawn';

export async function spawnImpl(
  _ctx: ChatContext,
  input: SandboxSpawnInput,
): Promise<SandboxSpawnResult> {
  const parsed = SandboxSpawnInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      hookName: HOOK_NAME,
      message: `sandbox:spawn payload invalid: ${parsed.error.message}`,
      cause: parsed.error,
    });
  }
  // Actual subprocess implementation lands in Task 2.3.
  throw new PluginError({
    code: 'unknown',
    plugin: PLUGIN_NAME,
    hookName: HOOK_NAME,
    message: 'sandbox:spawn implementation pending',
  });
}
