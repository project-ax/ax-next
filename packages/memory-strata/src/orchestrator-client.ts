// Fetch-based OrchestratorClient implementations (TASK-191, Task 2). No SDK
// dependency: the orchestrator is a narrow one-shot completion call
// (system+user in, text+usage out), so a raw `fetch` POST is simpler than
// pulling `openai`/`@anthropic-ai/sdk` into @ax/memory-strata's runtime deps
// (those stay bench-only devDependencies — see package.json). Two backends:
// direct xAI (the n=500 spike's winning config — ~400ms p50, see
// docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md) and
// OpenRouter (fallback / explicit provider-forcing for eval work).
//
// Host-side egress only: this module never runs in the sandbox, and the
// caller (plugin.ts, TASK-191 Task 3) only constructs a client when the host
// holds the relevant API key. No new npm dependency, no new IPC surface —
// see the plan's security-checklist note (supply chain: N/A, pinned hosts).
//
// Retry policy: bounded retry on a network throw or a 429/5xx status. The
// caller (`runOrchestratedRetrieve`) already bounds overall latency via
// `raceTimeout`, so a retry here just spends a slice of that budget on
// resilience against one flaky response instead of falling straight through
// to BM25. A non-retryable non-2xx (e.g. 400 — a malformed request) throws
// immediately; retrying it would never succeed.

import type {
  AgentContext,
  HookBus,
  LlmCallInput,
  LlmCallOutput,
} from '@ax/core';

import type { OrchestratorClient } from './orchestrator.js';

