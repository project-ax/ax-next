// E2E run orchestration (TASK-189). Ties the raw-sample loader → the real-plugin
// driver → the judge → CostMeter → resume JSONL → the standalone report. Invoked
// by `pnpm bench --mode e2e`. Kept out of `cli.ts` so the heavy run lives in one
// testable module and the bench A–E path stays untouched.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import OpenAI from 'openai';
import type { LlmCallInput, LlmCallOutput } from '@ax/core';
import { makeXaiOrchestratorClient, type OrchestratorClient } from '@ax/memory-strata';
import {
  makeAnthropicOrchestratorClient,
  makeOpenRouterOrchestratorClient,
  MINIMAL_REASONING,
} from './orchestrator.js';
import { requireKeys } from './env.js';
import { CostMeter, type Pricing } from './meter.js';
import { runPool } from './pool.js';
import { BenchCache } from './cache.js';
import { withRetry } from './retry.js';
import { loadLongMemEvalSSamples } from './corpora/longmemeval-s.js';
import { selectSamples, seedResumeRows, zeroMatchError } from './e2e-select.js';
import { describeMix } from './stratify.js';
import { judgeAnswer, makeOpenRouterJudgeClient } from './judge.js';
import { makeAnthropicAnswerClient, type E2EAnswerClient } from './e2e-answer.js';
import { runE2EQuestion, DEFAULT_EXTRACTION_MODEL } from './e2e-driver.js';
import type { LongMemEvalSample } from './corpora/longmemeval-s.js';
import { renderE2EReport, type E2EReportRow } from './e2e-report.js';
import { loadResume, appendResume, type E2EResumeRow } from './e2e-resume.js';

const ANSWER_MODEL = 'claude-sonnet-4-6';
const JUDGE_MODEL = 'x-ai/grok-4.3';

// Same per-token pricing rows the bench uses (cli.ts PRICING), scoped to the
// three models e2e mode touches.
/**
 * Exported so a test can assert every selectable planner arm has a row. The
 * planner is metered now (it was not before), so a missing row means
 * `CostMeter.record` throws deep inside a paid run.
 */
export const PRICING: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'claude-haiku-4-5-20251001': { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
  // Base rates from a live GET /api/v1/models. `:nitro` re-sorts the provider
  // pool by throughput and can route to a pricier one, so this is a floor.
  'z-ai/glm-5.3-flash:nitro': { in: 0.15 / 1_000_000, out: 0.5 / 1_000_000 },
};

const E2E_CACHE_ROOT = join(homedir(), '.cache', 'ax-memory-bench', 'longmemeval-s-e2e');

export interface RunE2EOptions {
  repoRoot: string;
  sample: number;
  /**
   * Questions in flight at once. Default 1 — the historical behaviour, kept as
   * the default because concurrency changes how close a run can get to its cost
   * cap (it can overshoot by the questions already dispatched) and how hard it
   * leans on the provider's rate limits. Opt in with `--concurrency`.
   */
  concurrency?: number;
  /** How to draw the question set. See `selectSamples`. Defaults to stratified. */
  selection?: 'stratified' | 'first';
  /**
   * Explicit orchestrator arm. When absent, the legacy XAI_API_KEY-or-BM25
   * behaviour below applies.
   */
  orchestratorModel?: 'haiku' | 'glm';
  cap: number;
  resumeId?: string;
  /**
   * Produce a REPRESENTATIVE report from the deterministic fixture instead of a
   * live paid run. Used to demonstrate "one command produces a report" without
   * API keys (or by an operator who wants the harness shape without spend). The
   * report is clearly labelled fixture-mode; the numbers are illustrative.
   */
  fixture?: boolean;
  /**
   * Opt-in question-type filter (e.g. `['single-session-assistant']`). Applied
   * BEFORE `sample` slices, because the corpus is ordered in type blocks — see
   * e2e-select.ts. Absent = no filter, i.e. today's behavior.
   */
  types?: string[];
  /** Opt-in question-id filter, unioned with `types`. */
  ids?: string[];
  /** Answer-stage arm: append the recall-discipline scaffold (TASK-370). */
  answerScaffold?: boolean;
  /** Answer-stage arm: adaptive thinking at this effort (TASK-371). */
  answerEffort?: 'low' | 'medium' | 'high' | 'max';
}

