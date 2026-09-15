#!/usr/bin/env tsx
// How much of the MAP does the summary cap throw away?
//
// Run: pnpm --filter @ax/memory-strata bench:diag-map-truncation
//      pnpm --filter @ax/memory-strata bench:diag-map-truncation --probe 60
//
// Companion to `bench:diag-truncation`, one layer up. That one measures the
// answer stage reading a fraction of each document; this one measures the
// PLANNER reading a fraction of each map line. The distinction that matters:
// a truncated body costs you evidence for a document you already chose, while
// a truncated map line costs you the ability to choose the document at all.
//
// Default mode reads the on-disk caches and makes NO API calls. `--probe N`
// adds a small paid sample (N docs x each budget, a few cents) that answers
// the question the cache cannot: the cache stores summaries ALREADY cut, so
// the untruncated length is not recoverable from it. Without the probe you can
// see that the cap binds; only with it can you see how much it is cutting.
import { BenchCache } from './cache.js';
import { loadLongMemEvalS } from './corpora/longmemeval-s.js';
import {
  loadMapRewriteCache,
  MAP_SUMMARY_MAX_CHARS,
  rewriteSystemPrompt,
  cleanSummary,
  withConcurrency,
} from './map-rewrite.js';
import { makeOpenRouterOrchestratorClient, MINIMAL_REASONING } from './orchestrator.js';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const CACHE_ROOT = join(homedir(), '.cache', 'ax-memory-bench');
/** Budgets the probe asks for. 120 is the shipped default. */
const PROBE_BUDGETS = [120, 240, 400];

/**
 * A map line the planner cannot act on: it describes no selectable content.
 *
 * Must NOT be a bare search for "no personal details". A rewriter given room
 * writes informative lines that merely END with that clause — "User asked
 * informational questions about mussel predators, defenses, and toxins; no
 * personal details disclosed." is entirely selectable. Matching the phrase
 * alone counted 1,226 dead lines in the cut-400 map when only 18 were really
 * dead, and it did so in a direction that mattered: the clause is TRUNCATED
 * AWAY at a 120-char cap and survives at 400, so the naive metric reported the
 * map getting worse precisely because it had stopped being mutilated.
 *
 * So: strip the disclaimer clause, then ask whether anything substantive is
 * left. Corrected counts across the live caches — Grok@120 13.6% (not 16.1%),
 * GLM@120 0.3% (not 3.8%), GLM@400 0.1% (not 6.4%).
 */
const DISCLAIMER =
  /\b(?:no|nothing)\s+(?:new\s+|other\s+|further\s+)?(?:personal\s+|substantive\s+|specific\s+)?(?:details?|facts?|information|info|preferences?)[^;.()]*/gi;
const CONTENTLESS = /^(?:user\s+)?(?:greeted?|greeting|hello|hi|test|sent|a|the|message|assistant|only|shared|by)(?:\s+\w+){0,3}$/i;

