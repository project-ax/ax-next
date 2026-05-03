import {
  type AgentContext,
  type HookBus,
  type LlmCallInput,
  type LlmCallOutput,
  type Plugin,
} from '@ax/core';
import { buildPrompt } from './prompt.js';
import { validateGeneratedTitle } from './validate.js';
import type {
  GetInput,
  GetOutput,
  SetTitleInput,
  SetTitleOutput,
} from './types.js';

const PLUGIN_NAME = '@ax/conversation-titles';
const PLUGIN_VERSION = '0.0.0';

// Cheapest current Claude. Title quality is consistently good at this size;
// no point burning a Sonnet's budget on an eight-word label.
const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_MAX_TOKENS = 32;
// A touch of variety so titles don't all converge to the same dull phrase
// across similar conversations, but mostly deterministic — a high-temperature
// title is a coin flip and we'd rather it be readable.
const TITLE_TEMPERATURE = 0.3;

/**
 * `chat:turn-end` payload shape. The bus delivers whatever the publisher
 * fired; we only care about `role`. Other fields (contentBlocks, reqId,
 * reason) may be present but are unused here — we re-read the canonical
 * transcript via `conversations:get`.
 */
interface TurnEndPayload {
  role?: 'user' | 'assistant' | 'tool';
  contentBlocks?: unknown[];
  reqId?: string;
  reason?: string;
}

/**
 * Build the `@ax/conversation-titles` plugin. Subscribes to `chat:turn-end`,
 * fires the title-LLM call after the first assistant turn lands on a
 * still-untitled conversation, and persists the validated result via
 * `conversations:set-title`.
 *
 * Idempotency / re-delivery safety: we use `ifNull: true` on the set-title
 * call so a slow LLM round-trip can never clobber a user-driven rename.
 * At-least-once subscriber delivery is therefore safe.
 */
export function createConversationTitlesPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [],
      calls: ['llm:call', 'conversations:get', 'conversations:set-title'],
      subscribes: ['chat:turn-end'],
    },
    async init({ bus }) {
      bus.subscribe<TurnEndPayload>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          // Subscriber posture: NEVER throw. The bus already swallows + logs
          // subscriber errors, but doing it here too keeps the warning under
          // a stable log key and pins the plugin name in the entry rather
          // than letting the bus's generic `hook_subscriber_failed` swallow
          // the context.
          try {
            await handleTurnEnd(bus, ctx, payload);
          } catch (err) {
            ctx.logger.warn('conversation_titles_subscriber_failed', {
              err: err instanceof Error ? err : new Error(String(err)),
              ...(ctx.conversationId !== undefined
                ? { conversationId: ctx.conversationId }
                : {}),
            });
          }
          return undefined;
        },
      );
    },
  };
}

async function handleTurnEnd(
  bus: HookBus,
  ctx: AgentContext,
  payload: TurnEndPayload,
): Promise<void> {
  // Title fires only on the assistant's reply. User and tool turns are
  // signal-poor for a one-line summary, and waiting for the assistant
  // means the transcript already has the user prompt to summarize.
  if (payload.role !== 'assistant') return;
  if (ctx.conversationId === undefined) return;

  // Read the canonical transcript + check for an existing title. A
  // separate read here (rather than relying on the payload) gives us
  // the user's prompt + every prior turn, which the title model needs
  // for context.
  const conv = await bus.call<GetInput, GetOutput>(
    'conversations:get',
    ctx,
    {
      conversationId: ctx.conversationId,
      userId: ctx.userId,
    },
  );
  if (conv.conversation.title !== null) return;
  if (conv.turns.length === 0) return;

  // Only auto-title on the first assistant turn. If that attempt was lost
  // (LLM error, validation rejected the output), we deliberately don't
  // retry on later turns — the design says "after the first assistant
  // turn", and re-firing per turn would mean later titles summarize a
  // different transcript than the design specifies (and would expand
  // LLM spend silently). Manual retitling is a future feature.
  const assistantTurnCount = conv.turns.filter(
    (t) => t.role === 'assistant',
  ).length;
  if (assistantTurnCount !== 1) return;

  const prompt = buildPrompt(conv.turns);
  const llmOut = await bus.call<LlmCallInput, LlmCallOutput>(
    'llm:call',
    ctx,
    {
      model: TITLE_MODEL,
      maxTokens: TITLE_MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      temperature: TITLE_TEMPERATURE,
    },
  );

  const title = validateGeneratedTitle(llmOut.text);
  if (title === null) {
    // The model gave us a useless title (empty / "Untitled" / pure
    // whitespace). Leave the row's title NULL — better than writing
    // garbage. Logged at debug because this is expected to happen
    // occasionally on signal-poor first turns and isn't actionable.
    // SECURITY: `llmOut.text` is untrusted model-generated content
    // (CLAUDE.md invariant 5). Logging it would violate this plugin's
    // SECURITY.md ("we don't log prompt-derived text") and could
    // surface user content in operator-visible logs. The length is a
    // useful signal (very long = model misbehaving) without leaking
    // content.
    ctx.logger.debug('conversation_titles_validation_skipped', {
      conversationId: ctx.conversationId,
      rawLength: llmOut.text.length,
    });
    return;
  }

  const result = await bus.call<SetTitleInput, SetTitleOutput>(
    'conversations:set-title',
    ctx,
    {
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      title,
      ifNull: true,
    },
  );
  if (!result.updated) {
    // Race: a concurrent caller (probably a user-driven rename, possibly
    // a duplicate subscriber delivery) titled the row first. Our `ifNull`
    // guard caught it; nothing to do.
    ctx.logger.debug('conversation_titles_already_set', {
      conversationId: ctx.conversationId,
    });
  }
}
