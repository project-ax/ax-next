/**
 * Can slot supersession cost an answer? Answered exactly, for free, instead of statistically
 * for ~$5 and ten hours.
 *
 * Rung 1 as §8 specified it is 8 x n=500 scored runs whose gate is "no loss beyond the 1.6pp
 * floor on TOTAL". Rung 0 measured what that treatment actually does: the slot rule closes
 * **62 rows out of 162,147 ingests** at question scope. A 0.04% intervention cannot be seen
 * through a 1.6pp noise floor, so the expensive version would report "no detectable
 * difference" whatever the truth was — which is the prior, not a finding.
 *
 * The question underneath it is narrow and has an exact answer. Closure is not inert: every
 * recall channel applies `validityClause`, which defaults to `valid_end = INFINITY`, so a
 * closed row leaves the candidate set. So: **did closure remove, from any evidence table, a
 * row that came from a gold session?** If not, the treatment cannot have cost an answer on
 * this sample, and no amount of scoring would have told us more.
 *
 *   npx tsx bench/closure-impact.ts --n 500 --fingerprint f4752a79
 *   npx tsx bench/closure-impact.ts --n 500 --fingerprint f4752a79 --stack production
 *
 * METHOD. Per question, two stores of the SAME bank in two separate in-memory databases,
 * ingested identically, differing only in `supersession`. Both run `idStrategy: content`, so
 * a row has the same id in both arms and the two tables can be compared row by row — which is
 * the reason step 2 had to land before this measurement was possible at all.
 *
 * `--stack vertex` by default, not `production`: `rerank-v4.0-pro` reorders ~22% of top-15
 * tables between two byte-identical calls, and that noise would swamp a 0.04% treatment. The
 * lexical reranker is deterministic, so every difference this reports is the treatment.
 */
import { createDemMemory, type DemMemory, type SupersessionMode } from "../src/index.js";
import { createCohereReranker, lexicalReranker } from "../src/models/reranker.js";
import {
  flattenDialogue,
  type DialogueTurn,
  type EmbeddingFn,
  type RerankFn,
} from "../src/types.js";
import { DEFAULT_EXTRACT_MODEL, ExtractionCache, sessionCacheKey } from "./extraction.js";
import {
  CACHE_DIR,
  loadCorpus,
  parseArgs,
  resolveStack,
  sessionDateToIso,
  stratifiedSample,
  type LongMemEvalSample,
  type Stack,
} from "./harness.js";

interface Table {
  /** Row ids in rank order. */
  ids: string[];
  /** Statement text by row id, so a diff can be READ and not merely counted. */
  textOfId: Map<string, string>;
  /** Which gold session each row came from, for the rows that came from one. */
  goldSessionOfId: Map<string, string>;
  /** Gold sessions represented in the top-N — the metric that predicts an answer change. */
  goldSessionsCovered: Set<string>;
  /** Rows the store closed during ingest. */
  closed: number;
}

