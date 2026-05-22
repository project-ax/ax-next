import {
  PluginError,
  type AgentContext,
  type HookBus,
  type LlmCallInput,
  type LlmCallOutput,
  type Plugin,
} from '@ax/core';
import type { ContentBlock } from '@ax/ipc-protocol';
import { buildPrompt } from './prompt.js';
import { validateGeneratedTitle } from './validate.js';
import type {
  GetInput,
  GetOutput,
  SetTitleInput,
  SetTitleOutput,
  Turn,
} from './types.js';

// Storage key the admin "Model config" tab + the onboarding wizard write
// the runtime fast-model selection to. Lives at the kernel `storage:*`
// surface (NOT inside `credentials-store-db`'s `credential:v2:` namespace).
const FAST_MODEL_STORAGE_KEY = 'settings:fast-model';

const PLUGIN_NAME = '@ax/conversation-titles';
const PLUGIN_VERSION = '0.0.0';

const TITLE_MAX_TOKENS = 32;
// A touch of variety so titles don't all converge to the same dull phrase
// across similar conversations, but mostly deterministic — a high-temperature
// title is a coin flip and we'd rather it be readable.
const TITLE_TEMPERATURE = 0.3;

// Generate a title on any of the first N assistant turns while the
// conversation is still untitled — not just the first. The single-attempt
// design left a chat permanently untitled whenever that one attempt was
// skipped or failed for a transient reason: `conversations:get` reading the
// runner's jsonl before it's flushed (0 turns), an `llm:call` error, or the
// model returning an unusable title. Re-attempting on the next few turns
// recovers from those; the `title !== null` guard + `ifNull: true` on
// set-title keep it idempotent (once a title lands we stop). The cap bounds
// title-LLM spend if a model keeps emitting rejected output forever.
const MAX_TITLE_ATTEMPT_TURNS = 3;

/**
 * Default `provider/model` reference — preserves today's hardcoded haiku.
 * Operators override via the preset's `AX_TITLE_MODEL` env var, which flows
 * through `K8sPresetConfig.titles.model` to the factory's `cfg.model`.
 */
export const DEFAULT_TITLE_MODEL = 'anthropic/claude-haiku-4-5-20251001';

export interface ConversationTitlesConfig {
  /**
   * Title-LLM model reference in the form `<provider>/<model-id>`.
   * Splits on the first `/`. Provider becomes the bus hook name suffix
   * (`llm:call:<provider>`); model-id flows into the call's `model` field.
   *
   * Default: `'anthropic/claude-haiku-4-5-20251001'`.
   */
  model?: string;
}

export interface ParsedModelRef {
  provider: string;
  modelId: string;
}

/**
 * Parse a `provider/model-id` reference. Splits on the FIRST `/` so a
 * future routing-style value like `openrouter/anthropic/claude-3-5-sonnet`
 * yields provider=`openrouter`, modelId=`anthropic/claude-3-5-sonnet`.
 *
 * Throws `PluginError({ code: 'invalid-config' })` on:
 *   - empty string
 *   - missing `/`
 *   - leading `/` (empty provider)
 *   - trailing `/` (empty model-id)
 */
export function parseModelRef(ref: string): ParsedModelRef {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `model must be 'provider/model-id' (got empty value)`,
    });
  }
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `model must be 'provider/model-id' (got: ${ref})`,
    });
  }
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

/**
 * `chat:turn-end` payload shape. The bus delivers whatever the publisher
 * fired. We re-read the canonical transcript via `conversations:get`, but
 * also use `contentBlocks` as a fallback when that read hasn't caught up yet
 * (see `turnsForTitle`). `contentBlocks` was validated against
 * `ContentBlockSchema` at the IPC boundary (`EventTurnEndSchema`), so it's a
 * `ContentBlock[]` for a real assistant turn.
 */
interface TurnEndPayload {
  role?: 'user' | 'assistant' | 'tool';
  contentBlocks?: unknown[];
  reqId?: string;
  reason?: string;
}

/**
 * The transcript to title from. Prefer the canonical transcript
 * (`conversations:get`), but augment it with THIS turn's assistant blocks
 * (carried on the `chat:turn-end` payload) when the read doesn't yet reflect
 * an assistant turn.
 *
 * Why: under runner-owned-sessions the transcript lives in the runner's
 * native jsonl, synced to the host via `workspace.commit-notify`. That sync
 * can lag the `chat:turn-end` event by up to ~1s. On a SINGLE-turn
 * conversation that lag is fatal — `conversations:get` returns an empty (or
 * user-only) transcript at the ONLY moment we'd ever title the chat, because
 * the cross-turn retry (MAX_TITLE_ATTEMPT_TURNS) only ever fires on a *later*
 * assistant turn that never comes. The chat then stays "New Chat" forever
 * (the title is genuinely NULL in the DB, so a reload doesn't recover it).
 *
 * The turn-end payload IS this just-ended assistant turn, so falling back to
 * it makes titling independent of the jsonl-sync race. We only synthesize a
 * turn when the read shows no assistant turn at all — once the canonical
 * read reflects assistant turns, it's authoritative (and the spend cap below
 * keys off it as before).
 */
function turnsForTitle(canonical: Turn[], payload: TurnEndPayload): Turn[] {
  if (canonical.some((t) => t.role === 'assistant')) return canonical;
  const blocks = assistantBlocksFromPayload(payload);
  if (blocks.length === 0) return canonical;
  return [
    ...canonical,
    {
      turnId: '',
      turnIndex: canonical.length,
      role: 'assistant',
      contentBlocks: blocks,
      createdAt: new Date().toISOString(),
    },
  ];
}

