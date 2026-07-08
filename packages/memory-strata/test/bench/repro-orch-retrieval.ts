#!/usr/bin/env tsx
// WS1b repro (2026-07-08): settle whether the orchestrator's per-question
// enumeration miss (Revell F-15 kit / $120 helmet) is a RETRIEVAL-recall gap
// (fact captured but not surfaced) or EXTRACTION loss (fact never captured).
// Copies e2e-driver's ingest+answer loop but (a) keeps the workspace, (b) traces
// every orchestrator plan, (c) traces every memory_search, (d) after answering,
// greps the consolidated docs for the target instance AND fires a bullseye
// memory_search for it. Not shipped — a throwaway diagnostic.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
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
import {
  createMemoryStrataPlugin,
  makeXaiOrchestratorClient,
  type OrchestratorClient,
} from '@ax/memory-strata';
import { createMemoryStrataIndexSqlitePlugin } from '@ax/memory-strata-index-sqlite';
import { BenchCache } from './cache.js';
import { loadLongMemEvalSSamples } from './corpora/longmemeval-s.js';
import { makeAnthropicExtractionLlm } from './e2e-cli.js';
import { makeAnthropicAnswerClient, type MemorySearchResult } from './e2e-answer.js';
import { parseCorpusDate } from './e2e-driver.js';

const ANSWER_MODEL = 'claude-sonnet-4-6';
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

// (questionId, needle to grep for in the consolidated docs, bullseye search query)
// False-refusal bucket: single-hop facts the BM25 run abstained on ("I don't
// have any record"). Determine per-question: captured-but-not-retrieved vs
// never-extracted. Run with XAI_API_KEY UNSET to match the BM25 failing path.
const TARGETS: Array<{ qid: string; needle: RegExp; bullseye: string }> = [
  { qid: '6ade9755', needle: /serenity/i, bullseye: 'Serenity Yoga studio where I take yoga classes' },
];

interface ConsolidationDebouncer { flush(): Promise<void>; }

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

