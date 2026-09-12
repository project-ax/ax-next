#!/usr/bin/env tsx
// How much of the answer's evidence does the bench's truncation throw away?
//
// Run: pnpm --filter @ax/memory-strata bench:diag-truncation
//
// Context: once the map format was fixed (2026-09-11), retrieval put the gold
// doc in the top 5 on ~91-94% of questions while only ~33-36% of answers came
// out right. Something between "the right document was retrieved" and "the
// answer is correct" was dropping ~58 points, and the bench's answer stage
// truncates every injected body to MAX_INJECTED_BODY_CHARS.
//
// Measured 2026-09-12 at the 2000-char default: the median gold body is 14,424
// chars, 99.6% of gold docs are cut, and on 17.0% of questions EVERY matching
// answer token sits past the cut. The agent was being asked to answer from the
// first 14% of the document.
//
// Note what this is NOT: production does not inject fixed-size truncated
// bodies. `memory_search` returns snippets + matchedFacts and the agent drills
// in with `memory_read_section`. This measures a property of the BENCH's
// single-shot answer stage, which is why bench accuracy is a floor rather than
// a product number — `--mode e2e` is the production-faithful path.
//
// No API calls. Pure corpus arithmetic.
import { BenchCache } from './cache.js';
import { loadLongMemEvalS } from './corpora/longmemeval-s.js';
import { MAX_INJECTED_BODY_CHARS } from './agent.js';

const STOP = new Set([
  'the','a','an','and','or','but','of','to','in','on','at','for','with','was','were','is','are',
  'he','she','they','it','his','her','their','you','your','user','that','this','have','has','had',
  'about','from','they','them','then','there','which','what','when','where','who','how','why',
  'said','says','mentioned','also','been','being','would','could','should','will','shall','into',
]);

function contentTokens(value: unknown): string[] {
  // Gold answers are not always strings — LongMemEval carries numbers and
  // occasional arrays. Flatten to text rather than crashing on the outlier.
  const s = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  const seen = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9$]+/)) {
    if (raw.length < 4) continue;
    if (STOP.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

const corpus = await loadLongMemEvalS(new BenchCache());
const cut = MAX_INJECTED_BODY_CHARS;

let goldDocs = 0;
let truncated = 0;
const lens: number[] = [];
let questionsWithGold = 0;
let questionsEvidenceLost = 0;
let questionsEvidencePartial = 0;

for (const q of corpus.questions) {
  const gold = (q.goldDocIds ?? []).map((p) => corpus.memoryTree.get(p)).filter((d) => d !== undefined);
  if (gold.length === 0) continue;
  questionsWithGold += 1;

  const toks = contentTokens(q.goldAnswer);
  let anyTokenSurvives = false;
  let anyTokenLost = false;

  for (const doc of gold) {
    goldDocs += 1;
    lens.push(doc!.body.length);
    if (doc!.body.length > cut) truncated += 1;
    const head = doc!.body.slice(0, cut).toLowerCase();
    const full = doc!.body.toLowerCase();
    for (const t of toks) {
      if (!full.includes(t)) continue;
      if (head.includes(t)) anyTokenSurvives = true;
      else anyTokenLost = true;
    }
  }
  if (anyTokenLost && !anyTokenSurvives) questionsEvidenceLost += 1;
  else if (anyTokenLost) questionsEvidencePartial += 1;
}

lens.sort((a, b) => a - b);
const pct = (p: number) => lens[Math.min(lens.length - 1, Math.floor(p * lens.length))]!;
const fmt = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;

console.log(`MAX_INJECTED_BODY_CHARS = ${cut}`);
console.log(`gold docs: ${goldDocs} across ${questionsWithGold} questions`);
console.log(`body chars  p50=${pct(0.5)}  p75=${pct(0.75)}  p90=${pct(0.9)}  p99=${pct(0.99)}  max=${lens[lens.length - 1]}`);
console.log(`gold docs TRUNCATED at the cut: ${truncated}/${goldDocs} (${fmt(truncated, goldDocs)})`);
console.log('');
console.log('Answer-token survival (proxy for "is the evidence still visible?"):');
console.log(`  every matching answer token lost to the cut : ${questionsEvidenceLost} (${fmt(questionsEvidenceLost, questionsWithGold)})`);
console.log(`  some lost, some survive                     : ${questionsEvidencePartial} (${fmt(questionsEvidencePartial, questionsWithGold)})`);
