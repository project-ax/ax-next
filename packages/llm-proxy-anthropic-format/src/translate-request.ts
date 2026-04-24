import type { LlmCallRequest, ChatMessage, ToolDescriptor } from '@ax/ipc-protocol';
import {
  AnthropicRequestSchema,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicToolResultBlock,
} from './anthropic-schemas.js';

export class TranslationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'TranslationError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function translateAnthropicRequest(raw: unknown): LlmCallRequest {
  const parsed = AnthropicRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TranslationError(
      `Anthropic request did not match the expected shape: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const req = parsed.data;

  const messages: ChatMessage[] = [];
  if (typeof req.system === 'string' && req.system.length > 0) {
    messages.push({ role: 'system', content: req.system });
  }
  for (const m of req.messages) {
    messages.push(flattenMessage(m));
  }

  const out: LlmCallRequest = {
    messages,
    model: req.model,
    maxTokens: req.max_tokens,
  };
  if (typeof req.temperature === 'number') {
    out.temperature = req.temperature;
  }
  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map(
      (t): ToolDescriptor => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.input_schema,
        // Sentinel: the proxy forwards the LLM-visible catalog verbatim and
        // cannot know where each tool actually runs. The sandbox-side
        // dispatcher decides sandbox-vs-host at execution time based on
        // whether a local impl is registered.
        executesIn: 'host',
      }),
    );
  }
  return out;
}

function flattenMessage(m: AnthropicMessage): ChatMessage {
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content };
  }
  const parts: string[] = [];
  for (const block of m.content) {
    const rendered = renderBlock(block);
    if (rendered !== undefined) parts.push(rendered);
  }
  return { role: m.role, content: parts.join('\n') };
}

function renderBlock(block: AnthropicContentBlock): string | undefined {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_use':
      return `[tool_use ${block.name}] ${JSON.stringify(block.input ?? {})}`;
    case 'tool_result':
      return `[tool_result ${block.tool_use_id}] ${renderToolResultContent(block)}`;
    case 'image':
      // Dropped silently; the HTTP listener will add warn-logging once it
      // has access to a logger. Image ingestion is Week 13+ work.
      return undefined;
    default:
      return undefined;
  }
}

function renderToolResultContent(block: AnthropicToolResultBlock): string {
  if (typeof block.content === 'string') return block.content;
  const parts: string[] = [];
  for (const inner of block.content) {
    if (inner.type === 'text') parts.push(inner.text);
  }
  return parts.join('\n');
}
