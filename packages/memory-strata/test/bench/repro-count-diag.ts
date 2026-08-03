#!/usr/bin/env tsx
// Counting-failure diagnostic (2026-07-09): for a multi-session COUNT question,
// dump (1) every consolidated doc + the fact lines matching the class, so we can
// count the instances actually IN memory, (2) what memory_search returns for the
// counting query, (3) the agent's answer. Distinguishes undercount/overcount
// rooted in retrieval/extraction (wrong instance set in docs / search) vs
// answer-side reasoning (right set, wrong count). BM25 path (XAI unset) to match
// the failing run. Keeps the workspace. Usage: tsx repro-count-diag.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookBus, makeAgentContext, type AgentOutcome,
  type LlmCallInput, type LlmCallOutput,
} from '@ax/core';
import { createMemoryStrataPlugin } from '@ax/memory-strata';
import { createMemoryStrataIndexSqlitePlugin } from '@ax/memory-strata-index-sqlite';
import { BenchCache } from './cache.js';
import { loadLongMemEvalSSamples } from './corpora/longmemeval-s.js';
import { makeAnthropicExtractionLlm } from './e2e-cli.js';
import { makeAnthropicAnswerClient, type MemorySearchResult } from './e2e-answer.js';
import { parseCorpusDate } from './e2e-driver.js';

const ANSWER_MODEL = 'claude-sonnet-4-6';
const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

// (qid, gold, class-needle to find instance fact-lines, extra enumeration query)
const TARGETS = [
  { qid: '6d550036', gold: '2', needle: /project|led|leading|lead\b/i, enumQuery: 'projects I led or am leading' },      // OVERCOUNT 2->7
  { qid: 'd682f1a2', gold: '3', needle: /delivery|uber eats|doordash|grubhub|fresh fusion|meal/i, enumQuery: 'food delivery services used' }, // UNDERCOUNT 3->2
];

interface Debouncer { flush(): Promise<void>; }
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.md')) out.push(p);
  }
  return out;
};
const factLines = (body: string): string[] =>
  body.split('\n').filter((l) => /^\s*[-*]\s|\(\d{4}-\d{2}-\d{2}\)/.test(l));

async function diag(sample: Awaited<ReturnType<typeof loadLongMemEvalSSamples>>[number],
                    extractionLlm: (i: LlmCallInput) => Promise<LlmCallOutput>,
                    answerClient: ReturnType<typeof makeAnthropicAnswerClient>,
                    needle: RegExp, gold: string, enumQuery: string): Promise<void> {
  const agentId = `lme-${sample.question_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`;
  const ws = await mkdtemp(join(tmpdir(), 'repro-count-'));
  console.log(`\n${'#'.repeat(80)}\n[${sample.question_id}] ${sample.question}\nGOLD: ${gold} | ws: ${ws}`);

  let settleObs: ((a: string) => Promise<void>) | undefined;
  let settleCon: ((a: string) => Promise<void>) | undefined;
  let deb: Debouncer | undefined;
  let fnow: Date | null = null;
  const bus = new HookBus();
  bus.registerService('agents:resolve', 'x', async () => ({ agent: { model: EXTRACTION_MODEL } }));
  bus.registerService<LlmCallInput, LlmCallOutput>('llm:call:anthropic', 'x', async (_c, i) => extractionLlm(i));
  bus.registerService('tool:register', 'x', async () => ({ ok: true as const }));
  const strata = createMemoryStrataPlugin({
    consolidatorDebounceMs: 10 * 60_000, nowFn: () => fnow ?? new Date(),
    testHooks: {
      onDebouncerCreated(d) { deb = d as Debouncer; },
      onObserverSettleReady(s) { settleObs = s; },
      onConsolidationSettleReady(s) { settleCon = s; },
    },
  });
  const indexer = createMemoryStrataIndexSqlitePlugin({ databasePath: join(ws, 'index.db') });
  await indexer.init?.({ bus, config: {} });
  await strata.init?.({ bus, config: {} });
  const ctx = makeAgentContext({ sessionId: `${agentId}-s`, agentId, userId: 'lme-user', workspace: { rootPath: ws } });
  await bus.fire('chat:start', ctx, {});
  for (const [i, session] of sample.haystack_sessions.entries()) {
    fnow = parseCorpusDate(sample.haystack_dates?.[i]);
    const messages = session.map((t) => ({ role: t.role, content: t.content })).filter((m) => m.content.trim());
    if (!messages.length) continue;
    await bus.fire('chat:end', ctx, { outcome: { kind: 'complete', messages } as AgentOutcome });
    if (settleObs) await settleObs(agentId);
    if (deb) await deb.flush();
    if (settleCon) await settleCon(agentId);
  }

  // EVIDENCE: instances actually in memory (docs whose fact-lines match the class).
  const docs = walk(join(ws, 'permanent/memory/docs'));
  console.log(`\n--- CLASS INSTANCES IN MEMORY (docs matching ${needle}) ---`);
  let hits = 0;
  for (const f of docs) {
    const rel = f.replace(ws, '.');
    const body = readFileSync(f, 'utf8');
    const matched = factLines(body).filter((l) => needle.test(l));
    if (matched.length) {
      hits += matched.length;
      console.log(`  ${rel}:`);
      matched.forEach((l) => console.log(`      ${l.trim().slice(0, 120)}`));
    }
  }
  console.log(`  >>> ${hits} class-matching fact-lines across ${docs.length} docs (gold count = ${gold})`);

  // EVIDENCE: what search returns for the counting query.
  const search = async (a: { query: string; topK?: number; categoryFilter?: string }) => {
    const o = await bus.call<{ input: typeof a }, { results: MemorySearchResult[] }>('tool:execute:memory_search', ctx, { input: a });
    return o.results;
  };
  const readSection = async (a: { docId: string; header?: string }) => bus.call('tool:execute:memory_read_section', ctx, { input: a });
  const rows = await search({ query: enumQuery, topK: 20 });
  console.log(`\n--- memory_search("${enumQuery}", topK20) -> ${rows.length} docs ---`);
  rows.forEach((r) => console.log(`   ${r.docId}: ${(r.snippet ?? r.summary ?? '').replace(/\s+/g, ' ').slice(0, 90)}`));

  const augment = await bus.call<Record<string, never>, { contributions: Array<{ body: string }> }>('system-prompt:augment', ctx, {});
  const answer = await answerClient.answer({
    injectedMemory: augment.contributions.map((c) => c.body).join('\n\n'),
    question: sample.question,
    ...(sample.question_date !== undefined ? { questionDate: sample.question_date } : {}),
    search, readSection,
  });
  console.log(`\n--- ANSWER (${answer.toolCalls} tools) ---\n${answer.text.slice(0, 600)}`);
  await indexer.shutdown?.();
}

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error('need ANTHROPIC_API_KEY'); process.exit(2); }
  const samples = await loadLongMemEvalSSamples(new BenchCache());
  const extractionLlm = makeAnthropicExtractionLlm(key);
  const answerClient = makeAnthropicAnswerClient(key, { model: ANSWER_MODEL });
  for (const t of TARGETS) {
    const s = samples.find((x) => x.question_id === t.qid);
    if (!s) { console.error(`missing ${t.qid}`); continue; }
    await diag(s, extractionLlm, answerClient, t.needle, t.gold, t.enumQuery);
  }
}
void main();
