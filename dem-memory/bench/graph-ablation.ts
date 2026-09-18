/**
 * Does the GRAPH channel earn its place in the RRF fusion?
 *
 * DEM fuses four deterministic channels — sparse (FTS5), dense (vec0), graph (co-occurrence
 * neighbourhood over `subject`), temporal — and the graph channel's contribution has never
 * been ablated. §2.3 of `docs/plans/2026-09-18-dem-first-memory-design.md` flags why that is
 * suspicious: the co-occurrence graph is keyed on `subject`, and `subject` is the SPEAKER on
 * 90.0% of rows (`assistant` 52.3% + `user` 37.7%). As built it is two giant nodes and noise.
 *
 * This runs the same questions twice over the SAME ingested store — once with the graph the
 * write path built, once with an empty one — and compares what reaches the evidence table.
 * An empty graph makes `matchEntities` return no seeds, so `graphChannel` returns `[]` and
 * RRF fuses three lists instead of four. Nothing else differs: same facts, same embeddings,
 * same reranker, same question.
 *
 * RECALL ONLY — no answer call, no judge call. With warm caches the only paid hop is the
 * reranker (one call per question per arm), so `--stack vertex` makes it free outright.
 *
 *   npx tsx bench/graph-ablation.ts --n 100 --fingerprint f4752a79 --stack production
 *   npx tsx bench/graph-ablation.ts --n 100 --fingerprint f4752a79 --stack vertex
 *
 * THE METRIC is gold-session coverage in the top-15, not accuracy: whether the sessions the
 * benchmark says hold the answer are represented in the table the answerer would see. It is
 * the same measure `bench/session-coverage.ts` reports, and it isolates retrieval from
 * synthesis for free — a channel that changes no table cannot change an answer.
 *
 * The decision this feeds: drop the channel, or re-key it on an entity list. Rung 0 does not
 * build entities either way; it only says whether the current channel is doing anything.
 *
 * ---------------------------------------------------------------------------------------
 * MEASURED 2026-09-18, n=100 spaced, `f4752a79`. THE ANSWER IS "NOTHING" — DROP IT.
 *
 *                                    coverage        fully-covered  rows-from-gold
 *   production (Cohere)   graph on   100.0% (199/199)   100/100        819
 *                         graph off  100.0% (199/199)   100/100        819
 *   vertex (lexical) r1   graph on    90.5% (180/199)    86/100        481
 *                         graph off   90.5% (180/199)    86/100        481
 *   vertex (lexical) r2   graph on    91.0% (181/199)    88/100        469
 *                         graph off   91.0% (181/199)    88/100        469
 *
 *   graph channel returns ANY candidate:      2 of 100 questions
 *   rows in a top-15 only the graph proposed: 1 of 1,500 (production), 0 (lexical)
 *   mean entity seeds matched per question:   0.02
 *   graph size for a whole ~48-session haystack: 10-30 nodes, 15-65 edges
 *
 * READ IT DOWN THE PAIRS, NEVER ACROSS THE RUNS. Within a run the arms are identical in every
 * cell, per question type as well as overall. BETWEEN runs the absolute level moves, and that
 * movement is not the graph channel — dem's retrieval is not reproducible at all, because
 * `retain.ts` mints `randomUUID()` and every tie-break in `recall.ts` is `id.localeCompare`.
 * See `bench/reproducibility-probe.ts`. This ablation survives that only because it is PAIRED
 * inside one process over one ingested store.
 *
 * Also measured here, and worth knowing before trusting any table diff: with the Cohere
 * reranker 24 of 100 top-15 tables differed between the arms, where only 2 could differ for a
 * real reason. `rerank-v4.0-pro` is itself non-reproducible — three calls with a byte-identical
 * query and document list gave a third run differing by maxAbsDelta 4.26e-3 and a different
 * ordering. Use `--stack vertex` for anything that compares two tables.
 */
import {
  CoOccurrenceGraph,
  MemoryRepository,
  RecallEngine,
  createDemMemory,
  matchEntities,
  type RecallResult,
} from "../src/index.js";
import { createCohereReranker, lexicalReranker } from "../src/models/reranker.js";
import { flattenDialogue, type DialogueTurn } from "../src/types.js";
import { DEFAULT_EXTRACT_MODEL, ExtractionCache, sessionCacheKey } from "./extraction.js";
import {
  CACHE_DIR,
  loadCorpus,
  parseArgs,
  resolveStack,
  sessionDateToIso,
  stratifiedSample,
  type Stack,
} from "./harness.js";

interface ArmTally {
  label: string;
  questions: number;
  goldSessionsSeen: number;
  goldSessionsCovered: number;
  fullyCovered: number;
  rowsFromGold: number;
  /** Rank (1-based) of the first gold-bearing row, or `limit + 1` when there is none. */
  firstGoldRanks: number[];
}

