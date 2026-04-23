import { z } from 'zod';

export interface SandboxSpawnInput {
  // Fixed argv; argv[0] is the binary, rest are arguments. No shell expansion —
  // the host MUST NOT pass shell: true semantics through this hook.
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface SandboxSpawnResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
  readonly timedOut: boolean;
}

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
