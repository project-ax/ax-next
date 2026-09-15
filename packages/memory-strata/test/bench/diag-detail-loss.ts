#!/usr/bin/env tsx
// Where is the specific value lost — extraction, consolidation, or neither?
// (TASK-361.)
//
// Run:
//   set -a && . ./.env.walk && set +a
//   pnpm --filter @ax/memory-strata bench:diag-detail-loss
//
// All 9 false refusals in the 2026-09-14 e2e run share one shape: the agent
// retrieves the right document and narrates that the specific value is not in
// it. Mean toolCalls on those rows is 2.9, the highest of any verdict — it
// searches HARDER and still finds only the topic. So the failure is upstream of
// retrieval, in what memory kept. The resume JSONL cannot say which half:
//
//   extraction    the Observer never wrote the value down
//   consolidation the Observer caught it; the tree the agent reads did not keep it
//   retained      memory HAS it, so the failure is retrieval or the answer stage
//
// Those are three different fixes, which is why this dumps the layers rather
// than only scoring them: `--out-dir` writes the extracted facts and the whole
// consolidated tree per question, so a verdict can be read back rather than
// trusted.
//
// COST: this runs the REAL Observer + consolidator over every haystack session,
// so it is not free — but it pays only for extraction (GLM 5.3 Flash), never for
// the Sonnet answer or the judge. ~$0.02/question. The handoff that scoped this
// card said "no API calls"; that was wrong, because `docs/` does not exist until
// the pipeline has run and the e2e harness deletes its workspace on the way out.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INBOX_DIR, MEMORY_ROOT } from '../../src/paths.js';
import { BenchCache } from './cache.js';
import { loadLongMemEvalSSamples } from './corpora/longmemeval-s.js';
import { selectSamples, parseCsvFlag } from './e2e-select.js';
import { makeOpenRouterExtractionLlm } from './e2e-cli.js';
import { PRICING } from './e2e-cli.js';
import { CostMeter } from './meter.js';
import { runE2EQuestion, DEFAULT_EXTRACTION_MODEL } from './e2e-driver.js';
import { classifyDetailLoss, probeRetrievability, type DetailLossResult } from './detail-loss.js';
import type { E2EAnswerClient } from './e2e-answer.js';

/** The 9 `abstained-incorrectly` rows of the 2026-09-14 n=100 e2e run. */
const DEFAULT_IDS = [
  '7024f17c', 'gpt4_fa19884d', 'gpt4_5dcc0aab', '993da5e2', 'gpt4_5438fa52',
  '0e5e2d1a', '352ab8bd', '5809eb10', 'eaca4986',
];

/**
 * Exact probes, because the gold ANSWER is often not the thing memory had to keep.
 *
 * **Probe the evidence required to answer, not the answer string.** Getting this
 * wrong scored `gpt4_5438fa52` as `retained`: its gold is "Spanish classes",
 * which memory has, while the half that went missing is the CULTURAL FESTIVAL
 * the question compares it against — absent from the tree entirely. A probe
 * aimed at the gold string reports a healthy pipeline on a question the pipeline
 * failed.
 *
 * Three reasons a question needs an explicit probe:
 *  - the answer is not made of words ("C D E F G A B A G F E D C");
 *  - the answer is DERIVED, so the corpus never contains it and the evidence is
 *    what mattered: "0.5 hours" comes from a 30-minute jog, "one week" from a rug
 *    bought a month ago against a rearrangement three weeks ago;
 *  - the question COMPARES two events, so both have to be present and only one
 *    of them is in the gold answer.
 */
