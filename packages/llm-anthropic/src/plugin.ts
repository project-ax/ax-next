import Anthropic from '@anthropic-ai/sdk';
import {
  LlmCallOutputSchema,
  PluginError,
  type AgentContext,
  type HookBus,
  type LlmCallInput,
  type LlmCallOutput,
  type Plugin,
} from '@ax/core';
import { z, type ZodType } from 'zod';
import { fromAnthropicResponse, toAnthropicRequest } from './translate.js';

const PLUGIN_NAME = '@ax/llm-anthropic';
const PLUGIN_VERSION = '0.0.0';

export interface ModelsListSupportedOutput {
  models: Array<{
    id: string;
    label: string;
    /** 'fast' = title generation / cheap loops; 'default' = chat. 'either' = both work. */
    kind: 'fast' | 'default' | 'either';
  }>;
}

// Runtime `returns` contract for `models:list-supported` (ARCH-13). The hook is
// IPC-adjacent (the admin/settings model-picker reads it), so a malformed entry
// flowing out would corrupt the UI's selectable set. `LlmCallOutputSchema` for
// the sibling `llm:call:anthropic` hook lives in @ax/core (its type does too);
// this one is registrant-local because `ModelsListSupportedOutput` is.
export const ModelsListSupportedOutputSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.union([z.literal('fast'), z.literal('default'), z.literal('either')]),
    }),
  ),
}) as unknown as ZodType<ModelsListSupportedOutput>;

// Statuses we consider transient — a 1-shot retry buys us resilience without
// turning the plugin into a backoff library. Anything else — auth, validation,
// persistent quota — is the orchestrator's problem.
const TRANSIENT_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface LlmAnthropicConfig {
  /**
   * Anthropic API key. Falls back to `process.env.ANTHROPIC_API_KEY` if
   * unset. We refuse to init without one — silent fallback to "no auth"
   * would be a footgun.
   */
  apiKey?: string;
  /** Model used when the caller doesn't specify one. */
  defaultModel?: string;
  /** `max_tokens` used when the caller doesn't specify one. */
  defaultMaxTokens?: number;
  /**
   * Delay between the first attempt and the single retry, in milliseconds.
   * Tests pass `0` to keep the suite fast; production callers should leave
   * this at the default (1s) or set their own policy via a wrapper plugin.
   */
  retryDelayMs?: number;
  /**
   * Per-request timeout passed to the Anthropic SDK client, in milliseconds.
   * The SDK default is 600s (10 minutes); for latency-sensitive contexts
   * (auto-titling, short interactive turns) callers should set something
   * lower so a stuck request doesn't pin a worker for ten minutes.
   * Unset = inherit the SDK default.
   */
  timeoutMs?: number;
  /**
   * Test seam: hand back a stub Anthropic client instead of constructing
   * a real one. Production callers leave this unset.
   */
  clientFactory?: (apiKey: string) => Anthropic;
  /**
   * When true, resolve the API key PER-CALL from the credential store
   * (`credentials:get` ref {@link credentialRef}, by the call ctx's userId
   * precedence) instead of fixing a single key at init. `cfg.apiKey` (explicit
   * override) then `ANTHROPIC_API_KEY` (env) remain fallbacks, in that order.
   *
   * This is what lets host-side callers (auto-titling, the memory observer)
   * work off the first-run wizard's stored `provider:anthropic` credential
   * WITHOUT a boot-time host env key — the point of the multi-tenant deploy.
   * When no key resolves at all, `llm:call:anthropic` throws
   * `no-anthropic-credential` PER CALL (init still succeeds), which best-effort
   * callers skip quietly.
   *
   * Default false → legacy behavior: resolve one static key at init, refuse to
   * init without one.
   */
  credentialResolution?: boolean;
  /**
   * Provider ref resolved in {@link credentialResolution} mode. Defaults to the
   * canonical `provider:anthropic` (what the onboarding wizard stores via
   * `credentials:set`). Override only for tests.
   */
  credentialRef?: string;
}

// The credential the wizard stores at global scope (onboarding completion-tx)
// and the chat path resolves — `refForDestination({kind:'provider',provider:'anthropic'})`.
const DEFAULT_CREDENTIAL_REF = 'provider:anthropic';

// Locally-declared `credentials:get` shape (Invariant #2 — no cross-plugin
// imports; the hook bus is the contract, we name only what we call).
interface CredentialsGetInput {
  ref: string;
  userId: string;
}

