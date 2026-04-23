import Anthropic from '@anthropic-ai/sdk';
import {
  PluginError,
  type ChatContext,
  type LlmRequest,
  type LlmResponse,
  type Plugin,
} from '@ax/core';
import { fromAnthropicMessage, toAnthropicMessages } from './mapping.js';

const PLUGIN_NAME = '@ax/llm-anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicPluginConfig {
  model?: string;
  maxTokens?: number;
  /** Test-only hook. Production code paths construct the real SDK. */
  client?: Pick<Anthropic, 'messages'>;
}

export function llmAnthropicPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['llm:call'],
      calls: [],
      subscribes: [],
    },
    init({ bus, config }) {
      const cfg = (config as AnthropicPluginConfig | undefined) ?? {};
      // Check cfg.client first so tests that inject a stub never touch env.
      const client: Pick<Anthropic, 'messages'> =
        cfg.client ?? new Anthropic({ apiKey: requireApiKey() });
      const model = cfg.model ?? DEFAULT_MODEL;
      const maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;

      bus.registerService<LlmRequest, LlmResponse>(
        'llm:call',
        PLUGIN_NAME,
        async (_ctx: ChatContext, input) => call(client, model, maxTokens, input),
      );
    },
  };
}

function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.length === 0) {
    throw new PluginError({
      code: 'init-failed',
      plugin: PLUGIN_NAME,
      message: 'ANTHROPIC_API_KEY env var not set',
    });
  }
  return key;
}

async function call(
  client: Pick<Anthropic, 'messages'>,
  model: string,
  maxTokens: number,
  input: LlmRequest,
): Promise<LlmResponse> {
  const { system, messages } = toAnthropicMessages(input.messages);
  try {
    // TODO(llm-tool-schemas): Forward tools to the Anthropic API once ToolDescriptor
    // gains an input_schema field. Without real schemas the model cannot call tools
    // correctly, so we don't forward them — better to have no tool-calling than
    // silently broken tool-calling. Lands in a follow-up PR.
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(system !== undefined ? { system } : {}),
      messages,
    });
    return fromAnthropicMessage(resp);
  } catch (err) {
    // Do NOT forward SDK error details — response bodies and headers may echo
    // the API key or request contents. Attach `cause` for debugging (kept out
    // of toJSON() by PluginError), but surface a generic message.
    throw new PluginError({
      code: 'unknown',
      plugin: PLUGIN_NAME,
      hookName: 'llm:call',
      message: 'anthropic API error',
      cause: err,
    });
  }
}
