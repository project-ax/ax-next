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
    llm: z.enum(['anthropic', 'mock']).default('mock'),
    sandbox: z.enum(['subprocess']).default('subprocess'),
    tools: z.array(z.enum(['bash', 'file-io'])).default(['bash', 'file-io']),
    storage: z.enum(['sqlite']).default('sqlite'),
    /**
     * Which agent-runner binary the sandbox spawns per chat turn. `native`
     * drives `@ax/agent-native-runner` (the mock/canary loop); `claude-sdk`
     * drives `@ax/agent-claude-sdk-runner` (real Anthropic agent SDK, routed
     * through the local LLM proxy).
     */
    runner: z.enum(['native', 'claude-sdk']).default('native'),
    anthropic: z
      .object({
        model: z.string().optional(),
        maxTokens: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();

export type AxConfigInput = z.input<typeof AxConfigSchema>;
export type AxConfig = z.output<typeof AxConfigSchema>;
