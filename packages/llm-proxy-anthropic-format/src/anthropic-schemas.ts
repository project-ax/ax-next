import { z } from 'zod';

export const AnthropicTextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

export const AnthropicImageBlockSchema = z
  .object({
    type: z.literal('image'),
    source: z
      .object({
        type: z.string(),
        media_type: z.string().optional(),
        data: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const AnthropicToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

export const AnthropicToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([
      z.string(),
      z.array(
        z.union([AnthropicTextBlockSchema, AnthropicImageBlockSchema]),
      ),
    ]),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const AnthropicContentBlockSchema = z.discriminatedUnion('type', [
  AnthropicTextBlockSchema,
  AnthropicImageBlockSchema,
  AnthropicToolUseBlockSchema,
  AnthropicToolResultBlockSchema,
]);

export const AnthropicMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(AnthropicContentBlockSchema)]),
  })
  .passthrough();

export const AnthropicToolSpecSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()),
  })
  .passthrough();

export const AnthropicRequestSchema = z
  .object({
    model: z.string(),
    max_tokens: z.number().int().positive(),
    system: z.string().optional(),
    messages: z.array(AnthropicMessageSchema),
    tools: z.array(AnthropicToolSpecSchema).optional(),
    temperature: z.number().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

export type AnthropicTextBlock = z.infer<typeof AnthropicTextBlockSchema>;
export type AnthropicImageBlock = z.infer<typeof AnthropicImageBlockSchema>;
export type AnthropicToolUseBlock = z.infer<typeof AnthropicToolUseBlockSchema>;
export type AnthropicToolResultBlock = z.infer<
  typeof AnthropicToolResultBlockSchema
>;
export type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>;
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;
export type AnthropicToolSpec = z.infer<typeof AnthropicToolSpecSchema>;
export type AnthropicRequest = z.infer<typeof AnthropicRequestSchema>;

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export type AnthropicStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | null;

export type AnthropicResponseContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  stop_reason: AnthropicStopReason;
  stop_sequence: string | null;
  content: AnthropicResponseContentBlock[];
  usage: AnthropicUsage;
}
