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

export function makeOpenRouterOrchestratorClient(
  apiKey: string,
  model = 'x-ai/grok-4-fast',
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
