import type { SandboxSpawnInput, SandboxSpawnResult } from '@ax/core';

export async function spawnImpl(
  _ctx: unknown,
  _input: SandboxSpawnInput,
): Promise<SandboxSpawnResult> {
  throw new Error('not yet implemented'); // filled in Task 2.3
}
