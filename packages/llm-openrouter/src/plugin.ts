import {
  LlmCallOutputSchema,
  PluginError,
  providerEndpointFor,
  type AgentContext,
  type HookBus,
  type LlmCallInput,
  type LlmCallOutput,
  type Plugin,
  type ProviderEndpoint,
} from '@ax/core';
import { z, type ZodType } from 'zod';
import { toChatCompletionsRequest, fromChatCompletionsBody } from './translate.js';

const PLUGIN_NAME = '@ax/llm-openrouter';
const PLUGIN_VERSION = '0.0.0';

// The one table both sides of the sandbox boundary read (@ax/core). We take
// the base URL and the credential ref from it rather than hardcoding strings
// here, so this plugin and the in-sandbox runner can't drift about where
// OpenRouter lives.
//
// The lookup is `| undefined` because the table is a Record with a string
// index signature, and there's no honest way to keep running without it — so
// we fail at import rather than at the first model call, when an operator is
// watching.
const ENDPOINT: ProviderEndpoint = requireEndpoint('openrouter');

function requireEndpoint(id: string): ProviderEndpoint {
  const endpoint = providerEndpointFor(id);
  if (endpoint === undefined) {
    throw new PluginError({
      code: 'init-failed',
      plugin: PLUGIN_NAME,
      hookName: 'init',
      message: `@ax/core's PROVIDER_ENDPOINTS has no '${id}' entry — this plugin cannot run without it`,
    });
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// models:list-supported:openrouter
// ---------------------------------------------------------------------------

export interface ModelsListSupportedOutput {
  models: Array<{
    id: string;
    label: string;
    /** 'fast' = title generation / cheap loops; 'default' = chat. 'either' = both work. */
    kind: 'fast' | 'default' | 'either';
  }>;
}

// Runtime `returns` contract for `models:list-supported:openrouter`. Declared
// locally rather than imported from @ax/llm-anthropic: invariant 2 forbids
// cross-plugin imports, and the hook bus — not a shared type — is the contract
// between us. The two copies are structurally identical on purpose; the one
// caller (`GET /admin/agents/models`) merges both.
export const ModelsListSupportedOutputSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.union([z.literal('fast'), z.literal('default'), z.literal('either')]),
    }),
  ),
}) as unknown as ZodType<ModelsListSupportedOutput>;

// Seed catalog — verified against `GET https://openrouter.ai/api/v1/models` on
// 2026-08-20.
//
// This is a LABEL SOURCE, NOT A GATE. OpenRouter serves 419 models and churns
// weekly; the picker route (`listModels` in @ax/agents' admin-routes) already
// emits any allow-listed ref this list doesn't cover, labelled with the bare
// id. So the seed exists to give the common choices a readable name in the
// dropdown — and when it goes stale, the failure mode is a duller label, never
// an unusable picker or an unselectable model. Which is exactly the trade we
// want from an aggregator: the operator's allow-list is the authority, we just
// make it nicer to read.
//
// Ids are `openrouter/<slug>` refs. The slug keeps its own `/`
// (`x-ai/grok-4.6`), which is why `parseModelRef` splits on the FIRST slash.
const SEED_CATALOG: ModelsListSupportedOutput = {
  models: [
    { id: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6', kind: 'either' },
    { id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3', kind: 'either' },
    { id: 'openrouter/google/gemini-3.7-flash', label: 'Gemini 3.7 Flash', kind: 'fast' },
    { id: 'openrouter/deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', kind: 'default' },
    { id: 'openrouter/qwen/qwen3-max', label: 'Qwen3 Max', kind: 'either' },
    { id: 'openrouter/openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', kind: 'either' },
  ],
};

// ---------------------------------------------------------------------------
// credentials:validate:openrouter
// ---------------------------------------------------------------------------

/**
 * The shape `@ax/credentials-admin-routes`' `validateProviderKey` dispatches
 * for — it calls `credentials:validate:<providerId>` with `{ key: Uint8Array }`
 * and expects this back. Declared locally (invariant 2); the hook bus is the
 * contract.
 */
export type ProviderValidationResult = { ok: true } | { ok: false; error: string };

const ProviderValidationResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]) as unknown as ZodType<ProviderValidationResult>;