export function createLlmAnthropicPlugin(cfg: LlmAnthropicConfig = {}): Plugin {
  const credentialResolution = cfg.credentialResolution === true;
  const credentialRef = cfg.credentialRef ?? DEFAULT_CREDENTIAL_REF;
  const manifest: Plugin['manifest'] = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    registers: ['llm:call:anthropic', 'models:list-supported'],
    calls: [],
    subscribes: [],
    // `credentials:get` is OPTIONAL: present only in credentialResolution mode,
    // and even then a soft dependency (we fall back to env/cfg when it's absent
    // or has no row). Declaring it keeps the dependency visible without making
    // static-mode/CLI boots — which never load credentials — fail verifyCalls.
    ...(credentialResolution
      ? {
          optionalCalls: [
            {
              hook: 'credentials:get',
              degradation:
                'the Anthropic key falls back to ANTHROPIC_API_KEY env / cfg.apiKey; if none, llm:call:anthropic errors per-call and best-effort callers (auto-titling) skip quietly',
            },
          ],
        }
      : {}),
  };
  return {
    manifest,
    async init({ bus }) {
      // Construct (and memoize) the SDK client for a resolved key. In
      // credentialResolution mode the key varies per call (per-user / global),
      // so caching by key avoids rebuilding the client on every turn.
      const clients = new Map<string, Anthropic>();
      const clientFor = (apiKey: string): Anthropic => {
        const existing = clients.get(apiKey);
        if (existing !== undefined) return existing;
        const created =
          cfg.clientFactory !== undefined
            ? cfg.clientFactory(apiKey)
            : new Anthropic({
                apiKey,
                ...(cfg.timeoutMs !== undefined ? { timeout: cfg.timeoutMs } : {}),
              });
        clients.set(apiKey, created);
        return created;
      };

      if (!credentialResolution) {
        // Legacy static mode: resolve once at init; refuse to boot keyless —
        // a silent fallback to "no auth" would be a footgun.
        const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
        if (apiKey === undefined || apiKey.length === 0) {
          throw new PluginError({
            code: 'init-failed',
            plugin: PLUGIN_NAME,
            hookName: 'init',
            message:
              'ANTHROPIC_API_KEY not set and cfg.apiKey not provided — refusing to init',
          });
        }
        const client = clientFor(apiKey);
        bus.registerService<LlmCallInput, LlmCallOutput>(
          'llm:call:anthropic',
          PLUGIN_NAME,
          async (_ctx, input) => callWithRetry(client, input, cfg),
          { returns: LlmCallOutputSchema, timeoutMs: 300_000 },
        );
      } else {
        // Credential-resolution mode: resolve the key for each call.
        bus.registerService<LlmCallInput, LlmCallOutput>(
          'llm:call:anthropic',
          PLUGIN_NAME,
          async (ctx, input) => {
            const apiKey = await resolveApiKey(bus, ctx, cfg, credentialRef);
            return callWithRetry(clientFor(apiKey), input, cfg);
          },
          { returns: LlmCallOutputSchema, timeoutMs: 300_000 },
        );
      }

      bus.registerService<unknown, ModelsListSupportedOutput>(
        'models:list-supported',
        PLUGIN_NAME,
        async () => ({
          models: [
            { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', kind: 'fast' },
            { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'either' },
            { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', kind: 'default' },
          ],
        }),
        { returns: ModelsListSupportedOutputSchema },
      );
    },
  };
}

async function callWithRetry(
  client: Anthropic,
  input: LlmCallInput,
  cfg: LlmAnthropicConfig,
): Promise<LlmCallOutput> {
  const req = toAnthropicRequest(input, cfg);
  const retryDelayMs = cfg.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Two attempts max — initial + one retry on transient status. Every path
  // through the loop body either returns or throws.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await client.messages.create(req);
      return fromAnthropicResponse(res);
    } catch (e) {
      if (attempt === 0 && isTransient(e)) {
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        continue;
      }
      throw new PluginError({
        code: 'unknown',
        plugin: PLUGIN_NAME,
        hookName: 'llm:call:anthropic',
        message: `Anthropic API call failed: ${errorMessage(e)}`,
        ...(e instanceof Error ? { cause: e } : {}),
      });
    }
  }
  // Unreachable: the loop body above always returns or throws. TypeScript
  // can't see that through the numeric `for`, so this is here purely as an
  // assertion — if it ever fires, the loop's control flow has been broken.
  throw new Error('callWithRetry: loop exited without returning or throwing');
}

/**
 * Resolve the Anthropic API key for one call in credentialResolution mode.
 * Precedence: explicit cfg.apiKey → credential store (`credentials:get` ref,
 * by ctx.userId — finds the user's key then the global wizard key) → env. The
 * resolved key is used ONLY to construct the SDK client; it is never logged or
 * returned. A miss at every tier throws `no-anthropic-credential` so the caller
 * (a best-effort title/observer subscriber) can skip without crashing.
 */
async function resolveApiKey(
  bus: HookBus,
  ctx: AgentContext,
  cfg: LlmAnthropicConfig,
  credentialRef: string,
): Promise<string> {
  if (cfg.apiKey !== undefined && cfg.apiKey.length > 0) return cfg.apiKey;

  // credentials:get requires a non-empty userId (validated against USER_ID_RE);
  // skip the lookup for a userId-less ctx rather than provoke an invalid-payload.
  if (
    typeof ctx.userId === 'string' &&
    ctx.userId.length > 0 &&
    bus.hasService('credentials:get')
  ) {
    try {
      const key = await bus.call<CredentialsGetInput, string>('credentials:get', ctx, {
        ref: credentialRef,
        userId: ctx.userId,
      });
      if (typeof key === 'string' && key.length > 0) return key;
    } catch {
      // Not-found / transient / unsupported-kind — fall through to env. We do
      // NOT log the error (it can carry ref/owner detail); the calling
      // subscriber owns the user-visible "titling skipped" log.
    }
  }

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey !== undefined && envKey.length > 0) return envKey;

  throw new PluginError({
    code: 'no-anthropic-credential',
    plugin: PLUGIN_NAME,
    hookName: 'llm:call:anthropic',
    message:
      'no Anthropic credential available (no provider:anthropic in the credential store for this user/global, and ANTHROPIC_API_KEY unset)',
  });
}

function isTransient(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
