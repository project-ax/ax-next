import { z } from 'zod';

// Payload types live in @ax/core (shared hook contract). Re-exported here
// for intra-package convenience; external consumers should import them from
// @ax/core so the no-cross-plugin-imports lint invariant (#2) is respected.
export type { SandboxSpawnInput, SandboxSpawnResult } from '@ax/core';

export const SandboxSpawnInputSchema = z.object({
  argv: z
    .array(z.string())
    .min(1, { message: 'argv must be non-empty; argv[0] is the binary' }),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  maxStdoutBytes: z.number().int().positive().optional(),
  maxStderrBytes: z.number().int().positive().optional(),
});
