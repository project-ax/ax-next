import type { LlmCallRequest, AgentMessage, ToolDescriptor } from '@ax/ipc-protocol';
import {
  AnthropicRequestSchema,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicToolResultBlock,
} from './anthropic-schemas.js';

// Reserved prefixes: native-runner emits '[tool ...]' for tool RESULTS; we emit '[tool_use ...]' and '[tool_result ...]' so all three forms remain unambiguous when rehydrated into history.
// A tool_result whose `is_error === true` is rendered as '[tool_result <id> error] ...' so the error signal survives the round-trip into history; absence of the `error` qualifier means success.
export const TOOL_USE_PREFIX = 'tool_use';
export const TOOL_RESULT_PREFIX = 'tool_result';

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

  const messages: AgentMessage[] = [];
  // `system` may be a plain string or an array of `{type:'text',text}` blocks
  // (the Anthropic API accepts both; the `claude` CLI uses the array form).
  // Flatten to a single `system` AgentMessage with the text joined by newlines.
  const systemText = flattenSystem(req.system);
  if (systemText.length > 0) {
    messages.push({ role: 'system', content: systemText });
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

function flattenSystem(
  system: string | Array<{ type: 'text'; text: string }> | undefined,
): string {
  if (system === undefined) return '';
  if (typeof system === 'string') return system;
  return system
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

function flattenMessage(m: AnthropicMessage): AgentMessage {
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content };
  }
  const parts: string[] = [];
  for (const block of m.content) {
    const rendered = renderBlock(block, m.role);
    if (rendered !== undefined) parts.push(rendered);
  }
  return { role: m.role, content: parts.join('\n') };
}

function renderBlock(
  block: AnthropicContentBlock,
  role: 'user' | 'assistant',
): string | undefined {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_use':
      if (role === 'user') {
        throw new TranslationError('user message may not contain tool_use block');
      }
      return `[${TOOL_USE_PREFIX} ${block.name}] ${JSON.stringify(block.input ?? {})}`;
    case 'tool_result': {
      if (role === 'assistant') {
        throw new TranslationError(
          'assistant message may not contain tool_result block',
        );
      }
      const qualifier = block.is_error === true ? ' error' : '';
      return `[${TOOL_RESULT_PREFIX} ${block.tool_use_id}${qualifier}] ${renderToolResultContent(block)}`;
    }
    case 'image':
      // Images dropped: ingestion is out of scope here.
      return undefined;
    default: {
      const _exhaustive: never = block;
      throw new TypeError(
        `Unknown content block type: ${JSON.stringify(_exhaustive)}`,
      );
    }
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
