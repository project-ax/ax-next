import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ToolCall, ToolDescriptor } from '@ax/core';

/**
 * Map ax `ToolDescriptor[]` to the shape Anthropic's Messages API expects on
 * `messages.create({ tools })`. `description` defaults to an empty string
 * because the SDK's `Tool` type requires it; `input_schema` is passed through
 * untyped (it's `unknown` in our descriptor — the JSON Schema is authored by
 * the tool plugin, not by us).
 */
export function toAnthropicTools(
  descriptors: ToolDescriptor[],
): Anthropic.Messages.Tool[] {
  return descriptors.map((d) => ({
    name: d.name,
    description: d.description ?? '',
    input_schema: d.inputSchema as Anthropic.Messages.Tool['input_schema'],
  }));
}

/**
 * Convert ax ChatMessage[] into the shape Anthropic's Messages API expects.
 *
 * - System messages are pulled out and concatenated (newline-joined) into a
 *   single `system` string. The Anthropic API carries the system prompt as a
 *   separate top-level field, not as a role in the messages array.
 * - Other messages are passed through with content as a plain string (the SDK
 *   accepts either a string or a content-block array; we use the string form).
 */
export function toAnthropicMessages(msgs: ChatMessage[]): {
  system: string | undefined;
  messages: { role: 'user' | 'assistant'; content: string }[];
} {
  const systemParts: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  for (const m of msgs) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n') : undefined,
    messages,
  };
}

/**
 * Convert an Anthropic `Messages.Message` response into our internal
 * `LlmResponse` shape.
 *
 * - Text blocks are concatenated into `assistantMessage.content`.
 * - `tool_use` blocks become `ToolCall[]`. `input` is passed through untyped
 *   (it's `unknown` in our type) — tool plugins do their own Zod validation.
 *   We do NOT interpolate or eval any field.
 */
export function fromAnthropicMessage(resp: Anthropic.Messages.Message): {
  assistantMessage: ChatMessage;
  toolCalls: ToolCall[];
} {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of resp.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
    // Other block types (thinking, server-tool-use, etc.) are ignored for now.
  }

  return {
    assistantMessage: { role: 'assistant', content: textParts.join('') },
    toolCalls,
  };
}