/**
 * Run the e2e LongMemEval-S eval against the shipped runtime and write the
 * report. Returns a process exit code (0 ok, 1 cap-aborted/partial, 2 missing
 * keys). The report is ALWAYS written — even on a cap abort — so "one command
 * produces a report" holds.
 */
/**
 * Planner ids for `--orchestrator-model` in e2e mode.
 *
 * These are the same two arms bench mode offers, spelled for the clients used
 * here: Anthropic takes a dated id, OpenRouter takes a namespaced one. Both
 * need a PRICING row above — `CostMeter.record` throws on an unknown key, deep
 * inside a paid run.
 */
export const E2E_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const E2E_GLM_MODEL = 'z-ai/glm-5.3-flash:nitro';

export async function runE2EMode(opts: RunE2EOptions): Promise<number> {
  if (opts.fixture) {
    return runFixtureReport(opts);
  }

  const env = requireKeysSoft({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  });
  if (env === null) {
    console.error(
      '--mode e2e needs ANTHROPIC_API_KEY (answer + extraction) and OPENROUTER_API_KEY (judge). ' +
        'Set both, then re-run — or pass --fixture for a representative (illustrative) report ' +
        'without spend. (The harness + its tests run without keys; only a live scored run needs them.)',
    );
    return 2;
  }

  // XAI_API_KEY stays OPTIONAL — the run works BM25-only without it (TASK-190
  // baseline); when present it enables the shipped retrieval orchestrator
  // (TASK-191, direct-xAI client) so the e2e acceptance run can reproduce the
  // spike's directional lift on the shipped pipeline.
  const xaiKey = process.env.XAI_API_KEY;
  let orchestratorClient: OrchestratorClient | undefined;
  let orchestratorModelId: string | undefined;
  /** PRICING key for the planner, when it has one. See `meterOrchestrator`. */
  let orchestratorPricingKey: string | undefined;

  if (opts.orchestratorModel === 'glm') {
    orchestratorModelId = E2E_GLM_MODEL;
    orchestratorPricingKey = E2E_GLM_MODEL;
    // Same pairing production sends (TASK-348): GLM reasons by default, and
    // with reasoning on it measured p50 ~3.4s against a 5s budget whose
    // overrun falls through to BM25 in silence.
    orchestratorClient = makeOpenRouterOrchestratorClient(
      env.OPENROUTER_API_KEY,
      E2E_GLM_MODEL,
      undefined,
      MINIMAL_REASONING,
    );
  } else if (opts.orchestratorModel === 'haiku') {
    orchestratorModelId = E2E_HAIKU_MODEL;
    orchestratorPricingKey = E2E_HAIKU_MODEL;
    orchestratorClient = makeAnthropicOrchestratorClient(env.ANTHROPIC_API_KEY, E2E_HAIKU_MODEL);
  } else if (xaiKey && xaiKey.length > 0) {
    // Legacy path, kept so an existing XAI_API_KEY environment still works. Prefer
    // --orchestrator-model, which names the arm in the report.
    orchestratorModelId = 'grok-4-fast-non-reasoning (direct xAI)';
    orchestratorClient = makeXaiOrchestratorClient(xaiKey);
  }

  if (orchestratorClient) {
    console.log(`Retrieval: orchestrator over system/map.md + BM25 fallback, planner=${orchestratorModelId}.`);
  } else {
    console.log(
      'Retrieval: BM25-only (pass --orchestrator-model haiku|glm to enable the orchestrator path).',
    );
  }
  const retrievalMode: 'orchestrator' | 'bm25' = orchestratorClient ? 'orchestrator' : 'bm25';
  if (orchestratorClient && orchestratorPricingKey === undefined) {
    // The legacy xAI path has no PRICING row, so its planner tokens stay
    // invisible — same as before this arm existed. Say so rather than letting
    // the report's total read as complete.
    console.warn(
      `Note: planner spend for ${orchestratorModelId} is NOT metered (no pricing row); ` +
        'the reported total excludes it. Use --orchestrator-model for a metered arm.',
    );
  }

  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  if (concurrency > 1) {
    console.log(`Concurrency: ${concurrency} questions in flight.`);
  }
  const resumeId = opts.resumeId ?? new Date().toISOString().slice(0, 10);
  const resumePath = join(E2E_CACHE_ROOT, `${resumeId}.jsonl`);
  const done = new Map<string, E2EResumeRow>();
  for (const r of loadResume(resumePath)) done.set(r.questionId, r);
  if (done.size > 0) {
    console.log(`Resuming: ${done.size} questions already scored in ${resumePath}.`);
  }

  const cache = new BenchCache();
  const samples = selectSamples({
    samples: await loadLongMemEvalSSamples(cache),
    limit: opts.sample,
    ...(opts.selection ? { selection: opts.selection } : {}),
    ...(opts.types !== undefined ? { types: opts.types } : {}),
    ...(opts.ids !== undefined ? { ids: opts.ids } : {}),
  });

  // Stamp HOW the set was drawn, not just how many were asked for. `--first`
  // is the type-biased corpus prefix kept for reproducing historical runs;
  // `--types`/`--ids` narrow it further. A report that records only "n=100"
  // cannot be told apart from one measured the other way.
  const sampleNote = (() => {
    const mix = describeMix(samples, (q) => q.question_type);
    const filters = [
      opts.types && opts.types.length > 0 ? `--types ${opts.types.join(',')}` : '',
      opts.ids && opts.ids.length > 0 ? `--ids ${opts.ids.length} id(s)` : '',
    ].filter(Boolean).join(' ');
    const how = filters
      ? `${filters} (filtered, corpus-order)`
      : opts.selection === 'first'
        ? `--first ${opts.sample} (corpus-order prefix, type-biased)`
        : `--sample ${opts.sample} (stratified by question_type)`;
    return `${how} -> ${mix || 'no type labels'}`;
  })();
  if (opts.types !== undefined || opts.ids !== undefined) {
    // Integrity guard (review fix, 2026-07-29): a typo'd --types/--ids value
    // silently selects 0 questions — spend $0 and still render a confident-
    // looking (empty) report unless we refuse outright.
    const zeroErr = zeroMatchError({ types: opts.types, ids: opts.ids, matched: samples.length });
    if (zeroErr !== undefined) {
      console.error(zeroErr);
      return 1;
    }
    console.log(
      `Filtered run: ${samples.length} question(s)` +
        `${opts.types ? ` types=[${opts.types.join(',')}]` : ''}` +
        `${opts.ids ? ` ids=[${opts.ids.join(',')}]` : ''}. ` +
        'NOT comparable to a full-corpus overall score.',
    );
  }

  // The CostMeter guards the NEW work THIS run does. It does not re-seed spend
  // from a prior (resumed) run — the resume rows carry only per-question dollar
  // totals, not the token splits the meter needs, so a resumed run's cap covers
  // only the questions it actually re-runs. The report's totalSpent reflects this
  // run; the prior run's spend is in its own report.
  const meter = new CostMeter({ capDollars: opts.cap, pricing: PRICING });

  const extractionLlm = makeOpenRouterExtractionLlm(env.OPENROUTER_API_KEY);
  const answerClient = makeAnthropicAnswerClient(env.ANTHROPIC_API_KEY, {
    model: ANSWER_MODEL,
    ...(opts.answerScaffold === true ? { scaffold: true } : {}),
    ...(opts.answerEffort !== undefined ? { effort: opts.answerEffort } : {}),
  });
  // Name the arm in the log AND the report command line: an answer-stage arm is
  // invisible in the output otherwise, and a report that does not say which arm
  // produced it is not comparable to anything.
  if (opts.answerScaffold === true || opts.answerEffort !== undefined) {
    console.log(
      `Answer stage: scaffold=${opts.answerScaffold === true}, ` +
        `thinking=${opts.answerEffort !== undefined ? `adaptive/${opts.answerEffort}` : 'off'}.`,
    );
  }
  const judge = makeOpenRouterJudgeClient(env.OPENROUTER_API_KEY, JUDGE_MODEL);

  // Seeded ONLY from resume rows in THIS run's selection (review fix, 2026-07-29)
  // — see seedResumeRows for why an unfiltered seed silently strands another
  // run's rows into this one's per-type table.
  const rows: E2EReportRow[] = seedResumeRows(done, samples);
  const skipped: Array<{ questionId: string; reason: string }> = [];
  let capExceeded = false;
  let abortError: string | null = null;

  // Questions are independent by construction — each gets its own HookBus,
  // workspace, agentId and sqlite file, and every mutable local inside
  // `runE2EQuestion` (the debouncer, the settle hooks, the fiction clock) is
  // scoped to the call. A regression test asserts two samples cannot see each
  // other's memory. That independence is what makes the pool safe; the loop was
  // sequential only because nothing had needed otherwise.
  //
  // Wall-clock matters more here than it looks: a question replays ~48 sessions,
  // each an extraction call plus a consolidation pass that makes LLM calls of
  // its own — roughly 150 round-trips, necessarily ordered WITHIN a question
  // (session N+1's memory must see session N's). Across questions there is no
  // such constraint, so that is where the parallelism goes.
  const pending = samples.filter((sample) => !done.has(sample.question_id));
  try {
    await runPool(
      pending,
      async (sample: LongMemEvalSample) => {
      // Per-question spend, tallied separately from the run meter.
      //
      // `meter.totalDollars() - before` was correct only while questions ran one
      // at a time: with N in flight that delta absorbs every sibling's spend,
      // and the per-question `dollars` on each resume row silently becomes
      // fiction. Both meters see every call; this one is scoped to this
      // question, and its cap is irrelevant (the run meter owns the cap).
      const qMeter = new CostMeter({ capDollars: Number.POSITIVE_INFINITY, pricing: PRICING });
      const record = (model: string, usage: { in: number; out: number }): void => {
        meter.record(model, usage);
        qMeter.record(model, usage);
      };
      try {
        const result = await runE2EQuestion({
          sample,
          extractionLlm,
          answerClient,
          extractionModel: DEFAULT_EXTRACTION_MODEL,
          shouldStopIngest: () =>
            meter.projectWouldExceedCap(DEFAULT_EXTRACTION_MODEL, { in: 2000, out: 256 }),
          onExtractionUsage: (u) => record(DEFAULT_EXTRACTION_MODEL, u),
          // Meter the planner. e2e never did: its tokens were spent and then
          // dropped, so every e2e cost figure this repo published understated
          // the orchestrator path by exactly what that path costs. Wrapped per
          // QUESTION rather than once, so the spend lands on the question that
          // caused it as well as in the run total — with N in flight a single
          // shared wrapper could only manage the latter.
          ...(orchestratorClient && orchestratorPricingKey !== undefined
            ? {
                orchestratorClient: {
                  async complete(args: { system: string; user: string }) {
                    const out = await orchestratorClient.complete(args);
                    record(orchestratorPricingKey, out.usage);
                    return out;
                  },
                },
              }
            : {}),
        });
        record('claude-sonnet-4-6', result.answerTokens);

        const verdict = await judgeAnswer(
          judge,
          result.question,
          result.goldAnswer,
          result.agentAnswer,
          { unanswerable: result.unanswerable },
        );
        record('x-ai/grok-4.3', verdict.usage);

        const row: E2EResumeRow = {
          questionId: result.questionId,
          questionType: result.questionType,
          unanswerable: result.unanswerable,
          verdict: verdict.verdict,
          judgeReason: verdict.reason,
          sessionsIngested: result.sessionsIngested,
          toolCalls: result.toolCalls,
          dollars: qMeter.totalDollars(),
          question: result.question,
          goldAnswer: result.goldAnswer,
          agentAnswer: result.agentAnswer,
        };
        appendResume(resumePath, row);
        rows.push(row);
        if (rows.length % 10 === 0) {
          console.log(`Progress: ${rows.length}/${samples.length} scored, $${meter.totalDollars().toFixed(2)} spent.`);
        }
      } catch (err) {
        const reason = (err as Error)?.message ?? String(err);
        skipped.push({ questionId: sample.question_id, reason });
        console.warn(`Skipped ${sample.question_id}: ${reason}`);
      }
      },
      {
        concurrency,
        // Coarse pre-question cap guard: one e2e question (many haystack
        // sessions × extraction + an answer turn + a judge call) is the unit we
        // refuse to START once we are near the cap. Under concurrency the run
        // can overshoot by at most the cost of the questions already in flight
        // — bounded by `concurrency`, and preferable to killing paid work
        // mid-question.
        shouldStop: () => {
          if (meter.projectWouldExceedCap('claude-sonnet-4-6', { in: 8000, out: 512 })) {
            capExceeded = true;
          }
          return capExceeded;
        },
      },
    );
  } catch (err) {
    abortError = (err as Error)?.message ?? String(err);
    console.error(`Aborted after ${rows.length} results; writing partial report. Reason: ${abortError}`);
  }

  const runDate = new Date();
  const md = renderE2EReport({
    rows,
    runDate,
    requestedSample: opts.sample,
    sampleNote,
    cap: opts.cap,
    totalSpent: meter.totalDollars(),
    capExceeded,
    answerModel: ANSWER_MODEL,
    extractionModel: DEFAULT_EXTRACTION_MODEL,
    judgeModel: JUDGE_MODEL,
    // Every flag that shaped the run. It omitted the planner arm and the
    // concurrency, so the printed command reproduced a DIFFERENT run than the
    // one it was printed on — the default arm, sequential.
    command:
      `pnpm --filter @ax/memory-strata bench --mode e2e --sample ${opts.sample}` +
      `${opts.orchestratorModel ? ` --orchestrator-model ${opts.orchestratorModel}` : ''}` +
      `${concurrency > 1 ? ` --concurrency ${concurrency}` : ''}` +
      `${opts.selection === 'first' ? ` --first ${opts.sample}` : ''}` +
      `${opts.types ? ` --types ${opts.types.join(',')}` : ''}` +
      `${opts.ids ? ` --ids ${opts.ids.join(',')}` : ''}` +
      `${opts.answerScaffold === true ? ' --answer-scaffold' : ''}` +
      `${opts.answerEffort !== undefined ? ` --answer-effort ${opts.answerEffort}` : ''}`,
    abortError,
    skipped,
    retrievalMode,
    ...(orchestratorModelId ? { orchestratorModel: orchestratorModelId } : {}),
  });
  const outPath = join(
    opts.repoRoot,
    'docs/plans',
    `${runDate.toISOString().slice(0, 10)}-memory-strata-e2e-report.md`,
  );
  writeFileSync(outPath, md);
  console.log(`E2E report written to ${outPath}. Total spend: $${meter.totalDollars().toFixed(2)}.`);
  return capExceeded || abortError ? 1 : 0;
}

