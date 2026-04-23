import { z } from 'zod';

export const BashInputSchema = z.object({
  command: z.string().min(1).max(16_384),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});
export type BashInput = z.infer<typeof BashInputSchema>;

export interface BashResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
}
