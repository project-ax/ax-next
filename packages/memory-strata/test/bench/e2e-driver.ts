// E2E driver (TASK-189). Runs ONE LongMemEval-S sample through the REAL shipped
// @ax/memory-strata runtime — Observer extraction → inbox → consolidator →
// docs/recent → system-prompt:augment injection → answer — in a throwaway,
// per-question-isolated workspace. This is the seam the bench A–E config drivers
// deliberately bypass; it's what TASK-189 exists to measure.
//
// Per-question isolation follows the `src/__tests__/isolation.test.ts` +
// `plugin.test.ts` patterns: a fresh `mkdtemp` workspace root + a fresh HookBus
// + a fresh plugin pair per sample, torn down at the end. No `workspace:*`
// services are registered, so the plugin takes its CLI / local-FS path (memory
// lives directly under the workspace root) rather than the k8s `/agent` git tier.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus,
  makeAgentContext,
  type AgentContext,
  type AgentOutcome,
  type LlmCallInput,
  type LlmCallOutput,
} from '@ax/core';
import { createMemoryStrataPlugin } from '@ax/memory-strata';
import { createMemoryStrataIndexSqlitePlugin } from '@ax/memory-strata-index-sqlite';
import type { LongMemEvalSample } from './corpora/longmemeval-s.js';
import { isUnanswerable } from './corpora/longmemeval-s.js';
import type { E2EAnswerClient, MemorySearchResult } from './e2e-answer.js';

/** Structural type for the plugin's consolidation debouncer (captured via the
 * onDebouncerCreated test seam). We only need `flush()` — force-fire the pending
 * pass deterministically rather than waiting on its 0ms timer to land on a later
 * tick (the debounce-schedule-races-teardown bug). Typed locally to avoid a deep
 * import of the plugin's internal `debounce.js` (not on its `exports` map). */
interface ConsolidationDebouncer {
  flush(): Promise<void>;
}

/** The extraction LLM the Observer/consolidator run on (cheap per-turn model). */
export const DEFAULT_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

/** A real LLM round-trip for the Observer's fact extraction. */
export type ExtractionLlmFn = (input: LlmCallInput) => Promise<LlmCallOutput>;

export interface E2EQuestionResult {
  questionId: string;
  questionType: string | undefined;
  question: string;
  goldAnswer: string;
  unanswerable: boolean;
  agentAnswer: string;
  /** Token usage attributed to the answer LLM (Sonnet). */
  answerTokens: { in: number; out: number };
  /** Token usage attributed to the Observer extraction LLM (Haiku). */
  extractionTokens: { in: number; out: number };
  /** How many haystack sessions were ingested before the answer. */
  sessionsIngested: number;
  /** memory_search calls the agent made while answering. */
  toolCalls: number;
}

export interface RunE2EQuestionDeps {
  sample: LongMemEvalSample;
  /** Real Anthropic extraction round-trip for the Observer. */
  extractionLlm: ExtractionLlmFn;
  /** Real Anthropic answer client (Sonnet + memory_search tool). */
  answerClient: E2EAnswerClient;
  /** Extraction model id passed to the Observer (and to `agents:resolve`). */
  extractionModel?: string;
  /**
   * Optional per-session abort check (cost cap). Called BEFORE each haystack
   * session's extraction; returning true stops ingestion early and answers from
   * whatever was consolidated so far. The caller wires this to its CostMeter so
   * a single sample can't blow the budget mid-ingest.
   */
  shouldStopIngest?: () => boolean;
  /** Record extraction token usage as it accrues (for the CostMeter). */
  onExtractionUsage?: (usage: { in: number; out: number }) => void;
}

/**
 * Ingest a sample's haystack sessions through the real Observer + consolidator,
 * then answer the question via the real inject + memory_search + answer path.
 *
 * Returns the answer + per-question accounting. The throwaway workspace is
 * always removed (even on error) so a 500-sample run doesn't leak temp dirs.
 */