/*
 * There is deliberately no Anthropic extraction client any more. The one that
 * lived here defaulted to DEFAULT_EXTRACTION_MODEL, which became a GLM id at the
 * 2026-09-14 model policy — so it sent `z-ai/glm-5.3-flash:nitro` to the
 * Anthropic API and 404'd on every call, silently breaking all three repro
 * diagnostics. Extraction has ONE shipped provider; a second client only
 * creates the opportunity to measure a hybrid nothing runs.
 */
/**
 * Extraction LLM on the memory-ops role — OpenRouter + the reasoning shape
 * production sends.
 *
 * The e2e harness exists to run the SHIPPED pipeline, and since the 2026-09-14
 * model policy the shipped Observer runs GLM with `reasoningEffort: 'minimal'`.
 * It is the ONLY extraction client here; see the note above on why the Anthropic
 * one was removed rather than repaired.
 *
 * `reasoning: { effort: 'minimal' }` is sent for the same reason production
 * sends it: GLM reasons by default, and the Observer has a hard timeout whose
 * overrun drops the extraction silently.
 */
export function makeOpenRouterExtractionLlm(
  apiKey: string,
  model = DEFAULT_EXTRACTION_MODEL,
): (input: LlmCallInput) => Promise<LlmCallOutput> {
  const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1', timeout: 60_000 });
  return async (input: LlmCallInput) => {
    return withRetry(
      async () => {
        const messages = [
          ...(input.system !== undefined
            ? [{ role: 'system' as const, content: input.system }]
            : []),
          ...input.messages.map((m) => ({ role: m.role, content: m.content })),
        ];
        const resp = await client.chat.completions.create({
          model: input.model ?? model,
          max_tokens: input.maxTokens ?? 1024,
          messages,
          // OpenRouter accepts `reasoning`; the openai SDK's types do not model
          // it. Cast through unknown so the create() overload still resolves to
          // the non-streaming variant, same escape hatch the orchestrator
          // client uses.
          ...({ reasoning: { effort: input.reasoningEffort ?? 'minimal' } } as unknown as Record<string, never>),
        });
        const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
        return {
          text: resp.choices?.[0]?.message?.content ?? '',
          stopReason: 'end_turn' as const,
          usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
        };
      },
      { attempts: 4, baseDelayMs: 1000, label: 'openrouter-e2e-extraction' },
    );
  };
}


