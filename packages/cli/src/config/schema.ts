import { z } from 'zod';

/**
 * Schema for `ax.config.ts`. Kept `.strict()` on purpose — unknown top-level
 * keys are rejected, so typos get loud failures instead of silent no-ops.
 *
 * Callers (config-file authors) pass partial shapes and let defaults fill in.
 * Internal code works with the fully-defaulted output. Because `z.infer` only
 * gives the output shape (defaulted fields become required), we export both
 * `AxConfigInput` and `AxConfig`.
 */
export const AxConfigSchema = z
  .object({
    sandbox: z.enum(['subprocess']).default('subprocess'),
    storage: z.enum(['sqlite']).default('sqlite'),
  })
  .strict();

export type AxConfigInput = z.input<typeof AxConfigSchema>;
export type AxConfig = z.output<typeof AxConfigSchema>;
