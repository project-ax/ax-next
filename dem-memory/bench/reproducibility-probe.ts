/**
 * Is dem's retrieval reproducible? Today: NO, and not subtly.
 *
 * Ingest the same question twice inside one process, on the fully deterministic stack
 * (cached Vertex embeddings + lexical reranker — no model call anywhere), and compare the
 * evidence tables by CONTENT. Same facts, same vectors, same reranker, same dates. The only
 * thing that differs between the two banks is the uuids `retain` mints.
 *
 *   npx tsx bench/reproducibility-probe.ts --n 12 --fingerprint f4752a79
 *
 * MEASURED 2026-09-18, 12 questions from the n=100 spaced sample:
 *
 *   12/12 questions produced a DIFFERENT top-15 from identical input
 *   12/12 changed WHICH ROWS are in the table, not merely their order
 *   130-143 of 180 row positions moved (two runs of the probe itself — the count varies,
 *     which is the same phenomenon one level up)
 *
 * CAUSE, proven by mutation rather than inferred. `retain.ts` mints `id: randomUUID()`, and
 * every ranking tie-break in `recall.ts` is `id.localeCompare(id)` — the RRF fusion sort, the
 * reranker reorder, and the graph channel's ordering. RRF scores are sums of a few discrete
 * `1/(k + rank)` terms, so exact ties are common and the tie groups are large; which
 * candidates enter the 40-row rerank pool, and which 15 leave it, is therefore decided by a
 * random string. Replacing the uuid with a content-derived id
 * (`subject|predicate|object|validStart`) and re-running this probe gives **0/12 differing,
 * 0 row positions moved**. Nothing else was changed.
 *
 * WHY IT MATTERS BEYOND THE BENCH. Two consecutive asks of the same question can be answered
 * from different evidence. And every accuracy number this project has measured contains this
 * as an unattributed noise component: the n=100 "+/-4-6pp on identical code" and n=500 "1.6pp"
 * floors were recorded as answerer + judge variance, and `HANDOFF.md` already warns that
 * figure is a LOWER BOUND. This is a concrete, removable part of the gap.
 *
 * THE FIX IS ONE LINE AND IS NOT TAKEN HERE, deliberately. Deriving the id from content makes
 * retrieval reproducible for free, but it also changes which rows reach the answerer, so it
 * moves every score by an unknown amount and needs its own measured arm. Landing it inside a
 * measurement change would be two changes at once — see the counting-directives report for
 * what that costs. Rung 1's normalizer arm should run against the CURRENT build so it stays
 * comparable to the stored 87.4% baseline and the 1.6pp floor, which were both measured with
 * this noise in them.
 *
 * When the fix does land, this probe is its regression test: it must read 0/N.
 */
import { createDemMemory } from "../src/index.js";
import { lexicalReranker } from "../src/models/reranker.js";
import { flattenDialogue, type DialogueTurn } from "../src/types.js";
import { DEFAULT_EXTRACT_MODEL, ExtractionCache, sessionCacheKey } from "./extraction.js";
import {
  CACHE_DIR,
  loadCorpus,
  parseArgs,
  resolveStack,
  sessionDateToIso,
  stratifiedSample,
  type LongMemEvalSample,
} from "./harness.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fingerprint = args.fingerprint;
  const limit = Number(args.limit ?? 15);
  const n = Number(args.n ?? 12);

  // `vertex` on purpose, never `production`: `rerank-v4.0-pro` is itself non-reproducible
  // (~22% of top-15 tables reorder between two identical calls), which would confound the
  // thing being measured here.
  const { embed, flushEmbed } = resolveStack("vertex");
  const rerank = lexicalReranker();
  const cache = new ExtractionCache(args["cache-dir"] ?? CACHE_DIR);
  const samples = stratifiedSample(loadCorpus(), 100).slice(0, n);

  const tableFor = async (sample: LongMemEvalSample, tag: string): Promise<string[]> => {
    const memory = createDemMemory({
      path: ":memory:",
      bankId: `${sample.question_id}-${tag}`,
      embed,
      rerank,
      extract: async () => {
        throw new Error("reproducibility-probe runs cache-only; warm the cache with bench/run.ts");
      },
      generate: async () => {
        throw new Error("reproducibility-probe does not generate answers");
      },
    });
    for (const [i, turns] of sample.haystack_sessions.entries()) {
      const sessionId = sample.haystack_session_ids[i] ?? `session-${i}`;
      const facts = cache.get(
        sessionCacheKey(
          sessionId,
          flattenDialogue(turns as DialogueTurn[]),
          DEFAULT_EXTRACT_MODEL,
          fingerprint,
        ),
      );
      if (!facts) continue;
      const date = sample.haystack_dates?.[i];
      await memory.retain(
        { facts },
        { now: date ? sessionDateToIso(date) : new Date().toISOString() },
      );
    }
    const asOf = sample.question_date ? sessionDateToIso(sample.question_date) : undefined;
    const result = await memory.recall(sample.question, { limit, ...(asOf ? { asOf } : {}) });
    memory.close();
    // Identify rows by CONTENT, never by id — the ids are the variable under test.
    return result.tuples.map((tuple) => `${tuple.subject}|${tuple.predicate}|${tuple.object}`);
  };

  console.log(`${samples.length} question(s), evidence rows=${limit}, deterministic stack\n`);
  let differing = 0;
  let setsDiffer = 0;
  let rowsMoved = 0;
  for (const sample of samples) {
    const a = await tableFor(sample, "a");
    const b = await tableFor(sample, "b");
    const moved = a.filter((row, index) => row !== b[index]).length;
    const identical = a.length === b.length && moved === 0;
    if (!identical) differing += 1;
    rowsMoved += moved;
    const setA = new Set(a);
    if (a.length !== b.length || b.some((row) => !setA.has(row))) setsDiffer += 1;
    console.log(
      `  ${sample.question_id.padEnd(20)} identical=${identical}  rows-at-a-different-rank=${moved}/${a.length}`,
    );
  }

  console.log(
    `\n${differing}/${samples.length} questions produced a DIFFERENT top-${limit} from identical input;` +
      ` ${setsDiffer}/${samples.length} changed which rows are in the table at all;` +
      ` ${rowsMoved} row positions moved in total`,
  );
  console.log(
    differing === 0
      ? "retrieval is reproducible"
      : "retrieval is NOT reproducible — see this file's header for the cause and the fix",
  );
  flushEmbed?.();
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