/** Like requireKeys but returns null (instead of throwing) on a miss — lets the
 * caller emit a friendly message + a non-zero exit rather than a stack trace. */
function requireKeysSoft<T extends Record<string, string | undefined>>(
  env: T,
): { [K in keyof T]: string } | null {
  try {
    return requireKeys(env);
  } catch {
    return null;
  }
}

// ── Fixture mode ──────────────────────────────────────────────────────────
// Runs the REAL driver (real Observer + consolidator + inject + memory_search)
// over a tiny built-in corpus, with the two LLM round-trips stubbed
// deterministically. Exercises the whole pipeline end-to-end and produces a
// labelled representative report — no network, no spend, no API keys.

const FIXTURE_SAMPLES: LongMemEvalSample[] = [
  {
    question_id: 'fixture-coffee',
    question_type: 'single-session-preference',
    question: 'What coffee do I prefer?',
    answer: 'Cortados',
    haystack_session_ids: ['s0', 's1'],
    haystack_sessions: [
      [
        { role: 'user', content: 'I always order a cortado when I get coffee.' },
        { role: 'assistant', content: 'Noted — cortado it is.' },
      ],
      [
        { role: 'user', content: 'The weather has been cloudy, unrelated chatter.' },
        { role: 'assistant', content: 'Indeed.' },
      ],
    ],
  },
  {
    question_id: 'fixture-hamster_abs',
    question_type: 'single-session-user',
    question: 'What is my hamster named?',
    answer: 'You did not mention this information.',
    haystack_session_ids: ['s0'],
    haystack_sessions: [
      [
        { role: 'user', content: 'I love my cat Luna.' },
        { role: 'assistant', content: 'Sweet!' },
      ],
    ],
  },
];

