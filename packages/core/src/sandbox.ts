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

// Caller-side shape: defaulted fields (timeoutMs, maxStdoutBytes,
// maxStderrBytes) are OPTIONAL here because zod will fill them in at parse
// time. Consumers that hand a request to bus.call('sandbox:spawn', ...)
// use this type.
export type SandboxSpawnInput = z.input<typeof SandboxSpawnInputSchema>;

// Post-parse shape: every defaulted field is resolved. Providers that
// receive a pre-parsed request (i.e. after SandboxSpawnInputSchema.parse)
// use this type so their field accesses don't need optional-chaining.
export type SandboxSpawnParsed = z.output<typeof SandboxSpawnInputSchema>;

export const SandboxSpawnResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }),
  timedOut: z.boolean(),
});

export type SandboxSpawnResult = z.infer<typeof SandboxSpawnResultSchema>;