const NEEDLES: Record<string, string[]> = {
  '7024f17c': ['30-minute jog', '30 minutes'],
  '993da5e2': ['area rug'],
  eaca4986: ['C D E F G A B A G F E D C'],
  'gpt4_5dcc0aab': ['cleaned', 'Adidas'],
  'gpt4_fa19884d': ['bluegrass'],
  // Comparison question: the festival is the half that has to survive too.
  'gpt4_5438fa52': ['cultural festival', 'Spanish class'],
  '0e5e2d1a': ['38 subjects'],
  '352ab8bd': ['20%', 'HAMT'],
  // A bare year has no context and matched an unrelated novel's publication
  // date; the phrase around it is the probe.
  '5809eb10': ['began in 2014', 'construction of the house'],
};

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const ids = parseCsvFlag(flag('ids')) ?? DEFAULT_IDS;
const outDir = flag('out-dir');
/**
 * Re-score trees a previous run already dumped. FREE — no ingest, no API calls.
 * The ingest is the only paid part, and its output is deterministic once
 * written, so re-asking a question of the same trees should not cost again. It
 * is also how a verdict stays checkable after the fact: the dumps are the
 * evidence, and this re-reads them rather than asking anyone to trust a table.
 */
const fromDump = flag('from-dump');

const apiKey = process.env.OPENROUTER_API_KEY;
if (fromDump === undefined && (apiKey === undefined || apiKey === '')) {
  console.error('OPENROUTER_API_KEY required (set -a && . ./.env.walk && set +a), or pass --from-dump');
  process.exit(2);
}

const samples = selectSamples({
  samples: await loadLongMemEvalSSamples(new BenchCache()),
  ids,
  limit: ids.length,
});
if (samples.length === 0) {
  console.error(`No samples matched ids: ${ids.join(', ')}`);
  process.exit(2);
}

const extractionLlm = makeOpenRouterExtractionLlm(apiKey ?? '');
const meter = new CostMeter({ capDollars: Number.POSITIVE_INFINITY, pricing: PRICING });

/** No answer stage: this diagnostic measures what memory KEPT, not what the
 *  agent then said about it, and Sonnet is ~70% of an e2e run's bill. */
const noAnswer: E2EAnswerClient = {
  async answer() {
    return { text: '', usage: { in: 0, out: 0 }, toolCalls: 0 };
  },
};

/** Inverse of the `--- <path>` join below, so a dump round-trips to a tree. */
function parseDumpedTree(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^--- /m)) {
    if (part.trim().length === 0) continue;
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    out.set(part.slice(0, nl), part.slice(nl + 1));
  }
  return out;
}

async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const names = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out.set(full.slice(root.length + 1), await readFile(full, 'utf8'));
  }
  return out;
}

interface Row extends DetailLossResult {
  questionId: string;
  questionType: string | undefined;
  gold: string;
  extractedFacts: number;
  consolidatedFiles: number;
}

const rows: Row[] = [];