/** How long we'll wait for OpenRouter to confirm a key before giving up. */
const VALIDATION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// llm:call:openrouter
// ---------------------------------------------------------------------------

// Statuses we consider transient — a 1-shot retry buys resilience without
// turning the plugin into a backoff library. Anything else — auth, a bad model
// id, persistent quota — is the caller's problem, and retrying it would just
// double the bill. Same set and same reasoning as @ax/llm-anthropic.
const TRANSIENT_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface LlmOpenRouterConfig {
  /**
   * OpenRouter API key. Falls back to `process.env.OPENROUTER_API_KEY` if
   * unset. We refuse to init without one — a silent fallback to "no auth"
   * would be a footgun.
   */
  apiKey?: string;
  /** Model used when the caller doesn't specify one. A BARE slug, no prefix. */
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
   * Per-request timeout for the model call, in milliseconds. Unset = no
   * deadline of our own (the host's hook timeout still applies). Latency-
   * sensitive callers — auto-titling, short interactive turns — should set
   * something so a stuck upstream doesn't pin a worker.
   */
  timeoutMs?: number;
  /**
   * Test seam: the `fetch` implementation to use. Production callers leave
   * this unset and get the global one. There is no provider SDK here on
   * purpose — one fewer dependency to trust, and nothing that can go looking
   * for credentials in the environment behind our back.
   */
  fetchImpl?: typeof fetch;
  /**
   * When true, resolve the API key PER-CALL from the credential store
   * (`credentials:get` on {@link credentialRef}, by the call ctx's userId
   * precedence) instead of fixing a single key at init. `cfg.apiKey` (explicit
   * override) then `OPENROUTER_API_KEY` (env) remain fallbacks, in that order.
   *
   * This is what lets host-side callers (auto-titling, the memory observer)
   * work off the operator's stored `provider:openrouter` credential WITHOUT a
   * boot-time host env key — the point of the multi-tenant deploy. When no key
   * resolves at all, `llm:call:openrouter` throws `no-openrouter-credential`
   * PER CALL (init still succeeds), which best-effort callers skip quietly.
   *
   * Default false → static mode: resolve one key at init, refuse to init
   * without one.
   */
  credentialResolution?: boolean;
  /**
   * Provider ref resolved in {@link credentialResolution} mode. Defaults to
   * the canonical `provider:openrouter` from `PROVIDER_ENDPOINTS`. Override
   * only for tests.
   */
  credentialRef?: string;
}

// Locally-declared `credentials:get` shape (invariant 2 — no cross-plugin
// imports; we name only what we call).
interface CredentialsGetInput {
  ref: string;
  userId: string;
}

export function createLlmOpenRouterPlugin(cfg: LlmOpenRouterConfig = {}): Plugin {
  const credentialResolution = cfg.credentialResolution === true;
  const credentialRef = cfg.credentialRef ?? ENDPOINT.credentialRef;
  const manifest: Plugin['manifest'] = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    registers: [
      'llm:call:openrouter',
      'models:list-supported:openrouter',
      'credentials:validate:openrouter',
    ],
    calls: [],
    subscribes: [],
    // `credentials:get` is OPTIONAL: present only in credentialResolution
    // mode, and even then a soft dependency (we fall back to env/cfg when
    // it's absent or has no row). Declaring it keeps the dependency visible
    // without making static-mode/CLI boots — which never load credentials —
    // fail verifyCalls.
    ...(credentialResolution
      ? {
          optionalCalls: [
            {
              hook: 'credentials:get',
              degradation:
                'the OpenRouter key falls back to OPENROUTER_API_KEY env / cfg.apiKey; if none, llm:call:openrouter errors per-call and best-effort callers (auto-titling, memory extraction) skip quietly',
            },
          ],
        }
      : {}),
  };

  return {
    manifest,
    async init({ bus }) {
      const fetchImpl = cfg.fetchImpl ?? fetch;

      if (!credentialResolution) {
        // Static mode: resolve once at init; refuse to boot keyless.
        const apiKey = cfg.apiKey ?? process.env.OPENROUTER_API_KEY;
        if (apiKey === undefined || apiKey.length === 0) {
          throw new PluginError({
            code: 'init-failed',
            plugin: PLUGIN_NAME,
            hookName: 'init',
            message:
              'OPENROUTER_API_KEY not set and cfg.apiKey not provided — refusing to init',
          });
        }
        bus.registerService<LlmCallInput, LlmCallOutput>(
          'llm:call:openrouter',
          PLUGIN_NAME,
          async (_ctx, input) => callWithRetry(fetchImpl, apiKey, input, cfg),
          { returns: LlmCallOutputSchema, timeoutMs: 300_000 },
        );
      } else {
        // Credential-resolution mode: resolve the key for each call.
        bus.registerService<LlmCallInput, LlmCallOutput>(
          'llm:call:openrouter',
          PLUGIN_NAME,
          async (ctx, input) => {
            const apiKey = await resolveApiKey(bus, ctx, cfg, credentialRef);
            return callWithRetry(fetchImpl, apiKey, input, cfg);
          },
          { returns: LlmCallOutputSchema, timeoutMs: 300_000 },
        );
      }

      // Per-provider hook name, mirroring `llm:call:<provider>` above and for
      // the same mechanical reason: `registerService` is SINGLE-OWNER (a
      // second registrant throws `duplicate-service`, and bootstrap's
      // `checkDuplicateRegisters` rejects it even earlier from the manifest).
      // Aggregation across providers happens in the one caller,
      // `GET /admin/agents/models` in @ax/agents.
      bus.registerService<unknown, ModelsListSupportedOutput>(
        'models:list-supported:openrouter',
        PLUGIN_NAME,
        async () => ({ models: SEED_CATALOG.models.map((m) => ({ ...m })) }),
        { returns: ModelsListSupportedOutputSchema },
      );

      // Pre-save key check for the admin Providers panel. The route
      // (`validateProviderKey` in @ax/credentials-admin-routes) prefers a
      // registered `credentials:validate:<provider>` service over its built-in
      // fallback, which only knows Anthropic — so without this, saving an
      // OpenRouter key would 422 with "validation not supported".
      bus.registerService<{ key: Uint8Array }, ProviderValidationResult>(
        'credentials:validate:openrouter',
        PLUGIN_NAME,
        async (_ctx, input) => validateKey(fetchImpl, input.key),
        { returns: ProviderValidationResultSchema },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

/** An HTTP failure from OpenRouter. `.status` is what the retry decision reads. */
class OpenRouterHttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`HTTP ${status}${detail.length > 0 ? `: ${detail}` : ''}`);
    this.name = 'OpenRouterHttpError';
    this.status = status;
  }
}

async function callWithRetry(
  fetchImpl: typeof fetch,
  apiKey: string,
  input: LlmCallInput,
  cfg: LlmOpenRouterConfig,
): Promise<LlmCallOutput> {
  const req = toChatCompletionsRequest(input, cfg);
  const retryDelayMs = cfg.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  // Two attempts max — initial + one retry on a transient status. Every path
  // through the loop body either returns or throws.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await postCompletion(fetchImpl, apiKey, req, cfg);
    } catch (e) {
      // A translation failure (unreadable body, no choices) is already a
      // well-formed PluginError naming this plugin and hook — re-wrapping it
      // would bury the reason one layer deeper for no gain.
      if (e instanceof PluginError) throw e;
      if (attempt === 0 && isTransient(e)) {
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        continue;
      }
      throw new PluginError({
        code: 'unknown',
        plugin: PLUGIN_NAME,
        hookName: 'llm:call:openrouter',
        message: `OpenRouter API call failed: ${errorMessage(e)}`,
        ...(e instanceof Error ? { cause: e } : {}),
      });
    }
  }
  // Unreachable: the loop body above always returns or throws. TypeScript
  // can't see that through the numeric `for`, so this is here purely as an
  // assertion — if it ever fires, the loop's control flow has been broken.
  throw new Error('callWithRetry: loop exited without returning or throwing');
}

