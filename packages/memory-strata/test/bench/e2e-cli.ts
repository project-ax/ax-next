// E2E run orchestration (TASK-189). Ties the raw-sample loader → the real-plugin
// driver → the judge → CostMeter → resume JSONL → the standalone report. Invoked
// by `pnpm bench --mode e2e`. Kept out of `cli.ts` so the heavy run lives in one
// testable module and the bench A–E path stays untouched.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmCallInput, LlmCallOutput } from '@ax/core';
import { makeXaiOrchestratorClient } from '@ax/memory-strata';
import { requireKeys } from './env.js';
import { CostMeter, type Pricing } from './meter.js';
import { BenchCache } from './cache.js';
import { withRetry } from './retry.js';
import { loadLongMemEvalSSamples } from './corpora/longmemeval-s.js';
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
const PRICING: Pricing = {
  'claude-sonnet-4-6': { in: 3 / 1_000_000, out: 15 / 1_000_000 },
  'claude-haiku-4-5-20251001': { in: 1 / 1_000_000, out: 5 / 1_000_000 },
  'x-ai/grok-4.3': { in: 1.25 / 1_000_000, out: 2.5 / 1_000_000 },
};

const E2E_CACHE_ROOT = join(homedir(), '.cache', 'ax-memory-bench', 'longmemeval-s-e2e');

export interface RunE2EOptions {
  repoRoot: string;
  sample: number;
  cap: number;
  resumeId?: string;
  /**
   * Produce a REPRESENTATIVE report from the deterministic fixture instead of a
   * live paid run. Used to demonstrate "one command produces a report" without
   * API keys (or by an operator who wants the harness shape without spend). The
   * report is clearly labelled fixture-mode; the numbers are illustrative.
   */
  fixture?: boolean;
}

/**
 * Run the e2e LongMemEval-S eval against the shipped runtime and write the
 * report. Returns a process exit code (0 ok, 1 cap-aborted/partial, 2 missing
 * keys). The report is ALWAYS written — even on a cap abort — so "one command
 * produces a report" holds.
 */
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
  const orchestratorClient = xaiKey && xaiKey.length > 0 ? makeXaiOrchestratorClient(xaiKey) : undefined;
  if (orchestratorClient) {
    console.log(
      'Retrieval: orchestrator (direct xAI). ~400ms p50 per the n=500 spike (NOT OpenRouter ' +
        'default routing, which was the ~11s artifact).',
    );
  } else {
    console.log('Retrieval: BM25-only (set XAI_API_KEY to enable the direct-xAI orchestrator path).');
  }
  const retrievalMode: 'orchestrator' | 'bm25' = orchestratorClient ? 'orchestrator' : 'bm25';

  const resumeId = opts.resumeId ?? new Date().toISOString().slice(0, 10);
  const resumePath = join(E2E_CACHE_ROOT, `${resumeId}.jsonl`);
  const done = new Map<string, E2EResumeRow>();
  for (const r of loadResume(resumePath)) done.set(r.questionId, r);
  if (done.size > 0) {
    console.log(`Resuming: ${done.size} questions already scored in ${resumePath}.`);
  }

  const cache = new BenchCache();
  const samples = (await loadLongMemEvalSSamples(cache)).slice(0, opts.sample);

  // The CostMeter guards the NEW work THIS run does. It does not re-seed spend
  // from a prior (resumed) run — the resume rows carry only per-question dollar
  // totals, not the token splits the meter needs, so a resumed run's cap covers
  // only the questions it actually re-runs. The report's totalSpent reflects this
  // run; the prior run's spend is in its own report.
  const meter = new CostMeter({ capDollars: opts.cap, pricing: PRICING });

  const extractionLlm = makeAnthropicExtractionLlm(env.ANTHROPIC_API_KEY);
  const answerClient = makeAnthropicAnswerClient(env.ANTHROPIC_API_KEY, { model: ANSWER_MODEL });
  const judge = makeOpenRouterJudgeClient(env.OPENROUTER_API_KEY, JUDGE_MODEL);

  const rows: E2EReportRow[] = [...done.values()];
  const skipped: Array<{ questionId: string; reason: string }> = [];
  let capExceeded = false;
  let abortError: string | null = null;

  try {
    for (const sample of samples) {
      if (done.has(sample.question_id)) continue;
      // Coarse pre-question cap guard: a single e2e question (many haystack
      // sessions × extraction + an answer turn + a judge call) is the unit we
      // refuse to start once we're near the cap.
      if (meter.projectWouldExceedCap('claude-sonnet-4-6', { in: 8000, out: 512 })) {
        capExceeded = true;
        break;
      }
      try {
        const before = meter.totalDollars();
        const result = await runE2EQuestion({
          sample,
          extractionLlm,
          answerClient,
          extractionModel: DEFAULT_EXTRACTION_MODEL,
          shouldStopIngest: () =>
            meter.projectWouldExceedCap('claude-haiku-4-5-20251001', { in: 2000, out: 256 }),
          onExtractionUsage: (u) => meter.record('claude-haiku-4-5-20251001', u),
          ...(orchestratorClient ? { orchestratorClient } : {}),
        });
        meter.record('claude-sonnet-4-6', result.answerTokens);

        const verdict = await judgeAnswer(
          judge,
          result.question,
          result.goldAnswer,
          result.agentAnswer,
          { unanswerable: result.unanswerable },
        );
        meter.record('x-ai/grok-4.3', verdict.usage);

        const row: E2EResumeRow = {
          questionId: result.questionId,
          questionType: result.questionType,
          unanswerable: result.unanswerable,
          verdict: verdict.verdict,
          judgeReason: verdict.reason,
          sessionsIngested: result.sessionsIngested,
          toolCalls: result.toolCalls,
          dollars: meter.totalDollars() - before,
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
    }
  } catch (err) {
    abortError = (err as Error)?.message ?? String(err);
    console.error(`Aborted after ${rows.length} results; writing partial report. Reason: ${abortError}`);
  }

  const runDate = new Date();
  const md = renderE2EReport({
    rows,
    runDate,
    requestedSample: opts.sample,
    cap: opts.cap,
    totalSpent: meter.totalDollars(),
    capExceeded,
    answerModel: ANSWER_MODEL,
    extractionModel: DEFAULT_EXTRACTION_MODEL,
    judgeModel: JUDGE_MODEL,
    command: `pnpm --filter @ax/memory-strata bench --mode e2e --sample ${opts.sample}`,
    abortError,
    skipped,
    retrievalMode,
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

/**
 * Build a real Anthropic extraction round-trip in the `LlmCallInput → LlmCallOutput`
 * shape the Observer expects (provider-agnostic kernel contract). The Observer
 * passes `model` (Haiku), `system`, `messages`, `maxTokens`, `temperature`.
 */
export function makeAnthropicExtractionLlm(apiKey: string): (input: LlmCallInput) => Promise<LlmCallOutput> {
  const a = new Anthropic({ apiKey });
  return async (input: LlmCallInput) => {
    return withRetry(
      async () => {
        const resp = await a.messages.create({
          model: input.model ?? DEFAULT_EXTRACTION_MODEL,
          max_tokens: input.maxTokens ?? 1024,
          ...(input.system !== undefined ? { system: input.system } : {}),
          messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        });
        const text = resp.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('');
        return {
          text,
          stopReason: 'end_turn' as const,
          usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
        };
      },
      { attempts: 4, baseDelayMs: 1000, label: 'anthropic-e2e-extraction' },
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
