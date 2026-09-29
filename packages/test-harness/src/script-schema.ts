import { z } from 'zod';

const ToolCallEntrySchema = z.object({
  kind: z.literal('tool-call'),
  name: z.string().min(1),
  input: z.unknown(),
  executesIn: z.enum(['host', 'sandbox']),
  expectPostCall: z.boolean(),
});

const AssistantTextEntrySchema = z.object({
  kind: z.literal('assistant-text'),
  content: z.string(),
});

const FinishEntrySchema = z.object({
  kind: z.literal('finish'),
  reason: z.enum(['end_turn', 'tool_use']),
});

const TokenCount = z.number().int().nonnegative();

/**
 * Close an assistant turn the way the real runners do: POST `event.turn-end`
 * (role 'assistant', reason 'user-message-wait'). `usage` is what the turn
 * cost as a runner would report it; omit it to model a runner that cannot
 * tell (the host then charges a flat assumed cost). This is the path
 * per-user metering (@ax/usage-limits) rides: runner -> IPC -> chat:turn-end.
 */
const TurnEndEntrySchema = z.object({
  kind: z.literal('turn-end'),
  usage: z
    .object({
      model: z.string().min(1).optional(),
      inputTokens: TokenCount.optional(),
      outputTokens: TokenCount.optional(),
      cacheReadTokens: TokenCount.optional(),
      cacheWriteTokens: TokenCount.optional(),
    })
    .optional(),
});

const ScriptEntrySchema = z.discriminatedUnion('kind', [
  ToolCallEntrySchema,
  AssistantTextEntrySchema,
  TurnEndEntrySchema,
  FinishEntrySchema,
]);

export const StubRunnerScriptSchema = z.object({
  entries: z.array(ScriptEntrySchema).min(1),
});

export type StubRunnerScript = z.infer<typeof StubRunnerScriptSchema>;

export function encodeScript(script: StubRunnerScript): string {
  return Buffer.from(JSON.stringify(script), 'utf8').toString('base64');
}

export function decodeScript(encoded: string): StubRunnerScript {
  const json = Buffer.from(encoded, 'base64').toString('utf8');
  const raw: unknown = JSON.parse(json);
  return StubRunnerScriptSchema.parse(raw);
}