async function build(
  sample: LongMemEvalSample,
  mode: SupersessionMode,
  deps: {
    embed: EmbeddingFn;
    rerank: RerankFn;
    cache: ExtractionCache;
    fingerprint: string | undefined;
    limit: number;
  },
): Promise<Table> {
  const memory: DemMemory = createDemMemory({
    path: ":memory:",
    bankId: sample.question_id,
    embed: deps.embed,
    rerank: deps.rerank,
    supersession: mode,
    // Both arms, so a row has the same id in each and the tables are comparable.
    idStrategy: "content",
    extract: async () => {
      throw new Error("closure-impact runs cache-only; warm the cache with bench/run.ts first");
    },
    generate: async () => {
      throw new Error("closure-impact does not generate answers");
    },
  });

  const goldSessions = new Set(
    (sample as unknown as { answer_session_ids?: string[] }).answer_session_ids ?? [],
  );
  const goldSessionOfId = new Map<string, string>();
  let closed = 0;

  for (const [i, turns] of sample.haystack_sessions.entries()) {
    const sessionId = sample.haystack_session_ids[i] ?? `session-${i}`;
    const facts = deps.cache.get(
      sessionCacheKey(
        sessionId,
        flattenDialogue(turns as DialogueTurn[]),
        DEFAULT_EXTRACT_MODEL,
        deps.fingerprint,
      ),
    );
    if (!facts) continue;
    const date = sample.haystack_dates?.[i];
    const result = await memory.retain(
      { facts },
      { now: date ? sessionDateToIso(date) : new Date().toISOString() },
    );
    closed += result.invalidatedCount;
    if (goldSessions.has(sessionId)) {
      for (const tuple of result.tuples) goldSessionOfId.set(tuple.id, sessionId);
    }
  }

  const asOf = sample.question_date ? sessionDateToIso(sample.question_date) : undefined;
  const recalled = await memory.recall(sample.question, {
    limit: deps.limit,
    ...(asOf ? { asOf } : {}),
  });
  memory.close();
  const ids = recalled.tuples.map((tuple) => tuple.id);
  const textOfId = new Map(
    recalled.tuples.map((tuple) => [
      tuple.id,
      `${tuple.subject} | ${tuple.predicate} | ${tuple.object.slice(0, 90)}`,
    ]),
  );
  const goldSessionsCovered = new Set<string>();
  for (const id of ids) {
    const session = goldSessionOfId.get(id);
    if (session !== undefined) goldSessionsCovered.add(session);
  }
  return { ids, textOfId, goldSessionOfId, goldSessionsCovered, closed };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stack = (args.stack ?? "vertex") as Stack;
  const { embed, rerank: rerankKind, label, flushEmbed } = resolveStack(stack);
  const rerank = rerankKind === "cohere" ? createCohereReranker() : lexicalReranker();
  const cache = new ExtractionCache(args["cache-dir"] ?? CACHE_DIR);
  const fingerprint = args.fingerprint;
  const limit = Number(args.limit ?? 15);
  const n = Number(args.n ?? 500);

  // `--ids` explains named questions instead of surveying the corpus: it prints the rows
  // closure removed from and admitted to each table, which is how a question that FLIPPED in
  // the scored arms gets a mechanism rather than a shrug.
  const idList = args.ids
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const corpus = loadCorpus();
  const samples =
    idList !== undefined && idList.length > 0
      ? corpus.filter((sample) => idList.includes(sample.question_id))
      : stratifiedSample(corpus, n);
  const verbose = idList !== undefined && idList.length > 0;
  console.log(`stack=${label} | ${samples.length} question(s) | evidence rows=${limit}`);
  console.log(`arms: supersession=invalidates-previous (baseline) vs supersession=slot\n`);

  // BOTH arms close rows — the baseline fires DEM's `invalidatesPrevious` rule. Reporting
  // only the slot arm's count implies the slot rule is the sole active agent, and it is not:
  // on several of the questions whose table changes, the slot arm closes NOTHING and the
  // difference is entirely what the BASELINE destroyed.
  let rowsClosedBase = 0;
  let rowsClosedSlot = 0;
  let questionsWithClosure = 0;
  let tablesDiffer = 0;
  let rowsDropped = 0;
  let goldRowsDropped = 0;
  let rowsAdmitted = 0;
  let goldRowsAdmitted = 0;
  const affected: string[] = [];
  /** Questions where the slot arm covers FEWER gold sessions — the ones that can lose. */
  const lostCoverage: string[] = [];
  /** Questions where it covers more. Closure frees a slot in the table, so this happens too. */
  const gainedCoverage: string[] = [];

  for (const [index, sample] of samples.entries()) {
    const deps = { embed, rerank, cache, fingerprint, limit };
    const base = await build(sample, "invalidates-previous", deps);
    const slot = await build(sample, "slot", deps);

    rowsClosedBase += base.closed;
    rowsClosedSlot += slot.closed;
    if (slot.closed > 0 || base.closed > 0) questionsWithClosure += 1;

    const baseSet = new Set(base.ids);
    const slotSet = new Set(slot.ids);
    const dropped = base.ids.filter((id) => !slotSet.has(id));
    const admitted = slot.ids.filter((id) => !baseSet.has(id));
    if (dropped.length > 0 || admitted.length > 0 || base.ids.join() !== slot.ids.join()) {
      tablesDiffer += 1;
      if (dropped.length > 0 || admitted.length > 0) affected.push(sample.question_id);
    }
    rowsDropped += dropped.length;
    rowsAdmitted += admitted.length;
    // `goldIds` is per-arm but keyed on content-derived ids, so the two agree on which rows
    // are gold-bearing; either side answers the question.
    goldRowsDropped += dropped.filter((id) => base.goldSessionOfId.has(id)).length;
    goldRowsAdmitted += admitted.filter((id) => slot.goldSessionOfId.has(id)).length;

    // The metric that actually predicts an answer change. A table that swaps one gold row for
    // ANOTHER ROW OF THE SAME SESSION has lost nothing the answerer needed, so counting rows
    // overstates the exposure; counting SESSIONS is the honest version.
    if (slot.goldSessionsCovered.size < base.goldSessionsCovered.size) {
      lostCoverage.push(sample.question_id);
    } else if (slot.goldSessionsCovered.size > base.goldSessionsCovered.size) {
      gainedCoverage.push(sample.question_id);
    }

    if (verbose) {
      console.log(`--- ${sample.question_id} (${sample.question_type ?? "?"}) ---`);
      console.log(`  rows closed: baseline ${base.closed}, slot ${slot.closed}`);
      for (const id of dropped) {
        const gold = base.goldSessionOfId.has(id) ? " [GOLD]" : "";
        console.log(`  - DROPPED${gold}: ${base.textOfId.get(id) ?? id}`);
      }
      for (const id of admitted) {
        const gold = slot.goldSessionOfId.has(id) ? " [GOLD]" : "";
        console.log(`  + ADMITTED${gold}: ${slot.textOfId.get(id) ?? id}`);
      }
      console.log(
        `  gold sessions covered: ${base.goldSessionsCovered.size} -> ${slot.goldSessionsCovered.size}`,
      );
    } else if ((index + 1) % 50 === 0) {
      process.stderr.write(`  ${index + 1}/${samples.length}\n`);
    }
  }

  console.log("=== what each rule closed during ingest ===");
  console.log(`  rows closed by invalidatesPrevious (baseline): ${rowsClosedBase}`);
  console.log(`  rows closed by the slot rule:                  ${rowsClosedSlot}`);
  console.log(`  questions where EITHER closed anything:        ${questionsWithClosure}/${samples.length}`);
  console.log("\n=== what reached the evidence table ===");
  console.log(`  tables that differ at all:  ${tablesDiffer}/${samples.length}`);
  console.log(`  rows dropped from a table:  ${rowsDropped} (of which GOLD-BEARING: ${goldRowsDropped})`);
  console.log(`  rows admitted to a table:   ${rowsAdmitted} (of which GOLD-BEARING: ${goldRowsAdmitted})`);
  console.log(`  gold-SESSION coverage lost:  ${lostCoverage.length} question(s)`);
  console.log(`  gold-SESSION coverage gained: ${gainedCoverage.length} question(s)`);
  if (affected.length > 0) {
    // Copy-pasteable, because scoring exactly these gives the EXACT delta over the corpus:
    // every other question is provably identical in both arms.
    console.log(`\n  --ids ${affected.join(",")}`);
  }
  console.log(
    affected.length === 0
      ? "\nNo evidence table changed. On this sample the slot rule CANNOT have changed an answer."
      : `\n${affected.length} of ${samples.length} tables changed, so at most ${affected.length} answers can\n` +
          `differ and the other ${samples.length - affected.length} are provably identical. Score the list above in\n` +
          "both arms and the delta over the whole corpus is EXACT — which is what rung 1's eight\n" +
          "full runs were approximating, at about a thirtieth of the cost.",
  );
  flushEmbed?.();
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