function emptyTally(label: string): ArmTally {
  return {
    label,
    questions: 0,
    goldSessionsSeen: 0,
    goldSessionsCovered: 0,
    fullyCovered: 0,
    rowsFromGold: 0,
    firstGoldRanks: [],
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function score(
  tally: ArmTally,
  result: RecallResult,
  limit: number,
  goldSessions: ReadonlySet<string>,
  sessionOfStatement: ReadonlyMap<string, string>,
): { covered: number; rowsFromGold: number } {
  const rows = result.tuples.slice(0, limit);
  const covered = new Set<string>();
  let rowsFromGold = 0;
  let firstGoldRank = limit + 1;
  rows.forEach((tuple, index) => {
    const sessionId = sessionOfStatement.get(`${tuple.subject}|${tuple.predicate}|${tuple.object}`);
    if (sessionId !== undefined && goldSessions.has(sessionId)) {
      covered.add(sessionId);
      rowsFromGold += 1;
      if (index + 1 < firstGoldRank) firstGoldRank = index + 1;
    }
  });
  tally.questions += 1;
  tally.goldSessionsSeen += goldSessions.size;
  tally.goldSessionsCovered += covered.size;
  tally.rowsFromGold += rowsFromGold;
  tally.firstGoldRanks.push(firstGoldRank);
  if (covered.size === goldSessions.size && goldSessions.size > 0) tally.fullyCovered += 1;
  return { covered: covered.size, rowsFromGold };
}

function reportArm(tally: ArmTally): void {
  const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
  console.log(
    `  ${tally.label.padEnd(12)} gold-session coverage ${pct(tally.goldSessionsCovered, tally.goldSessionsSeen)}` +
      ` (${tally.goldSessionsCovered}/${tally.goldSessionsSeen})` +
      `  fully-covered ${tally.fullyCovered}/${tally.questions}` +
      `  rows-from-gold ${tally.rowsFromGold}` +
      `  median first-gold rank ${median(tally.firstGoldRanks)}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stack = (args.stack ?? "production") as Stack;
  const { embed, rerank: rerankKind, label, flushEmbed } = resolveStack(stack);
  const rerank = rerankKind === "cohere" ? createCohereReranker() : lexicalReranker();
  const extractionCache = new ExtractionCache(args["cache-dir"] ?? CACHE_DIR);
  const fingerprint = args.fingerprint;
  const limit = Number(args.limit ?? 15);
  const n = Number(args.n ?? 100);

  const corpus = loadCorpus();
  const samples = args.ids
    ? (() => {
        const wanted = new Set(args.ids.split(",").map((id) => id.trim()));
        return corpus.filter((sample) => wanted.has(sample.question_id));
      })()
    : stratifiedSample(corpus, n);

  console.log(`stack=${label} | ${samples.length} question(s) | evidence rows=${limit}`);
  console.log(`arms: graph-on (four channels) vs graph-off (sparse + dense + temporal)\n`);

  const on = emptyTally("graph-on");
  const off = emptyTally("graph-off");
  /** Questions whose top-15 differs at all between the arms. */
  let tablesDiffer = 0;
  /** Questions where the graph channel returned any candidate at all. */
  let graphNonEmpty = 0;
  /** Rows in the top-15 that ONLY the graph channel proposed. */
  let graphUniqueRows = 0;
  let seedTotal = 0;
  /** Integrity of the statement -> session join; see the comment at its construction. */
  let statementKeys = 0;
  let ambiguousKeys = 0;
  const byType = new Map<string, { on: number; off: number; seen: number }>();

  for (const [index, sample] of samples.entries()) {
    const goldSessions = new Set(
      (sample as unknown as { answer_session_ids?: string[] }).answer_session_ids ?? [],
    );

    const memory = createDemMemory({
      path: ":memory:",
      bankId: sample.question_id,
      embed,
      rerank,
      extract: async () => {
        throw new Error("graph-ablation runs cache-only; warm the cache with bench/run.ts first");
      },
      generate: async () => {
        throw new Error("graph-ablation does not generate answers");
      },
    });

    // The statement text is the join key back to a session — `retain` does not carry one.
    //
    // That join is only sound while one statement text comes from one session. If a text
    // were emitted by several, first-wins attribution would be arbitrary and gold-session
    // coverage could be credited to a session the row did not come from. Measured rather
    // than assumed, and re-measured on every run: `ambiguousKeys` below was 0 of 32,214 over
    // the n=100 spaced sample, so the coverage numbers are exact rather than approximate.
    const sessionOfStatement = new Map<string, string>();
    for (const [i, turns] of sample.haystack_sessions.entries()) {
      const sessionId = sample.haystack_session_ids[i] ?? `session-${i}`;
      const date = sample.haystack_dates?.[i];
      const dialogue = flattenDialogue(turns as DialogueTurn[]);
      const facts = extractionCache.get(
        sessionCacheKey(sessionId, dialogue, DEFAULT_EXTRACT_MODEL, fingerprint),
      );
      if (!facts) continue;
      for (const fact of facts) {
        const key = `${fact.subject}|${fact.predicate}|${fact.object}`;
        const seen = sessionOfStatement.get(key);
        if (seen === undefined) sessionOfStatement.set(key, sessionId);
        else if (seen !== sessionId) ambiguousKeys += 1;
        statementKeys += 1;
      }
      await memory.retain(
        { facts },
        { now: date ? sessionDateToIso(date) : new Date().toISOString() },
      );
    }

    const asOf = sample.question_date ? sessionDateToIso(sample.question_date) : undefined;
    const options = { limit, ...(asOf ? { asOf } : {}) };

    const repository = new MemoryRepository(memory.database);

    // Arm A: the facade's own engine, over the graph `retain` built.
    const withGraph = await memory.recall(sample.question, options);

    // Arm B: a second engine over the SAME repository and an EMPTY graph. `matchEntities`
    // finds no seeds in an empty node list, so `graphChannel` short-circuits to [] and RRF
    // fuses three lists. Nothing else about the read path changes.
    //
    // The options object is deliberately bare: `createDemMemory` is constructed above with
    // no `rrfK` and no `rerankPool` either, so both engines take the same defaults
    // (DEFAULT_RRF_K = 60, channelLimit 40, rerankPool 40). Passing anything here would make
    // the arms differ in a second place and the ablation would stop being an ablation.
    const withoutGraph = await new RecallEngine(
      repository,
      new CoOccurrenceGraph(),
      sample.question_id,
      embed,
      { rerank },
    ).recall(sample.question, options);

    const a = score(on, withGraph, limit, goldSessions, sessionOfStatement);
    const b = score(off, withoutGraph, limit, goldSessions, sessionOfStatement);

    // What the channel itself proposed, independent of whether it changed the outcome.
    // The facade keeps its graph private, so rebuild the identical one from the repository
    // the same way `createDemMemory` does — `graph.coOccur(batch)` per transaction-time batch.
    const stats = memory.stats();
    const mirror = new CoOccurrenceGraph();
    for (const batch of repository.batches(sample.question_id)) mirror.coOccur(batch);
    seedTotal += matchEntities(sample.question, mirror.nodes()).length;
    if (withGraph.channels.graph.length > 0) graphNonEmpty += 1;
    const others = new Set([
      ...withGraph.channels.sparse,
      ...withGraph.channels.dense,
      ...withGraph.channels.temporal,
    ]);
    const topIds = new Set(withGraph.tuples.slice(0, limit).map((tuple) => tuple.id));
    for (const id of withGraph.channels.graph) {
      if (topIds.has(id) && !others.has(id)) graphUniqueRows += 1;
    }

    const idsOn = withGraph.tuples.slice(0, limit).map((t) => t.id).join(",");
    const idsOff = withoutGraph.tuples.slice(0, limit).map((t) => t.id).join(",");
    if (idsOn !== idsOff) tablesDiffer += 1;

    const type = sample.question_type ?? "(none)";
    const bucket = byType.get(type) ?? { on: 0, off: 0, seen: 0 };
    bucket.seen += goldSessions.size;
    bucket.on += a.covered;
    bucket.off += b.covered;
    byType.set(type, bucket);

    if ((index + 1) % 10 === 0) {
      process.stderr.write(
        `  ${index + 1}/${samples.length} · graph nodes ${stats.graphNodes} edges ${stats.graphEdges}\n`,
      );
    }
    memory.close();
  }

  console.log("=== gold-session coverage in the top-15 ===");
  reportArm(on);
  reportArm(off);
  console.log("");
  console.log(`questions whose top-${limit} differs between the arms: ${tablesDiffer}/${samples.length}`);
  console.log(`questions where the graph channel returned any candidate: ${graphNonEmpty}/${samples.length}`);
  console.log(`rows in a top-${limit} proposed ONLY by the graph channel: ${graphUniqueRows}`);
  console.log(`mean entity seeds matched per question: ${(seedTotal / Math.max(1, samples.length)).toFixed(2)}`);
  console.log(
    `statement -> session join: ${statementKeys} facts, ${ambiguousKeys} whose statement text` +
      ` also came from another session` +
      `${ambiguousKeys === 0 ? " — the attribution is exact, not approximate" : " — COVERAGE IS APPROXIMATE"}`,
  );

  console.log("\n=== by question type (gold sessions covered / seen) ===");
  for (const [type, bucket] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const p = (n2: number): string => (bucket.seen === 0 ? "n/a" : `${((n2 / bucket.seen) * 100).toFixed(1)}%`);
    console.log(
      `  ${type.padEnd(26)} on ${p(bucket.on).padStart(6)}  off ${p(bucket.off).padStart(6)}  (seen ${bucket.seen})`,
    );
  }

  flushEmbed?.();
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
