import { z } from 'zod';

const EnvKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env keys must be A-Z / 0-9 / _ and start with A-Z or _');

export const SandboxSpawnInputSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().regex(/^\//, 'cwd must be absolute'),
  env: z.record(EnvKey, z.string()),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  maxStdoutBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1_048_576),
  maxStderrBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1_048_576),
});

export type SandboxSpawnInput = z.infer<typeof SandboxSpawnInputSchema>;

export const SandboxSpawnResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }),
  timedOut: z.boolean(),
});

export type SandboxSpawnResult = z.infer<typeof SandboxSpawnResultSchema>;