for (const sample of samples) {
  // Raw = every haystack turn, i.e. exactly what the pipeline was shown.
  const raw = sample.haystack_sessions
    .flat()
    .map((t) => t.content)
    .join('\n');

  const extractedParts: string[] = [];
  let extractedFacts = 0;
  let consolidated = '';
  let consolidatedFiles = 0;
  let tree = new Map<string, string>();

  if (fromDump !== undefined) {
    const qDir = join(fromDump, sample.question_id);
    const ext = await readFile(join(qDir, 'extracted.md'), 'utf8').catch(() => '');
    consolidated = await readFile(join(qDir, 'consolidated.md'), 'utf8').catch(() => '');
    if (ext === '' && consolidated === '') {
      console.log(`${sample.question_id.padEnd(16)} (no dump under ${qDir})`);
      continue;
    }
    extractedParts.push(ext);
    extractedFacts = ext.split('\n---\n').filter((p) => p.trim().length > 0).length;
    tree = parseDumpedTree(consolidated);
    consolidatedFiles = tree.size;
  } else {
  await runE2EQuestion({
    sample,
    extractionLlm,
    answerClient: noAnswer,
    onExtractionUsage: (u) => meter.record(DEFAULT_EXTRACTION_MODEL, u),
    observeIngest: {
      // Pre-flush: the inbox still holds THIS session's raw extraction output.
      async afterExtraction(_i, workspaceRoot) {
        const dir = join(workspaceRoot, INBOX_DIR);
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          extractedParts.push(await readFile(join(dir, name), 'utf8'));
          extractedFacts += 1;
        }
      },
      // Post-ingest: the whole tree the agent's retrieval reads from.
      async afterIngest(workspaceRoot) {
        tree = await readTree(join(workspaceRoot, MEMORY_ROOT));
        consolidatedFiles = tree.size;
        consolidated = [...tree.entries()].map(([p, body]) => `--- ${p}\n${body}`).join('\n');
        if (outDir !== undefined) {
          const qDir = join(outDir, sample.question_id);
          await mkdir(qDir, { recursive: true });
          await writeFile(join(qDir, 'extracted.md'), extractedParts.join('\n---\n'), 'utf8');
          await writeFile(join(qDir, 'consolidated.md'), consolidated, 'utf8');
        }
      },
    },
  });
  }

  const needles = NEEDLES[sample.question_id];
  const verdict = classifyDetailLoss(
    sample.answer,
    { raw, extracted: extractedParts.join('\n'), consolidated },
    needles !== undefined ? { needles } : {},
  );
  rows.push({
    ...verdict,
    questionId: sample.question_id,
    questionType: sample.question_type,
    gold: String(sample.answer),
    extractedFacts,
    consolidatedFiles,
  });

  console.log(
    `${sample.question_id.padEnd(16)} ${String(sample.question_type).padEnd(26)} ` +
      `${verdict.lostAt.padEnd(18)} facts=${String(extractedFacts).padStart(3)} ` +
      `files=${String(consolidatedFiles).padStart(3)} ` +
      `raw=[${verdict.presentInRaw.slice(0, 4).join(',')}] ` +
      `ext=[${verdict.survivedExtraction.slice(0, 4).join(',')}] ` +
      `cons=[${verdict.survivedConsolidation.slice(0, 4).join(',')}]`,
  );
  // Print the line each surviving probe landed on. A `retained` verdict is a
  // claim that memory HAD the answer, and that claim should be readable here
  // rather than requiring a trip through the dump to confirm it is not a digest.
  for (const e of verdict.evidence.slice(0, 2)) {
    console.log(`    «${e.probe}» → ${e.line.slice(0, 220)}`);
  }
  for (const l of verdict.lostProbes) {
    console.log(`    LOST at ${l.lostAt}: «${l.probe}» — in the sessions, not in the tree`);
  }
  // Once a value is `retained`, memory is not the bug — so ask the next question
  // in the same pass: would the shipped matcher have handed it to the agent?
  if (verdict.lostAt === 'retained' || verdict.lostAt === 'partial') {
    const { retrievable, matched } = await probeRetrievability(
      tree,
      sample.question,
      verdict.survivedConsolidation,
    );
    // "matchable", not "retrieved": doc SELECTION is not modelled here.
    console.log(
      `    matchable from the tree (selection not modelled): ${retrievable ? 'YES' : 'NO'}` +
        (retrievable ? `\n      in ${matched[0]?.docId} — ${matched[0]?.fact.slice(0, 160)}` : ''),
    );
    // Cap the tail: a generic surviving probe ("20", "agent") matches scores of
    // docs, and printing 90 paths buries the one line that matters.
    const docs = [...new Set(matched.map((m) => m.docId))];
    if (docs.length > 1) {
      const rest = docs.slice(1);
      console.log(
        `      (also in ${rest.length} other doc(s): ${rest.slice(0, 4).join(', ')}${rest.length > 4 ? ', …' : ''})`,
      );
    }
  }
}

const tally = new Map<string, number>();
for (const r of rows) tally.set(r.lostAt, (tally.get(r.lostAt) ?? 0) + 1);
console.log('\nWhere the value was lost:');
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v}/${rows.length}`);
}
console.log(`\nSpend: $${meter.totalDollars().toFixed(4)} (extraction only — no answer, no judge)`);
if (outDir !== undefined) console.log(`Layers dumped to ${outDir}/<questionId>/`);
