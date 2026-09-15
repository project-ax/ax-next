#!/usr/bin/env tsx
// Live extraction repro (2026-07-29). Runs the REAL Observer over the haystack
// sessions of known-failing single-session-assistant questions and prints every
// extracted fact, so we can see whether assistant-provided content survives
// extraction — WITHOUT a $15 scored run.
//
// Runs on the SHIPPED memory-ops model (GLM 5.3 Flash via OpenRouter). It used
// to build an Anthropic client while passing it DEFAULT_EXTRACTION_MODEL, which
// became a GLM id at the 2026-09-14 model-policy change — so every invocation
// since has 404'd at the Anthropic API. Nothing caught it because a diagnostic
// has no test and no gate; it just stopped being runnable.
//
// For the consolidated side of the pipeline — whether a fact the Observer DID
// extract survives into the tree the agent retrieves from — see
// `diag-detail-loss.ts`, which dumps both layers.
//
// A stubbed-LLM unit test proves the plumbing (an 'answer' factType survives parse
// → write → cluster). It cannot prove Haiku COMPLIES with the prompt. This does.
//
// Usage:
//   set -a; source .env.walk; set +a
//   pnpm --filter @ax/memory-strata exec tsx test/bench/repro-extract.ts [questionId...]
//
// Defaults to the three canonical failures from bm25-full-fixed.jsonl:
//   89527b6b  "what color was the scaly body of the Plesiosaur"  → blue
//   1903aded  "what was the 7th job in the list you provided"    → Transcriptionist
//   6ae235be  "processes used at the Lake Charles Refinery"      → distillation/FCC/…

import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runObserver } from '../../src/observer.js';
import { INBOX_DIR } from '../../src/paths.js';
import { BenchCache } from './cache.js';
import { loadLongMemEvalSSamples } from './corpora/longmemeval-s.js';
import { selectSamples } from './e2e-select.js';
import { makeOpenRouterExtractionLlm, PRICING } from './e2e-cli.js';
import { DEFAULT_EXTRACTION_MODEL, parseCorpusDate } from './e2e-driver.js';

const DEFAULT_IDS = ['89527b6b', '1903aded', '6ae235be'];

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY required (set -a; source .env.walk; set +a)');
  process.exit(2);
}

const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_IDS;
const samples = selectSamples({
  samples: await loadLongMemEvalSSamples(new BenchCache()),
  ids,
  limit: ids.length,
});
if (samples.length === 0) {
  console.error(`No samples matched ids: ${ids.join(', ')}`);
  process.exit(2);
}

const llm = makeOpenRouterExtractionLlm(apiKey);
let totalIn = 0;
let totalOut = 0;

for (const sample of samples) {
  console.log(`\n${'='.repeat(72)}\n${sample.question_id} — ${sample.question}`);
  console.log(`GOLD: ${sample.answer}`);
  const ws = await mkdtemp(join(tmpdir(), 'repro-extract-'));
  try {
    for (const [i, session] of sample.haystack_sessions.entries()) {
      const messages = session
        .map((t) => ({ role: t.role, content: t.content }))
        .filter((m) => m.content.trim().length > 0);
      if (messages.length === 0) continue;
      const result = await runObserver({
        messages,
        llmCall: async (input) => {
          const out = await llm(input);
          totalIn += out.usage.inputTokens;
          totalOut += out.usage.outputTokens;
          return out;
        },
        workspaceRoot: ws,
        now: parseCorpusDate(sample.haystack_dates?.[i]) ?? new Date(),
        timeoutMs: 60_000,
        model: DEFAULT_EXTRACTION_MODEL,
      });
      if (result.kind !== 'written') {
        console.log(`  session ${i}: ${result.kind}`);
      }
    }
    // Print every extracted fact. `- ` bodies are what the consolidator promotes.
    const names = await readdir(join(ws, INBOX_DIR)).catch(() => [] as string[]);
    console.log(`  ${names.length} fact(s) extracted:`);
    for (const n of names.sort()) {
      const raw = await readFile(join(ws, INBOX_DIR, n), 'utf8');
      const summary = /^summary:\s*(.*)$/m.exec(raw)?.[1] ?? '(no summary)';
      const factType = /^factType:\s*(.*)$/m.exec(raw)?.[1] ?? '?';
      console.log(`    [${factType}] ${summary}`);
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

// Priced off the shared PRICING table rather than a second copy of the rates,
// which is how this file came to advertise Haiku's price for a GLM call.
const price = PRICING[DEFAULT_EXTRACTION_MODEL];
if (price === undefined) throw new Error(`No PRICING row for ${DEFAULT_EXTRACTION_MODEL}`);
const dollars = totalIn * price.in + totalOut * price.out;
console.log(`\nTokens: ${totalIn} in / ${totalOut} out — ~$${dollars.toFixed(4)}`);
