import Anthropic from '@anthropic-ai/sdk';
import {
  PluginError,
  type ChatContext,
  type LlmRequest,
  type LlmResponse,
  type Plugin,
  type ToolDescriptor,
} from '@ax/core';
import { fromAnthropicMessage, toAnthropicMessages, toAnthropicTools } from './mapping.js';

const PLUGIN_NAME = '@ax/llm-anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicPluginConfig {
  model?: string;
  maxTokens?: number;
  /**
   * Tool descriptors to forward to the model. The CLI populates this from
   * the loaded tool plugins; the Anthropic plugin maps each descriptor into
   * the SDK's `Tool` shape on every `messages.create` call.
   */
  tools?: ToolDescriptor[];
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
    async init({ bus, config }) {
      const cfg = (config as AnthropicPluginConfig | undefined) ?? {};
      const client = await resolveClient(cfg);
      const model = cfg.model ?? DEFAULT_MODEL;
      const maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
      const tools = cfg.tools && cfg.tools.length > 0 ? cfg.tools : undefined;

      bus.registerService<LlmRequest, LlmResponse>(
        'llm:call',
        PLUGIN_NAME,
        async (_ctx: ChatContext, input) => call(client, model, maxTokens, tools, input),
      );
    },
  };
}

async function resolveClient(
  cfg: AnthropicPluginConfig,
): Promise<Pick<Anthropic, 'messages'>> {
  // 1) In-process injection — used by unit tests that import the plugin directly.
  if (cfg.client) return cfg.client;

  // 2) Test-only env backdoor — lets an e2e spawn a real CLI subprocess and
  // still swap the SDK for a fixture. Requires already having process-exec
  // capability to set the env var, so this doesn't grant any new reach.
  // Documented in SECURITY.md. MUST NOT fire in production builds.
  const fixturePath = process.env.AX_TEST_ANTHROPIC_FIXTURE;
  if (fixturePath && fixturePath.length > 0) {
    const mod = (await import(fixturePath)) as {
      default?: Pick<Anthropic, 'messages'>;
      makeClient?: () => Pick<Anthropic, 'messages'>;
    };
    const client = mod.default ?? mod.makeClient?.();
    if (!client) {
      throw new PluginError({
        code: 'init-failed',
        plugin: PLUGIN_NAME,
        message: `AX_TEST_ANTHROPIC_FIXTURE module has no default or makeClient export: ${fixturePath}`,
      });
    }
    return client;
  }

  // 3) Real SDK.
  return new Anthropic({ apiKey: requireApiKey() });
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
  tools: ToolDescriptor[] | undefined,
  input: LlmRequest,
): Promise<LlmResponse> {
  const { system, messages } = toAnthropicMessages(input.messages);
  const anthropicTools = tools !== undefined ? toAnthropicTools(tools) : undefined;
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(system !== undefined ? { system } : {}),
      ...(anthropicTools !== undefined ? { tools: anthropicTools } : {}),
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