export function isDeadLine(summary: string): boolean {
  const rest = summary.replace(DISCLAIMER, '').replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (CONTENTLESS.test(rest)) return true;
  return rest.length < 20;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

function describeCache(label: string, path: string): void {
  if (!existsSync(path)) {
    console.log(`  ${label.padEnd(22)} (absent)`);
    return;
  }
  const cache = loadMapRewriteCache(path);
  const summaries = Object.values(cache).map((e) => e.summary);
  if (summaries.length === 0) {
    console.log(`  ${label.padEnd(22)} (empty)`);
    return;
  }
  const lens = summaries.map((s) => s.length);
  // The ellipsis cleanSummary appends is the only reliable marker that a
  // specific line was cut; length alone cannot tell a cut line from one that
  // happened to land on the cap.
  const cut = summaries.filter((s) => s.endsWith('…')).length;
  const dead = summaries.filter(isDeadLine).length;
  console.log(
    `  ${label.padEnd(22)} n=${summaries.length}  cut=${cut} (${((100 * cut) / summaries.length).toFixed(1)}%)` +
      `  dead=${dead} (${((100 * dead) / summaries.length).toFixed(1)}%)` +
      `  len p50=${quantile(lens, 0.5)} p95=${quantile(lens, 0.95)} max=${Math.max(...lens)}`,
  );
}

async function main(): Promise<number> {
  const probeIdx = process.argv.indexOf('--probe');
  const probeN = probeIdx >= 0 ? Number(process.argv[probeIdx + 1] ?? 60) : 0;

  console.log(`Map summary budget in effect: ${MAP_SUMMARY_MAX_CHARS} chars`);
  console.log(`(override with AX_BENCH_MAP_SUMMARY_CHARS)\n`);

  console.log('On-disk map caches (free):');
  const dir = join(CACHE_ROOT, 'longmemeval-s');
  describeCache('map-rewrites.json', join(dir, 'map-rewrites.json'));
  describeCache('grok-may (backup)', join(dir, 'map-rewrites.grok-may.json'));
  describeCache('glm-sept (backup)', join(dir, 'map-rewrites.glm-sept.json.bak'));
  console.log(
    '\n  cut%  = lines ending in the ellipsis cleanSummary appends at the cap.\n' +
      '  dead% = lines with no selectable content once a \"no personal details\" clause\n' +
      '          is removed. A planner cannot route to those, so they cost recall the\n' +
      '          same way truncation does. Matching that phrase ALONE overcounts badly:\n' +
      '          an informative line often ends with it, and the clause survives a\n' +
      '          bigger cap \u2014 which made the naive metric report a map getting worse\n' +
      '          exactly because it had stopped being truncated.',
  );

  if (probeN <= 0) {
    console.log(
      '\nNo probe run. The caches store summaries ALREADY truncated, so the natural\n' +
        'length cannot be recovered from them — pass `--probe N` (a few cents) to\n' +
        'measure what the model writes when the cap is not applied.',
    );
    return 0;
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error('\n--probe needs OPENROUTER_API_KEY.');
    return 2;
  }

  const corpus = await loadLongMemEvalS(new BenchCache());
  const docs = [...corpus.memoryTree.values()];
  // Evenly spaced, not the first N: the corpus is ordered, and a prefix of it
  // is a sample of one region. Same reasoning as `stratify.ts`.
  const step = docs.length / probeN;
  const sample = Array.from({ length: probeN }, (_, i) => docs[Math.floor(i * step)]!);
  const client = makeOpenRouterOrchestratorClient(key, undefined, undefined, MINIMAL_REASONING);

  console.log(`\nProbing ${sample.length} docs at budgets ${PROBE_BUDGETS.join(', ')} (untruncated)...`);
  for (const budget of PROBE_BUDGETS) {
    const raw = await withConcurrency(sample, 8, async (doc) => {
      const resp = await client.complete({
        system: rewriteSystemPrompt(budget),
        user: `Conversation:\n${doc.body}`,
      });
      // cleanSummary with an effectively infinite cap: strip the fences and
      // collapse to one line exactly as the real path does, but do NOT cut.
      return cleanSummary(resp.text, Number.MAX_SAFE_INTEGER);
    });
    const lens = raw.map((s) => s.length);
    const overBudget = lens.filter((n) => n > budget).length;
    const wouldCut = lens.filter((n) => n > MAP_SUMMARY_MAX_CHARS).length;
    const lost = lens.reduce((a, n) => a + Math.max(0, n - MAP_SUMMARY_MAX_CHARS), 0);
    const total = lens.reduce((a, n) => a + n, 0);
    console.log(
      `  asked <=${String(budget).padStart(3)}  ->  p50=${quantile(lens, 0.5)} p95=${quantile(lens, 0.95)} ` +
        `max=${Math.max(...lens)}  over-its-own-budget=${((100 * overBudget) / lens.length).toFixed(0)}%  ` +
        `cut at ${MAP_SUMMARY_MAX_CHARS}=${((100 * wouldCut) / lens.length).toFixed(0)}%  ` +
        `chars lost=${((100 * lost) / total).toFixed(1)}%`,
    );
  }
  console.log(
    '\n"over-its-own-budget" is the number that decides whether raising the prompt\n' +
      'budget is enough on its own: a model that ignores <=120 will ignore <=400 too,\n' +
      'and then only the hard cut is doing the work.',
  );
  return 0;
}

// Only when run as a script. Importing this module (the unit test does, for
// `isDeadLine`) must not kick off a corpus load and a paid probe.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
}