export async function runE2EQuestion(deps: RunE2EQuestionDeps): Promise<E2EQuestionResult> {
  const { sample, extractionLlm, answerClient } = deps;
  const extractionModel = deps.extractionModel ?? DEFAULT_EXTRACTION_MODEL;
  const agentId = `lme-${sanitizeId(sample.question_id)}`;

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'lme-e2e-q-'));
  const dbPath = join(workspaceRoot, 'index.db');

  // Settle handles captured from the plugin's test-only seams. The Observer is
  // fire-and-forget (I6) and the consolidator is debounced+detached (I10), so we
  // MUST await these rather than sleep — the isolation.test.ts ENOENT flake.
  let settleObserver: ((agentId: string) => Promise<void>) | undefined;
  let settleConsolidation: ((agentId: string) => Promise<void>) | undefined;
  let debouncer: ConsolidationDebouncer | undefined;

  const bus = new HookBus();
  let extractionIn = 0;
  let extractionOut = 0;

  // agents:resolve → returns the extraction model the Observer calls llm:call with.
  bus.registerService<{ agentId: string; userId: string }, { agent: { model: string } }>(
    'agents:resolve',
    'e2e-agents',
    async () => ({ agent: { model: extractionModel } }),
  );
  // The REAL extraction round-trip, metered.
  bus.registerService<LlmCallInput, LlmCallOutput>(
    'llm:call:anthropic',
    'e2e-llm',
    async (_ctx, input) => {
      const out = await extractionLlm(input);
      extractionIn += out.usage.inputTokens;
      extractionOut += out.usage.outputTokens;
      deps.onExtractionUsage?.({ in: out.usage.inputTokens, out: out.usage.outputTokens });
      return out;
    },
  );
  // tool:register is called by the plugin at init to register memory_search.
  bus.registerService('tool:register', 'e2e-tool-dispatcher', async () => ({ ok: true as const }));

  const strata = createMemoryStrataPlugin({
    // Consolidate immediately after each chat:end so docs/recent are fresh before
    // the next session and before we answer — no debounce-window race in a batch run.
    consolidatorDebounceMs: 0,
    testHooks: {
      onDebouncerCreated(d) {
        debouncer = d;
      },
      onObserverSettleReady(s) {
        settleObserver = s;
      },
      onConsolidationSettleReady(s) {
        settleConsolidation = s;
      },
    },
  });
  const indexer = createMemoryStrataIndexSqlitePlugin({ databasePath: dbPath });

  try {
    await indexer.init?.({ bus, config: {} });
    await strata.init?.({ bus, config: {} });

    const ctx = makeAgentContext({
      sessionId: `${agentId}-session`,
      agentId,
      userId: 'lme-user',
      workspace: { rootPath: workspaceRoot },
    });

    // chat:start seeds the memory tree (system/{agent,user,session}.md).
    await bus.fire('chat:start', ctx, {});

    // Ingest each haystack session as one real chat:end → Observer → consolidator.
    let sessionsIngested = 0;
    for (const session of sample.haystack_sessions) {
      if (deps.shouldStopIngest?.()) break;
      const messages = session
        .map((t) => ({ role: t.role, content: t.content }))
        .filter((m) => m.content.trim().length > 0);
      if (messages.length === 0) continue;
      const outcome: AgentOutcome = { kind: 'complete', messages };
      await bus.fire('chat:end', ctx, { outcome });
      // Drain the detached work deterministically (the isolation.test.ts pattern):
      //   1. Observer is fire-and-forget (I6) → await its settle.
      //   2. Consolidation is debounced (I10) → force-fire the pending 0ms timer
      //      via flush(), THEN await the underlying fs pass via its settle. flush()
      //      alone resolves on the bounded raceTimeout wrapper, not the detached
      //      work, so both steps are required before we touch docs/ or tear down.
      if (settleObserver) await settleObserver(agentId);
      if (debouncer) await debouncer.flush();
      if (settleConsolidation) await settleConsolidation(agentId);
      sessionsIngested += 1;
    }

    // Answer: get the REAL injected block via system-prompt:augment, and give the
    // agent the REAL memory_search over the consolidated sqlite index.
    const augment = await bus.call<
      Record<string, never>,
      { contributions: Array<{ source: string; body: string }> }
    >('system-prompt:augment', ctx, {});
    const injectedMemory = augment.contributions.map((c) => c.body).join('\n\n');

    const search = makeSearchFn(bus, ctx);
    const answer = await answerClient.answer({
      injectedMemory,
      question: sample.question,
      search,
    });

    return {
      questionId: sample.question_id,
      questionType: sample.question_type,
      question: sample.question,
      goldAnswer: sample.answer,
      unanswerable: isUnanswerable(sample.question_id),
      agentAnswer: answer.text,
      answerTokens: answer.usage,
      extractionTokens: { in: extractionIn, out: extractionOut },
      sessionsIngested,
      toolCalls: answer.toolCalls,
    };
  } finally {
    // sqlite indexer holds an open DB handle; close it before removing the dir.
    await indexer.shutdown?.();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

/** Wire a memory_search executor to the plugin's tool:execute:memory_search hook. */
function makeSearchFn(bus: HookBus, ctx: AgentContext) {
  return async (args: { query: string; topK?: number; categoryFilter?: string }) => {
    const out = await bus.call<
      { input: { query: string; topK?: number; categoryFilter?: string } },
      { results: MemorySearchResult[] }
    >('tool:execute:memory_search', ctx, { input: args });
    return out.results;
  };
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}
