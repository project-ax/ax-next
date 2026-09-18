/**
 * Dump, for each selected question, the exact evidence table the answerer is handed —
 * so a wrong answer can be attributed to retrieval (the gold fact is not in the table)
 * rather than to synthesis (it is in the table and the model still missed it).
 *
 * Runs recall only: no answer or judge calls, so with warm caches it is nearly free.
 *
 *   npx tsx bench/diagnose-temporal.ts --ids d01c6aa8,5e1b23de --stack production
 *   npx tsx bench/diagnose-temporal.ts --ids 51c32626 --fingerprint f4752a79   # past generation
 */
import { createDemMemory } from "../src/index.js";
import { compileEvidenceTable } from "../src/engine/reflect.js";
import { flattenDialogue, type DialogueTurn } from "../src/types.js";
import { DEFAULT_EXTRACT_MODEL, ExtractionCache, sessionCacheKey } from "./extraction.js";
import {
  CACHE_DIR,
  loadCorpus,
  parseArgs,
  stratifiedSample,
  resolveStack,
  sessionDateToIso,
  type LongMemEvalSample,
  type Stack,
} from "./harness.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stack = (args.stack ?? "production") as Stack;
  const { embed, rerank, label, flushEmbed } = resolveStack(stack);
  const extractionCache = new ExtractionCache(args["cache-dir"] ?? CACHE_DIR);

  // Without this, a prompt edit that re-keys the fact cache silently turns every diagnosis
  // into an empty bank — the sessions are all "missing-from-cache" and the evidence table
  // is blank, which reads like a retrieval failure rather than a stale key.
  const fingerprint = args.fingerprint;

  const corpus = loadCorpus();
  const idFilter = args.ids?.split(",").map((id) => id.trim());
  const typeFilter = args.types?.split(",").map((t) => t.trim()) ?? ["temporal-reasoning"];
  const n = Number(args.n ?? 30);

  let selected: LongMemEvalSample[];
  if (idFilter) {
    const byId = new Map(corpus.map((sample) => [sample.question_id, sample]));
    selected = idFilter.flatMap((id) => {
      const sample = byId.get(id);
      if (!sample) throw new Error(`unknown question_id ${id}`);
      return [sample];
    });
  } else {
    // Mirror run.ts's selection exactly so the rows line up with a results file.
    selected = stratifiedSample(corpus, n).filter((sample) =>
      typeFilter.includes(sample.question_type ?? "(none)"),
    );
  }

  console.log(`stack=${label} | ${selected.length} question(s)\n`);

  for (const sample of selected) {
    const memory = createDemMemory({
      path: ":memory:",
      bankId: sample.question_id,
      embed,
      rerank,
      extract: async () => {
        throw new Error("diagnose-temporal runs cache-only; warm the cache with bench/run.ts first");
      },
      generate: async () => {
        throw new Error("diagnose-temporal does not generate answers");
      },
    });

    let missing = 0;
    for (const [i, turns] of sample.haystack_sessions.entries()) {
      const sessionId = sample.haystack_session_ids[i] ?? `session-${i}`;
      const date = sample.haystack_dates?.[i];
      const nowIso = date ? sessionDateToIso(date) : new Date().toISOString();
      const dialogue = flattenDialogue(turns as DialogueTurn[]);
      const facts = extractionCache.get(
        sessionCacheKey(sessionId, dialogue, DEFAULT_EXTRACT_MODEL, fingerprint),
      );
      if (!facts) {
        missing += 1;
        continue;
      }
      await memory.retain({ facts }, { now: nowIso });
    }

    const anchor = sample.question_date ? sessionDateToIso(sample.question_date) : undefined;
    const stats = memory.stats();

    console.log("═".repeat(100));
    console.log(`${sample.question_id} [${sample.question_type}]`);
    console.log(`Q:      ${sample.question}`);
    console.log(`GOLD:   ${sample.answer}`);
    console.log(`ANCHOR: ${anchor ?? "(none)"} | sessions=${sample.haystack_sessions.length} missing-from-cache=${missing}`);
    console.log(`BANK:   total=${stats.total} active=${stats.active}`);

    for (const mode of ["anchored", "asOf-only"] as const) {
      const recalled = await memory.recall(
        sample.question,
        mode === "anchored" && anchor ? { temporalAnchor: anchor } : anchor ? { asOf: anchor } : {},
      );
      const evidence = compileEvidenceTable(recalled.tuples, { asOf: anchor });
      console.log(`\n--- ${mode} (${recalled.tuples.length} rows, reranked=${recalled.reranked}) ---`);
      console.log(evidence.table);
      if (mode === "anchored" && !anchor) break;
    }
    console.log();
    memory.close();
  }
  flushEmbed?.();
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
