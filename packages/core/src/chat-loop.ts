import type { HookBus } from './hook-bus.js';
import type { ChatContext } from './context.js';
import type {
  ChatMessage,
  ChatOutcome,
  LlmRequest,
  LlmResponse,
  ToolCall,
} from './types.js';
import { PluginError } from './errors.js';

interface ChatRunInput {
  message: ChatMessage;
}

export function registerChatLoop(bus: HookBus): void {
  bus.registerService<ChatRunInput, ChatOutcome>(
    'chat:run',
    'core',
    async (ctx, { message }) => runChat(bus, ctx, message),
  );
}

async function runChat(
  bus: HookBus,
  ctx: ChatContext,
  message: ChatMessage,
): Promise<ChatOutcome> {
  const startResult = await bus.fire('chat:start', ctx, { message });
  if (startResult.rejected) {
    const outcome: ChatOutcome = {
      kind: 'terminated',
      reason: `chat:start:${startResult.reason}`,
    };
    await bus.fire('chat:end', ctx, { outcome });
    return outcome;
  }

  const messages: ChatMessage[] = [message];

  try {
    while (true) {
      const pre = await bus.fire<LlmRequest>('llm:pre-call', ctx, {
        messages: [...messages],
      });
      if (pre.rejected) {
        return await terminate(bus, ctx, `llm:pre-call:${pre.reason}`);
      }

      const response = await bus.call<LlmRequest, LlmResponse>('llm:call', ctx, pre.payload);

      const post = await bus.fire<LlmResponse>('llm:post-call', ctx, response);
      if (post.rejected) {
        return await terminate(bus, ctx, `llm:post-call:${post.reason}`);
      }

      messages.push(post.payload.assistantMessage);
      if (post.payload.toolCalls.length === 0) break;

      for (const toolCall of post.payload.toolCalls) {
        const pre = await bus.fire<ToolCall>('tool:pre-call', ctx, toolCall);
        if (pre.rejected) {
          messages.push({
            role: 'user',
            content: `tool '${toolCall.name}' rejected: ${pre.reason}`,
          });
          continue;
        }
        let output: unknown;
        try {
          output = await bus.call('tool:execute', ctx, pre.payload);
        } catch (err) {
          if (err instanceof PluginError && err.code === 'no-service') {
            return await terminate(bus, ctx, `no-service:tool:execute`);
          }
          throw err;
        }
        const postTool = await bus.fire('tool:post-call', ctx, { toolCall, output });
        const finalOutput = postTool.rejected
          ? output
          : (postTool.payload as { output: unknown }).output;
        messages.push({
          role: 'user',
          content: `[tool ${toolCall.name}] ${JSON.stringify(finalOutput)}`,
        });
      }
    }

    const outcome: ChatOutcome = { kind: 'complete', messages };
    await bus.fire('chat:end', ctx, { outcome });
    return outcome;
  } catch (err) {
    const reason = classify(err);
    const outcome: ChatOutcome = { kind: 'terminated', reason, error: err };
    await bus.fire('chat:end', ctx, { outcome });
    return outcome;
  }
}

async function terminate(bus: HookBus, ctx: ChatContext, reason: string): Promise<ChatOutcome> {
  const outcome: ChatOutcome = { kind: 'terminated', reason };
  await bus.fire('chat:end', ctx, { outcome });
  return outcome;
}

function classify(err: unknown): string {
  if (err instanceof PluginError) {
    if (err.code === 'no-service') return `no-service:${extractServiceName(err.message)}`;
    return `plugin-error:${err.code}`;
  }
  return 'unknown';
}

function extractServiceName(message: string): string {
  const match = message.match(/'([^']+)'/);
  return match ? match[1]! : 'unknown';
}
