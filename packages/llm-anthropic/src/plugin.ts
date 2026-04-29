import Anthropic from '@anthropic-ai/sdk';
import {
  PluginError,
  type Plugin,
  type LlmRequest,
  type LlmResponse,
  type AgentMessage,
  type ToolCall,
} from '@ax/core';

const PLUGIN_NAME = '@ax/llm-anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;
const TRANSIENT_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Minimal structural interface for the Anthropic SDK client. Only the one
 * method we actually call. Keeping it narrow here means the tests can hand us
 * a plain object without needing to instantiate the real SDK.
 */
interface AnthropicClient {
  messages: {
    create(req: Record<string, unknown>): Promise<unknown>;
  };
}

export interface LlmAnthropicConfig {
  model?: string;
  maxTokens?: number;
  /**
   * Test-seam ONLY. Production callers should leave this undefined so we
   * construct the real SDK client. The existence of this factory is the
   * invariant-I5 hatch — we do NOT reach for environment variables to choose
   * a mock at runtime.
   */
  clientFactory?: (apiKey: string) => AnthropicClient;
  /**
   * Override the single-retry backoff. Exists primarily so test suites don't
   * wait a full second in the 5xx-retry path. Production callers should
   * leave this undefined to get the 1 s default.
   */
  retryDelayMs?: number;
}

export function createLlmAnthropicPlugin(cfg: LlmAnthropicConfig = {}): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['llm:call'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new PluginError({
          code: 'init-failed',
          plugin: PLUGIN_NAME,
          hookName: 'init',
          message: 'ANTHROPIC_API_KEY not set',
        });
      }
      const client = cfg.clientFactory
        ? cfg.clientFactory(apiKey)
        : (new Anthropic({ apiKey }) as unknown as AnthropicClient);

      bus.registerService<LlmRequest, LlmResponse>(
        'llm:call',
        PLUGIN_NAME,
        async (_ctx, input) => callWithRetry(client, input, cfg, apiKey),
      );
    },
  };
}

async function callWithRetry(
  client: AnthropicClient,
  input: LlmRequest,
  cfg: LlmAnthropicConfig,
  apiKey: string,
): Promise<LlmResponse> {
  const req = toAnthropicRequest(input, cfg);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.messages.create(req);
      return fromAnthropicResponse(res);
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isTransient(e)) {
        await sleep(cfg.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw new PluginError({
        code: 'unknown',
        plugin: PLUGIN_NAME,
        hookName: 'llm:call',
        message: redact(extractMessage(e), apiKey),
        cause: e,
      });
    }
  }
  // Unreachable in practice — the loop either returns or throws. This guard
  // exists only for type-flow, and it re-wraps the last seen error so the
  // redaction still runs.
  throw new PluginError({
    code: 'unknown',
    plugin: PLUGIN_NAME,
    hookName: 'llm:call',
    message: redact(extractMessage(lastErr) || 'retry loop exhausted without resolution', apiKey),
  });
}

function extractMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'unknown error';
}

function isTransient(e: unknown): boolean {
  const maybe = e as { status?: unknown; response?: { status?: unknown } } | null;
  const status =
    (typeof maybe?.status === 'number' ? maybe.status : undefined) ??
    (typeof maybe?.response?.status === 'number' ? maybe.response.status : undefined);
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

function redact(message: string, apiKey: string): string {
  if (!apiKey) return message;
  // split/join replaces every occurrence without regex escaping concerns.
  return message.split(apiKey).join('<redacted>');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toAnthropicRequest(
  input: LlmRequest,
  cfg: LlmAnthropicConfig,
): Record<string, unknown> {
  // The Anthropic Messages API models system prompts as a top-level `system`
  // string, NOT as a message with role:'system'. Mapping them to role:'user'
  // would silently downgrade a system instruction into a user turn, degrading
  // model behavior. Extract all role:'system' entries and concatenate them
  // (matches the behavior of sending multiple system-level instructions).
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of input.messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    });
  }
  return {
    model: cfg.model ?? DEFAULT_MODEL,
    max_tokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    ...(input.tools && input.tools.length > 0
      ? {
          tools: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
        }
      : {}),
  };
}

function fromAnthropicResponse(res: unknown): LlmResponse {
  const blocks = ((res as { content?: unknown[] })?.content ?? []) as unknown[];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    const type = (b as { type?: string })?.type;
    if (type === 'text') {
      textParts.push((b as { text?: string }).text ?? '');
    } else if (type === 'tool_use') {
      const tu = b as { id?: string; name?: string; input?: unknown };
      if (typeof tu.id === 'string' && typeof tu.name === 'string') {
        toolCalls.push({ id: tu.id, name: tu.name, input: tu.input ?? {} });
      }
    }
  }
  const assistantMessage: AgentMessage = {
    role: 'assistant',
    content: textParts.join('\n'),
  };
  return { assistantMessage, toolCalls };
}
