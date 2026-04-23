import { z } from 'zod';

export const AxConfigSchema = z.object({
  llm: z.enum(['anthropic', 'mock']).default('mock'),
  sandbox: z.enum(['subprocess']).default('subprocess'),
  tools: z.array(z.enum(['bash', 'file-io'])).default(['bash', 'file-io']),
  storage: z.enum(['sqlite']).default('sqlite'),
  anthropic: z
    .object({
      model: z.string().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
  storageSqlite: z
    .object({
      databasePath: z.string().optional(),
    })
    .optional(),
});

export type AxConfig = z.infer<typeof AxConfigSchema>;