async function runFixtureReport(opts: RunE2EOptions): Promise<number> {
  const extractionLlm = async (input: { messages: Array<{ content: string }> }) => {
    const transcript = input.messages.map((m) => m.content).join('\n');
    const facts = /cortado/i.test(transcript)
      ? [{ fact: 'User prefers cortados for coffee.', subject: 'coffee', factType: 'preference', confidence: 0.9 }]
      : [];
    return {
      text: JSON.stringify(facts),
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 50, outputTokens: 20 },
    };
  };
  // A trivial deterministic "agent": answer from the injected block / search.
  const answerClient: E2EAnswerClient = {
    async answer({ injectedMemory, question, search }) {
      const rows = await search({ query: question });
      const found = JSON.stringify(rows).toLowerCase().includes('cortado') ||
        injectedMemory.toLowerCase().includes('cortado');
      const text = found ? 'You prefer cortados.' : "I don't know.";
      return { text, usage: { in: 100, out: 10 }, toolCalls: 1 };
    },
  };

  const rows: E2EReportRow[] = [];
  for (const sample of FIXTURE_SAMPLES) {
    const result = await runE2EQuestion({ sample, extractionLlm, answerClient });
    // Deterministic "judge": cortados → correct; hamster_abs refusal → abstained-correctly.
    const verdict = result.unanswerable
      ? (/don't know|do not/i.test(result.agentAnswer) ? 'abstained-correctly' : 'incorrect')
      : (/cortado/i.test(result.agentAnswer) ? 'correct' : 'incorrect');
    rows.push({
      questionId: result.questionId,
      questionType: result.questionType,
      unanswerable: result.unanswerable,
      verdict,
      judgeReason: 'fixture',
      sessionsIngested: result.sessionsIngested,
      toolCalls: result.toolCalls,
      dollars: 0,
    });
  }

  const runDate = new Date();
  const md = renderE2EReport({
    rows,
    runDate,
    requestedSample: opts.sample,
    cap: opts.cap,
    totalSpent: 0,
    capExceeded: false,
    answerModel: ANSWER_MODEL,
    extractionModel: DEFAULT_EXTRACTION_MODEL,
    judgeModel: JUDGE_MODEL,
    command: 'pnpm --filter @ax/memory-strata bench --mode e2e --fixture',
    fixtureMode: true,
    retrievalMode: 'bm25',
  });
  const outPath = join(
    opts.repoRoot,
    'docs/plans',
    `${runDate.toISOString().slice(0, 10)}-memory-strata-e2e-report.md`,
  );
  writeFileSync(outPath, md);
  console.log(`E2E representative (fixture) report written to ${outPath}.`);
  return 0;
}