export interface OrchestratorClientOptions {
  /** Injectable fetch seam — defaults to the global `fetch`. Tests stub this. */
  fetchImpl?: typeof fetch;
  /**
   * Optional per-attempt abort timeout (ms), applied via `AbortSignal.timeout`.
   * Unset by default — the caller's `raceTimeout` already bounds overall wall
   * time, so this is only useful to cap an individual retry attempt.
   */
  timeoutMs?: number;
  /** Max retries after the first attempt. Default 2 (⇒ up to 3 attempts total). */
  maxRetries?: number;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 50;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

type CompleteResult = { text: string; usage: { in: number; out: number } };

/**
 * Shared POST + retry + parse logic for both backends — they differ only in
 * URL, model default, and (for OpenRouter) an optional `provider` routing
 * override, all supplied by the caller.
 */
async function postChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  opts: OrchestratorClientOptions | undefined,
): Promise<CompleteResult> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(opts?.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      });
    } catch (err) {
      // Network-level throw (DNS, connection reset, abort, ...): retryable.
      if (attempt >= maxRetries) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const json = (await res.json()) as ChatCompletionResponse;
      return {
        text: json.choices?.[0]?.message?.content ?? '',
        usage: {
          in: json.usage?.prompt_tokens ?? 0,
          out: json.usage?.completion_tokens ?? 0,
        },
      };
    }

    // Non-2xx: retry only the specific transient statuses, and only while
    // attempts remain. Anything else (or exhausted retries) throws — this
    // branch is NOT inside a try/catch, so it is never accidentally retried
    // twice via the network-throw path above.
    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }
    throw new Error(`orchestrator http ${res.status}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeXaiOrchestratorClient(
  apiKey: string,
  // UNVERIFIED since the direct-xAI path was retired (2026-09-10) — two
  // neighbouring Grok ids have 404'd as deprecated since this was written.
  // Pass an explicit model if you revive this client.
  model = 'grok-4-fast-non-reasoning',
  opts?: OrchestratorClientOptions,
): OrchestratorClient {
  return {
    complete({ system, user }) {
      return postChatCompletion(
        'https://api.x.ai/v1/chat/completions',
        { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        {
          model,
          max_tokens: 512,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        opts,
      );
    },
  };
}

/**
 * OpenRouter-backed fetch client, for bench and eval runs.
 *
 * NOT the production path any more. Both presets now route the orchestrator
 * through `llm:call:openrouter` (see {@link makeBusOrchestratorClient}), which
 * resolves its credential through the provider plugin — so production needs no
 * client holding a key. This one survives because the bench does: `forceProvider`
 * pins OpenRouter's provider routing, which the hook cannot express and which the
 * n=500 spike needed in order to compare providers at all.
 *
 * A note on that spike, since its numbers are quoted in several places: the
 * ~11s p50 it measured was `x-ai/grok-4.1-fast` under OpenRouter's DEFAULT
 * routing, and the same probe records that model as deprecated on OpenRouter
 * (the force-xai arm FAILED for that reason, so provider-forcing was never
 * actually measured). The report's own conclusion was "direct xAI **or another
 * equivalently-fast provider**". Treat 11s as a fact about one deprecated
 * model's routing in May 2026, not about OpenRouter.
 */
export function makeOpenRouterOrchestratorClient(
  apiKey: string,
  model = DEFAULT_ORCHESTRATOR_MODEL,
  forceProvider?: string,
  opts?: OrchestratorClientOptions,
): OrchestratorClient {
  return {
    complete({ system, user }) {
      return postChatCompletion(
        'https://openrouter.ai/api/v1/chat/completions',
        { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        {
          model,
          max_tokens: 512,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          ...(forceProvider !== undefined
            ? { provider: { order: [forceProvider], allow_fallbacks: false } }
            : {}),
        },
        opts,
      );
    },
  };
}


/**
 * Max tokens for one orchestrator completion. The orchestrator emits a short
 * op list, not prose; the two fetch clients below use the same number, so the
 * routed and direct paths cost the same.
 */
const ORCHESTRATOR_MAX_TOKENS = 512;

/**
 * Default model for the retrieval orchestrator, as a BARE provider-native id
 * for whichever `llm:call:<provider>` hook it is routed through.
 *
 * Fast and cheap beat clever here: the orchestrator reads a densified map and
 * emits a short op list under a ~5s budget, and anything slower simply loses to
 * the BM25 fallback — silently, which is what makes picking this by reputation
 * dangerous. Exported so the CLI and k8s presets share ONE default rather than
 * drifting apart; both let an operator override it.
 *
 * CHOSEN ON MEASUREMENT, 2026-09-10 (`pnpm --filter @ax/memory-strata
 * bench:latency`, 19 samples each after a warmup, real LongMemEval-S map):
 *
 * | via OpenRouter                 |  p50 |   p95 |   max |
 * |--------------------------------|------|-------|-------|
 * | anthropic/claude-haiku-4.5     | 1049 |  1580 |  1677 |
 * | deepseek/deepseek-v4.1-flash   | 1727 |  2866 |  4629 |
 * | google/gemini-3.8-flash        | 2387 |  3525 |  3532 |
 * | x-ai/grok-4.3                  | 7269 | 18482 | 19802 |
 *
 * Haiku 4.5 wins on both speed and SPREAD — 887..1677ms end to end, where
 * Grok 4.3's p50 alone exceeds the whole budget. Two Grok ids were tried
 * before it and both 404'd as deprecated (`x-ai/grok-4-fast`, and
 * `x-ai/grok-4.1-fast` before that), which is the other half of the lesson:
 * take the id from a live `GET /api/v1/models`, not from a comment.
 *
 * `deepseek-v4.1-flash` is the cheap alternative (~3× lower input price) and
 * fits the budget too; its max sits close to it. Direct Anthropic — not
 * through OpenRouter — measured faster still (635ms p50) if the extra
 * credential path is ever worth it.
 */
export const DEFAULT_ORCHESTRATOR_MODEL = 'anthropic/claude-haiku-4.5';

/** What {@link makeBusOrchestratorClient} needs to route a call. */
export interface BusOrchestratorConfig {
  /** `llm:call:<provider>` hook to route through, e.g. `llm:call:openrouter`. */
  hook?: string;
  /** BARE provider-native model id — `anthropic/claude-haiku-4.5`, not `openrouter/...`. */
  model?: string;
}

/**
 * The production orchestrator client: one completion, routed through a
 * registered `llm:call:<provider>` hook.
 *
 * This is what the two fetch clients below are NOT. They hold an API key of
 * their own, which meant the orchestrator needed a dedicated credential, a
 * dedicated env var and a dedicated chart value to reach it — and TASK-347
 * found that last piece had never existed, so every deployment silently ran
 * the BM25 fallback. Routing through the provider plugin instead means the key
 * comes from the same credential store as every other LLM call (the provider
 * resolves user key → global key → env per call), so storing an OpenRouter key
 * in the credentials UI is the whole of the setup.
 *
 * Returns `undefined` rather than throwing when it cannot route — no hook
 * configured, or no plugin registered for it. `memory_search` reads that as
 * "no orchestrator" and runs plain BM25, which is the same degradation a
 * deployment without a key has always had. Same `bus.hasService` gate as
 * `buildStageBNamer` in plugin.ts, for the same reason.
 *
 * A call that FAILS (the provider throwing `no-<provider>-credential` when
 * nothing holds a key, a timeout, a 5xx) propagates. `memory_search` catches it
 * and falls back; swallowing it here would hand the orchestrator an empty
 * completion and let it report an empty plan as a real one.
 */
export function makeBusOrchestratorClient(
  bus: HookBus,
  ctx: AgentContext,
  cfg: BusOrchestratorConfig | undefined,
): OrchestratorClient | undefined {
  const hook = cfg?.hook;
  const model = cfg?.model;
  if (hook === undefined || hook.length === 0) return undefined;
  if (model === undefined || model.length === 0) return undefined;
  if (!bus.hasService(hook)) return undefined;

  return {
    async complete({ system, user }) {
      const out = await bus.call<LlmCallInput, LlmCallOutput>(hook, ctx, {
        model,
        maxTokens: ORCHESTRATOR_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
        // Least deliberation the endpoint allows. This role is the reason the
        // field exists: the orchestrator reads a densified map and emits a
        // short op list under DEFAULT_ORCHESTRATOR_TIMEOUT_MS, past which
        // memory_search falls back to BM25 SILENTLY — so a model that thinks
        // first spends the budget on tokens the op parser discards and the
        // deployment never finds out. Measured 2026-09-11 on
        // z-ai/glm-5.3-flash:nitro: p50 3489 -> 954ms, p95 16195 -> 1256ms.
        //
        // Hard-coded rather than configurable on purpose — there is no version
        // of this role that wants to think harder, and a knob would just be a
        // way to reintroduce the silent timeout.
        reasoningEffort: 'minimal',
      });
      return {
        text: out.text,
        usage: { in: out.usage.inputTokens, out: out.usage.outputTokens },
      };
    },
  };
}
