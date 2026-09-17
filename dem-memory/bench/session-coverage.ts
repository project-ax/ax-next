/**
 * For each selected question, how many of its GOLD sessions are represented in the evidence
 * table the answerer actually sees?
 *
 * This is the testable form of the "session starvation" claim: that one talkative session
 * dominates the top-K and crowds distant single mentions out of the table, which is the
 * failure mode an aggregation question ("how many X did I ...") cannot survive. If every gold
 * session is represented and the answer is still wrong, the bottleneck is synthesis and no
 * amount of retrieval widening will fix it.
 *
 * Recall only — no answer or judge calls, so with warm caches it is nearly free.
 *
 *   npx tsx bench/session-coverage.ts --ids 60472f9c,bf659f65 --fingerprint f4752a79
 */
import { createDemMemory } from "../src/index.js";
import { flattenDialogue, type DialogueTurn } from "../src/types.js";
import { DEFAULT_EXTRACT_MODEL, ExtractionCache, sessionCacheKey } from "./extraction.js";
import {
  CACHE_DIR,
  loadCorpus,
  parseArgs,
  resolveStack,
  sessionDateToIso,
  type Stack,
} from "./harness.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stack = (args.stack ?? "production") as Stack;
  const { embed, rerank, label, flushEmbed } = resolveStack(stack);
  const extractionCache = new ExtractionCache(args["cache-dir"] ?? CACHE_DIR);
  const fingerprint = args.fingerprint;
  const limit = Number(args.limit ?? 15);

  const ids = args.ids?.split(",").map((id) => id.trim()) ?? [];
  if (ids.length === 0) throw new Error("--ids is required");
  const byId = new Map(loadCorpus().map((sample) => [sample.question_id, sample]));

  console.log(`stack=${label} | ${ids.length} question(s) | evidence rows=${limit}\n`);
  console.log("question            gold-sessions  covered  rows-from-gold  verdict");

  let fullyCovered = 0;
  for (const id of ids) {
    const sample = byId.get(id);
    if (!sample) throw new Error(`unknown question_id ${id}`);
    const goldSessions = new Set(
      (sample as unknown as { answer_session_ids?: string[] }).answer_session_ids ?? [],
    );

    const memory = createDemMemory({
      path: ":memory:",
      bankId: sample.question_id,
      embed,
      rerank,
      extract: async () => {
        throw new Error("session-coverage runs cache-only; warm the cache with bench/run.ts first");
      },
      generate: async () => {
        throw new Error("session-coverage does not generate answers");
      },
    });

    // Tag every fact with the session it came from, so a recalled tuple can be attributed
    // back. `retain` does not carry a session id, so the statement text is the join key.
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
        if (!sessionOfStatement.has(key)) sessionOfStatement.set(key, sessionId);
      }
      await memory.retain({ facts }, { now: date ? sessionDateToIso(date) : new Date().toISOString() });
    }

    const asOf = sample.question_date ? sessionDateToIso(sample.question_date) : undefined;
    const recalled = await memory.recall(sample.question, asOf ? { asOf } : {}, );
    const rows = recalled.tuples.slice(0, limit);
    const covered = new Set<string>();
    let rowsFromGold = 0;
    for (const tuple of rows) {
      const sid = sessionOfStatement.get(`${tuple.subject}|${tuple.predicate}|${tuple.object}`);
      if (sid !== undefined && goldSessions.has(sid)) {
        covered.add(sid);
        rowsFromGold += 1;
      }
    }
    const full = covered.size === goldSessions.size;
    if (full) fullyCovered += 1;
    console.log(
      `${id.padEnd(20)}${String(goldSessions.size).padStart(8)}` +
        `${String(covered.size).padStart(11)}${full ? " (ALL)" : " (MISS)"}` +
        `${String(rowsFromGold).padStart(10)}`,
    );
    memory.close();
  }
  console.log(
    `\nevery gold session represented in the table: ${fullyCovered}/${ids.length}` +
      ` — the rest are candidates for session starvation`,
  );
  flushEmbed?.();
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