async function reproOne(
  sample: Awaited<ReturnType<typeof loadLongMemEvalSSamples>>[number],
  extractionLlm: (input: LlmCallInput) => Promise<LlmCallOutput>,
  answerClient: ReturnType<typeof makeAnthropicAnswerClient>,
  xaiKey: string | undefined,
  needle: RegExp,
  bullseye: string,
): Promise<void> {
  const agentId = `lme-${sample.question_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'repro-orch-'));
  const dbPath = join(workspaceRoot, 'index.db');
  console.log(`\n${'='.repeat(80)}\n[${sample.question_id}] ${sample.question}`);
  console.log(`GOLD: ${sample.answer}`);
  console.log(`path: ${xaiKey ? 'orchestrator' : 'BM25'} | workspace (KEPT): ${workspaceRoot}`);

  // Trace wrapper around the real xAI planner (orchestrator path only).
  const planTrace: Array<{ user: string; text: string }> = [];
  const tracing: OrchestratorClient | undefined = xaiKey
    ? {
        async complete(args) {
          const out = await makeXaiOrchestratorClient(xaiKey).complete(args);
          planTrace.push({ user: args.user, text: out.text });
          return out;
        },
      }
    : undefined;

  let settleObserver: ((agentId: string) => Promise<void>) | undefined;
  let settleConsolidation: ((agentId: string) => Promise<void>) | undefined;
  let debouncer: ConsolidationDebouncer | undefined;
  let fictionNow: Date | null = null;

  const bus = new HookBus();
  bus.registerService<{ agentId: string; userId: string }, { agent: { model: string } }>(
    'agents:resolve', 'e2e-agents', async () => ({ agent: { model: EXTRACTION_MODEL } }),
  );
  bus.registerService<LlmCallInput, LlmCallOutput>(
    'llm:call:anthropic', 'e2e-llm', async (_ctx, input) => extractionLlm(input),
  );
  bus.registerService('tool:register', 'e2e-tool', async () => ({ ok: true as const }));

  const strata = createMemoryStrataPlugin({
    consolidatorDebounceMs: 10 * 60_000, // fix: flush-driven consolidation (see e2e-driver.ts)
    nowFn: () => fictionNow ?? new Date(),
    ...(tracing ? { orchestrator: { client: tracing } } : {}),
    testHooks: {
      onDebouncerCreated(d) { debouncer = d; },
      onObserverSettleReady(s) { settleObserver = s; },
      onConsolidationSettleReady(s) { settleConsolidation = s; },
    },
  });
  const indexer = createMemoryStrataIndexSqlitePlugin({ databasePath: dbPath });

  await indexer.init?.({ bus, config: {} });
  await strata.init?.({ bus, config: {} });

  const ctx = makeAgentContext({
    sessionId: `${agentId}-session`, agentId, userId: 'lme-user',
    workspace: { rootPath: workspaceRoot },
  });
  await bus.fire('chat:start', ctx, {});

  for (const [i, session] of sample.haystack_sessions.entries()) {
    fictionNow = parseCorpusDate(sample.haystack_dates?.[i]);
    const messages = session
      .map((t) => ({ role: t.role, content: t.content }))
      .filter((m) => m.content.trim().length > 0);
    if (messages.length === 0) continue;
    const outcome: AgentOutcome = { kind: 'complete', messages };
    await bus.fire('chat:end', ctx, { outcome });
    if (settleObserver) await settleObserver(agentId);
    if (debouncer) await debouncer.flush();
    if (settleConsolidation) await settleConsolidation(agentId);
  }

  // ---- EVIDENCE 1: was the target instance CAPTURED in the consolidated docs? ----
  const mdFiles = walkMd(workspaceRoot).filter((p) => !p.includes('index.db'));
  const capturedIn: string[] = [];
  for (const f of mdFiles) {
    const body = readFileSync(f, 'utf8');
    if (needle.test(body)) capturedIn.push(f.replace(workspaceRoot, '.'));
  }
  console.log(`\n--- EVIDENCE 1: extraction — docs matching ${needle} ---`);
  console.log(`  total md docs: ${mdFiles.length}`);
  console.log(capturedIn.length ? `  CAPTURED in:\n    ${capturedIn.join('\n    ')}` : `  NOT CAPTURED in any doc → EXTRACTION LOSS`);

  // ---- Answer with orchestrator, tracing memory_search ----
  const augment = await bus.call<Record<string, never>, { contributions: Array<{ body: string }> }>(
    'system-prompt:augment', ctx, {},
  );
  const injectedMemory = augment.contributions.map((c) => c.body).join('\n\n');

  const searchLog: Array<{ query: string; ids: string[] }> = [];
  const search = async (args: { query: string; topK?: number; categoryFilter?: string }) => {
    const out = await bus.call<{ input: typeof args }, { results: MemorySearchResult[] }>(
      'tool:execute:memory_search', ctx, { input: args },
    );
    searchLog.push({ query: args.query, ids: out.results.map((r) => r.docId ?? (r as { id?: string }).id ?? '?') });
    return out.results;
  };
  const readSection = async (args: { docId: string; header?: string }) =>
    bus.call('tool:execute:memory_read_section', ctx, { input: args });

  const answer = await answerClient.answer({
    injectedMemory, question: sample.question,
    ...(sample.question_date !== undefined ? { questionDate: sample.question_date } : {}),
    search, readSection,
  });

  console.log(`\n--- ORCHESTRATOR PLANS (${planTrace.length}) ---`);
  planTrace.forEach((p, i) => console.log(`  plan#${i}: ${p.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`));
  console.log(`\n--- memory_search calls (${searchLog.length}) ---`);
  searchLog.forEach((s, i) => console.log(`  q#${i} "${s.query}" -> [${s.ids.join(', ')}]`));

  // ---- EVIDENCE 2: bullseye search — does memory_search surface the captured doc? ----
  console.log(`\n--- EVIDENCE 2: retrieval — bullseye memory_search "${bullseye}" (topK 20) ---`);
  const bull = await search({ query: bullseye, topK: 20 });
  const hit = bull.some((r) => needle.test(JSON.stringify(r)));
  console.log(`  returned ${bull.length} docs; target present: ${hit ? 'YES' : 'NO'}`);
  bull.slice(0, 8).forEach((r) => console.log(`    - ${(r.docId ?? '?')}: ${(r.snippet ?? r.summary ?? '').replace(/\s+/g, ' ').slice(0, 100)}`));

  console.log(`\n--- FINAL ANSWER (${answer.toolCalls} tool calls) ---`);
  console.log(answer.text.slice(0, 500));

  await indexer.shutdown?.();
  // NOTE: workspace deliberately NOT removed — inspect it at the path above.
}

async function main(): Promise<void> {
  const xaiKey = process.env.XAI_API_KEY || undefined; // unset => BM25 path
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.error('Need ANTHROPIC_API_KEY (+ optional XAI_API_KEY for the orchestrator path).');
    process.exit(2);
  }
  const cache = new BenchCache();
  const samples = await loadLongMemEvalSSamples(cache);
  const extractionLlm = makeAnthropicExtractionLlm(anthropicKey);
  const answerClient = makeAnthropicAnswerClient(anthropicKey, { model: ANSWER_MODEL });
  for (const t of TARGETS) {
    const sample = samples.find((s) => s.question_id === t.qid);
    if (!sample) { console.error(`sample ${t.qid} not found`); continue; }
    await reproOne(sample, extractionLlm, answerClient, xaiKey, t.needle, t.bullseye);
  }
}

void main();
