import type {
  AnthropicResponse,
  AnthropicResponseContentBlock,
} from './anthropic-schemas.js';

// Upstream `llm.call` is bulk-only, but claude-code CLI defaults to SSE streaming.
// We issue one bulk call and synthesize the event sequence the client expects.
export function synthesizeSseFrames(message: AnthropicResponse): string {
  const frames: string[] = [];

  frames.push(
    formatFrame('message_start', {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...message.usage,
          output_tokens: 0,
        },
      },
    }),
  );

  let index = 0;
  for (const block of message.content) {
    frames.push(
      formatFrame('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: startBlock(block),
      }),
    );
    frames.push(
      formatFrame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: blockDelta(block),
      }),
    );
    frames.push(
      formatFrame('content_block_stop', {
        type: 'content_block_stop',
        index,
      }),
    );
    index++;
  }

  frames.push(
    formatFrame('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: message.stop_sequence,
      },
      usage: { output_tokens: message.usage.output_tokens },
    }),
  );

  frames.push(
    formatFrame('message_stop', { type: 'message_stop' }),
  );

  return frames.join('');
}

function startBlock(
  block: AnthropicResponseContentBlock,
): AnthropicResponseContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: '' };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: {} };
    default: {
      const _exhaustive: never = block;
      throw new TypeError(
        `Unknown content block type: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function blockDelta(
  block: AnthropicResponseContentBlock,
): { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } {
  switch (block.type) {
    case 'text':
      return { type: 'text_delta', text: block.text };
    case 'tool_use':
      return {
        type: 'input_json_delta',
        partial_json: JSON.stringify(block.input ?? {}),
      };
    default: {
      const _exhaustive: never = block;
      throw new TypeError(
        `Unknown content block type: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

function formatFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