async function postCompletion(
  fetchImpl: typeof fetch,
  apiKey: string,
  body: unknown,
  cfg: LlmOpenRouterConfig,
): Promise<LlmCallOutput> {
  const ctrl = new AbortController();
  const timer =
    cfg.timeoutMs !== undefined ? setTimeout(() => ctrl.abort(), cfg.timeoutMs) : undefined;
  try {
    const res = await fetchImpl(`${ENDPOINT.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        // OpenRouter is OpenAI-compatible, so the key rides in a standard
        // Bearer header. Inside a sandbox this value is the proxy-minted
        // `ax-cred:<32-hex>` placeholder, which the credential proxy
        // substitutes by VALUE — no header-name special-casing needed.
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new OpenRouterHttpError(res.status, await describeFailure(res));
    }
    return fromChatCompletionsBody(await res.json(), PLUGIN_NAME, 'llm:call:openrouter');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Pull a short, bounded explanation out of an error response. We read only
 * OpenRouter's documented `{"error":{"message":...}}` field and cap it, rather
 * than splicing a whole provider-controlled body into a message that ends up
 * in logs. A bad model id is by far the most common 400 here, and its message
 * says so — worth the 200 characters.
 */
async function describeFailure(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 200);
  } catch {
    // Not JSON, or the stream died. The status alone is enough.
  }
  return res.statusText;
}

/**
 * Resolve the OpenRouter API key for one call in credentialResolution mode.
 * Precedence: explicit cfg.apiKey → credential store (`credentials:get` by
 * ctx.userId — finds the user's key, then the global one) → env. The resolved
 * key is used ONLY to build the Authorization header; it is never logged or
 * returned. A miss at every tier throws `no-openrouter-credential` so a
 * best-effort caller (auto-titling, the memory observer) can skip without
 * crashing the turn.
 */
async function resolveApiKey(
  bus: HookBus,
  ctx: AgentContext,
  cfg: LlmOpenRouterConfig,
  credentialRef: string,
): Promise<string> {
  if (cfg.apiKey !== undefined && cfg.apiKey.length > 0) return cfg.apiKey;

  // credentials:get requires a non-empty userId (validated against
  // USER_ID_RE); skip the lookup for a userId-less ctx rather than provoke an
  // invalid-payload.
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
      // subscriber owns the user-visible "skipped" log.
    }
  }

  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey !== undefined && envKey.length > 0) return envKey;

  throw new PluginError({
    code: 'no-openrouter-credential',
    plugin: PLUGIN_NAME,
    hookName: 'llm:call:openrouter',
    message:
      'no OpenRouter credential available (no provider:openrouter in the credential store for this user/global, and OPENROUTER_API_KEY unset)',
  });
}

// ---------------------------------------------------------------------------
// The key check
// ---------------------------------------------------------------------------

/**
 * Ask OpenRouter whether a key works, without ever letting the key back out.
 *
 * The discipline here mirrors `validateAnthropicKey` in
 * @ax/credentials-admin-routes: the bytes become a string only for the
 * duration of the header, the response body is discarded unread, and NOTHING
 * derived from the request — not the key, not a provider error message that
 * might quote it back at us — makes it into the returned value or a thrown
 * error. This runs on an operator's pasted secret; the result string lands in
 * an alert on screen and, if anything above us logs it, in a log file. So the
 * only things we're willing to say are: it worked, it didn't, or we couldn't
 * tell.
 *
 * We never throw: the route renders `{ok:false, error}` as a 422 with a real
 * reason, which is friendlier than a 500 with a stack trace.
 */
async function validateKey(
  fetchImpl: typeof fetch,
  keyBytes: Uint8Array,
): Promise<ProviderValidationResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATION_TIMEOUT_MS);
  const keyString = new TextDecoder().decode(keyBytes);
  try {
    // GET /key is OpenRouter's "who am I" endpoint — the cheapest way to ask
    // whether a key is live without spending tokens on a completion.
    const res = await fetchImpl(`${ENDPOINT.baseUrl}/key`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${keyString}` },
      signal: ctrl.signal,
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error:
          'OpenRouter rejected that key. Double-check you copied the whole thing from openrouter.ai/keys.',
      };
    }
    return {
      ok: false,
      error: `OpenRouter answered ${res.status}, so we could not confirm the key. Worth trying again in a moment.`,
    };
  } catch {
    // Deliberately swallowing the error object rather than reporting it: it's
    // the one value in scope that could have the key in it (a redirect URL, a
    // proxy error quoting the request headers).
    if (ctrl.signal.aborted) {
      return {
        ok: false,
        error:
          'OpenRouter did not answer within 10 seconds, so we could not confirm the key. Worth trying again in a moment.',
      };
    }
    return {
      ok: false,
      error: 'We could not reach OpenRouter to confirm the key. Check network access and try again.',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------

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