/**
 * Narrow the payload's `contentBlocks` to `ContentBlock[]`. The IPC boundary
 * already validated them against `ContentBlockSchema`, so a light shape check
 * (object with a string `type`) is enough to recover the type without
 * re-deriving the schema and pulling zod into this plugin.
 */
function assistantBlocksFromPayload(payload: TurnEndPayload): ContentBlock[] {
  const blocks = payload.contentBlocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(
    (b): b is ContentBlock =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as { type?: unknown }).type === 'string',
  );
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
export function createConversationTitlesPlugin(
  cfg: ConversationTitlesConfig = {},
): Plugin {
  const fallbackRef = cfg.model ?? DEFAULT_TITLE_MODEL;
  // Eagerly validate the fallback config so a typo fails at boot, not at
  // first chat:turn-end. The runtime override path goes through
  // parseModelRef again so a bad storage value is caught before it lands
  // in an llm:call.
  const fallbackParsed = parseModelRef(fallbackRef);
  const fallbackHook = `llm:call:${fallbackParsed.provider}`;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [],
      // `storage:get` is a soft dep — declared so the topo-sort orders us
      // after any storage plugin that registers it, but the runtime path
      // tolerates `storage:get` being absent (presets that strip it just
      // fall through to cfg.model). The configured fallback llm hook is
      // declared as the hard provider; a runtime override that points to a
      // different provider hook is resolved against the bus dynamically.
      calls: [fallbackHook, 'storage:get', 'conversations:get', 'conversations:set-title'],
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
            const resolved = await resolveTitleModel(bus, ctx, {
              fallbackRef,
              fallbackHook,
              fallbackModelId: fallbackParsed.modelId,
            });
            await handleTurnEnd(bus, ctx, payload, {
              llmCallHook: resolved.llmCallHook,
              modelId: resolved.modelId,
            });
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

interface ResolvedTitleModel {
  llmCallHook: string;
  modelId: string;
}

/**
 * Resolve the title-LLM model for this turn. Reads the runtime override
 * from `storage:get('settings:fast-model')` if available; otherwise uses
 * the plugin's configured fallback.
 *
 * The override exists so the operator can change the title model from the
 * admin UI without redeploying. The wizard's first-run write seeds the
 * same key, so post-onboarding chat uses the operator's chosen model
 * straight away.
 *
 * Failure modes (silently fall back to cfg.model):
 *  - `storage:get` not registered → no storage layer in this preset.
 *  - `storage:get` throws → transient backend issue; titling is a nice-to-
 *    have, not load-bearing.
 *  - Decoded value is empty or not a valid `provider/model-id` ref.
 */
async function resolveTitleModel(
  bus: HookBus,
  ctx: AgentContext,
  fallback: {
    fallbackRef: string;
    fallbackHook: string;
    fallbackModelId: string;
  },
): Promise<ResolvedTitleModel> {
  const fallbackResult: ResolvedTitleModel = {
    llmCallHook: fallback.fallbackHook,
    modelId: fallback.fallbackModelId,
  };
  if (!bus.hasService('storage:get')) return fallbackResult;
  let value: Uint8Array | undefined;
  try {
    const r = await bus.call<
      { key: string },
      { value: Uint8Array | undefined }
    >('storage:get', ctx, { key: FAST_MODEL_STORAGE_KEY });
    value = r.value;
  } catch (err) {
    ctx.logger.debug('conversation_titles_storage_get_failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return fallbackResult;
  }
  if (value === undefined || value.length === 0) return fallbackResult;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return fallbackResult;
  }
  if (text.length === 0) return fallbackResult;
  let parsed: ParsedModelRef;
  try {
    parsed = parseModelRef(text);
  } catch {
    ctx.logger.warn('conversation_titles_invalid_storage_ref', {
      // Length only — the raw value may contain a provider name we don't
      // want in logs verbatim.
      length: text.length,
      fallback: fallback.fallbackRef,
    });
    return fallbackResult;
  }
  const overrideHook = `llm:call:${parsed.provider}`;
  // The override pointed at a provider whose llm:call:<provider> hook
  // isn't registered in this deployment. Fall back to cfg.model so
  // titling still runs — the configured fallback hook is guaranteed
  // to be present (it's declared as a hard call in the manifest).
  if (!bus.hasService(overrideHook)) {
    ctx.logger.warn('conversation_titles_override_hook_missing', {
      provider: parsed.provider,
      fallback: fallback.fallbackRef,
    });
    return fallbackResult;
  }
  return {
    llmCallHook: overrideHook,
    modelId: parsed.modelId,
  };
}

async function handleTurnEnd(
  bus: HookBus,
  ctx: AgentContext,
  payload: TurnEndPayload,
  cfg: { llmCallHook: string; modelId: string },
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

  // Fall back to the turn-end payload's assistant blocks when the canonical
  // read hasn't caught up to this turn yet (single-turn jsonl-sync race —
  // see turnsForTitle). Without this, a single-turn conversation never gets
  // titled because the cross-turn retry below never sees a second turn.
  const turns = turnsForTitle(conv.turns, payload);
  if (turns.length === 0) return;

  // Auto-title on the first few assistant turns while still untitled — see
  // MAX_TITLE_ATTEMPT_TURNS. Past the cap we stop re-attempting so a model
  // that keeps emitting unusable titles can't drive unbounded LLM spend.
  const assistantTurnCount = turns.filter(
    (t) => t.role === 'assistant',
  ).length;
  if (assistantTurnCount < 1 || assistantTurnCount > MAX_TITLE_ATTEMPT_TURNS) {
    return;
  }

  const prompt = buildPrompt(turns);
  const llmOut = await bus.call<LlmCallInput, LlmCallOutput>(
    cfg.llmCallHook,
    ctx,
    {
      model: cfg.modelId,
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
