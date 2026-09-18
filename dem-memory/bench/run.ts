import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDemMemory, type IdStrategy, type SupersessionMode } from "../src/index.js";
import { flattenDialogue, type DialogueTurn } from "../src/types.js";
import { OpenRouterLlm, type LlmUsage } from "./llm.js";
import {
  DEFAULT_EXTRACT_MODEL,
  ExtractionCache,
  createGlmExtractor,
  sessionCacheKey,
} from "./extraction.js";
import {
  CACHE_DIR,
  loadCorpus,
  parseArgs,
  pickShortest,
  resolveStack,
  stratifiedSample,
  runWithConcurrency,
  sessionDateToIso,
  type Stack,
} from "./harness.js";

interface BenchRow {
  question_id: string;
  question_type: string;
  verdict: string;
  reason: string;
  answer: string;
  evidence_rows: number;
  tokens: number;
  as_of?: string;
  extract_in: number;
  extract_out: number;
  answer_in: number;
  answer_out: number;
  judge_in: number;
  judge_out: number;
  elapsed_ms: number;
}

const JUDGE_SYSTEM = `You are an evaluation judge. Score whether an answer matches the gold answer.

Respond in EXACTLY this format on two lines:
VERDICT: <correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain>
REASON: <one short sentence>

Scoring rules:
- "correct": the agent's answer matches the gold answer.
- "incorrect": the agent's answer contradicts the gold or is materially wrong.
- "abstained-correctly": the question is marked Unanswerable (gold is an "I don't know"-style refusal) AND the agent refused to answer (e.g., "I don't know" or "the memory does not contain this").
- "abstained-incorrectly": the agent refused to answer ("I don't know"-style) but the question is answerable (Unanswerable: false) — a missed retrieval.
- "uncertain": you cannot tell from the gold whether the agent is right (partial answers, ambiguous gold).`;

const VERDICT_RE =
  /VERDICT:\s*(correct|incorrect|abstained-correctly|abstained-incorrectly|uncertain)/i;

const POSITIVE = new Set(["correct", "abstained-correctly"]);

function zero(): LlmUsage {
  return { in: 0, out: 0 };
}

function addUsage(target: LlmUsage, source: LlmUsage): void {
  target.in += source.in;
  target.out += source.out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required (source your env file)");
  const n = Number(args.n ?? 30);
  const model = args.model ?? DEFAULT_EXTRACT_MODEL;
  // Extraction and answering are separate arms: Strata's e2e baseline extracts with GLM and
  // ANSWERS with claude-sonnet-4.6, so comparing against it means varying one without the other.
  const extractModel = args["extract-model"] ?? model;
  const answerModel = args["answer-model"] ?? model;
  const judgeModel = args["judge-model"] ?? "x-ai/grok-4.3";
  const cacheDir = args["cache-dir"] ?? CACHE_DIR;
  const outDir = args["out-dir"] ?? join(import.meta.dirname, "results");
  const typesFilter = args.types?.split(",").map((t) => t.trim());
  const stack = ((args.stack ?? "production") as Stack);
  if (args["rerank-model"]) process.env.DEM_COHERE_RERANK_MODEL = args["rerank-model"];
  const { embed, rerank, label, flushEmbed } = resolveStack(stack);
  const minAbs = Number(args["min-abs"] ?? Math.max(1, Math.round((n * 30) / 500)));

  const effort = args.effort ?? "minimal";
  const extractLlm = new OpenRouterLlm({ apiKey, model: extractModel, reasoningEffort: effort });
  const answerLlm =
    answerModel === extractModel
      ? extractLlm
      : new OpenRouterLlm({ apiKey, model: answerModel, reasoningEffort: args["answer-effort"] ?? effort });
  const judgeLlm = new OpenRouterLlm({ apiKey, model: judgeModel, reasoningEffort: "low" });
  const extractor = createGlmExtractor(extractLlm);
  const extractionCache = new ExtractionCache(cacheDir, extractModel);
  const answerUsage = zero();
  const generate = async ({ system, prompt }: { system: string; prompt: string }) => {
    const response = await answerLlm.chat({ system, user: prompt, maxTokens: 512 });
    addUsage(answerUsage, response.usage);
    return response.text;
  };

  const samples = loadCorpus();
  const filtered = typesFilter
    ? samples.filter((sample) => typesFilter.includes(sample.question_type ?? "(none)"))
    : samples;
  // "spaced" matches the Strata bench's stratifier, so the two harnesses' numbers can be
  // compared. "shortest" reproduces the pre-2026-09-16 easy-slice runs and nothing else.
  const sampler = args.sampler ?? "spaced";
  const extractConcurrency = Number(args["extract-concurrency"] ?? 6);
  // Pin the extraction generation. A prompt edit re-keys the fact cache, so without this any
  // later run cold-extracts the whole corpus (~$7, ~5h) even when the change under test is
  // downstream of extraction. Pinning the generation a baseline was measured on makes a
  // reflect-side arm free AND isolates it: same facts in, only synthesis differs.
  // Only safe when the change under test does NOT touch the extraction prompt.
  const fingerprint = args.fingerprint;
  // Path B: carry a verbatim slice of the source dialogue for the top N evidence rows.
  const sourceExcerpts = Number(args["source-excerpts"] ?? 0);
  // Which rule retires a statement. Unset means the shipped default (`invalidates-previous`),
  // which is what the 87.4% baseline was measured with; `--supersession slot` is the arm.
  const supersession = args.supersession as SupersessionMode | undefined;
  // Row ids, and therefore how retrieval breaks ranking ties. `random` is the shipped default
  // and is not reproducible; see `IdStrategy`. This is the arm.
  const idStrategy = (args["id-strategy"] ?? "random") as IdStrategy;
  if (idStrategy !== "random" && idStrategy !== "content") {
    throw new Error(`--id-strategy must be \`random\` or \`content\`, got ${idStrategy}`);
  }
  if (supersession !== undefined && supersession !== "slot" && supersession !== "invalidates-previous") {
    throw new Error(`--supersession must be \`slot\` or \`invalidates-previous\`, got ${supersession}`);
  }
  // Path A: rows per answer. Default matches src (15); pass 80 to fill the token budget.
  const evidenceRows = Number(args["evidence-rows"] ?? 0);
  const selected =
    sampler === "shortest" ? pickShortest(filtered, n, minAbs) : stratifiedSample(filtered, n);
  console.log(
    `corpus ${samples.length} samples -> selected ${selected.length} (n=${n}, sampler=${sampler}) | extract=${extractModel} | answer=${answerModel} | judge=${judgeModel} | stack=${label} | supersession=${supersession ?? "invalidates-previous (default)"} | ids=${idStrategy} | extraction cache: ${extractionCache.size} entries`,
  );

  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, `run-${new Date().toISOString().slice(0, 10)}-${stack}.jsonl`);
  const done = new Set<string>();
  if (existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as BenchRow;
        if (row.verdict !== "error") done.add(row.question_id);
      } catch {
        /* partial line from an interrupted run — skip */
      }
    }
  }

  const rows: BenchRow[] = [];
  const judgeUsage = zero();

  for (const sample of selected) {
    if (done.has(sample.question_id)) {
      console.log(`skip ${sample.question_id} (already in ${resultsPath})`);
      continue;
    }
    const startedAt = Date.now();
    const memory = createDemMemory({
      path: ":memory:",
      bankId: sample.question_id,
      embed,
      rerank,
      extract: extractor,
      generate,
      ...(supersession !== undefined ? { supersession } : {}),
      idStrategy,
      ...(sourceExcerpts > 0 ? { sourceExcerpts } : {}),
      ...(evidenceRows > 0 ? { rerankPool: Math.max(40, evidenceRows) } : {}),
    });

    const row: BenchRow = {
      question_id: sample.question_id,
      question_type: sample.question_type ?? "(none)",
      verdict: "error",
      reason: "",
      answer: "",
      evidence_rows: 0,
      tokens: 0,
      extract_in: extractor.usage.in,
      extract_out: extractor.usage.out,
      answer_in: 0,
      answer_out: 0,
      judge_in: 0,
      judge_out: 0,
      elapsed_ms: 0,
    };
    const extractBefore = { ...extractor.usage };
    const answerBefore = { ...answerUsage };

    try {
      const sessionIds = sample.haystack_session_ids;
      const jobs = sample.haystack_sessions.map((turns, i) => {
        const sessionId = sessionIds[i] ?? `session-${i}`;
        const date = sample.haystack_dates?.[i];
        const nowIso = date ? sessionDateToIso(date) : new Date().toISOString();
        const dialogue = flattenDialogue(turns as DialogueTurn[]);
        return {
          sessionId,
          nowIso,
          dialogue,
          key: sessionCacheKey(sessionId, dialogue, extractModel, fingerprint),
        };
      });

      const uncached = jobs.filter((job) => extractionCache.get(job.key) === undefined);
      if (fingerprint !== undefined && uncached.length > 0) {
        // Extracting here would run the CURRENT prompt and file the result under the PINNED
        // generation's key, quietly mixing two fact stores in a 65 MB cache and destroying the
        // baseline the pin exists to reproduce. A pinned run is read-only by construction.
        throw new Error(
          `--fingerprint ${fingerprint} is read-only and ${uncached.length} session(s) are not in it ` +
            `(first: ${uncached[0]?.sessionId}). Drop --fingerprint to extract with the current prompt.`,
        );
      }
      await runWithConcurrency(uncached, extractConcurrency, async (job) => {
        const payload = await extractor(job.dialogue, { now: job.nowIso });
        extractionCache.put(job.key, payload.facts);
      });
      extractionCache.flush();
      flushEmbed?.();

      let skipped = 0;
      for (const job of jobs) {
        const facts = extractionCache.get(job.key);
        if (!facts) throw new Error(`extraction cache miss for session ${job.sessionId}`);
        const retained = await memory.retain(
          { facts },
          { now: job.nowIso, ...(sourceExcerpts > 0 ? { sourceText: job.dialogue } : {}) },
        );
        skipped += retained.skipped.length;
      }
      if (skipped > 0) {
        console.log(`  note: ${sample.question_id} dropped ${skipped} unstorable fact(s) from extraction`);
      }

      // The question date is the moment the user is asking, not a time-travel anchor: it
      // grounds relative phrasing in the prompt and must NOT filter the candidate set.
      // Anchoring recall to it evicted otherwise-valid records and cost us answers.
      const asOf = sample.question_date ? sessionDateToIso(sample.question_date) : undefined;
      if (asOf) row.as_of = asOf;
      const reflected = await memory.reflect(sample.question, {
        ...(asOf ? { asOf } : {}),
        ...(evidenceRows > 0 ? { limit: evidenceRows } : {}),
      });
      row.answer = reflected.answer;
      row.evidence_rows = reflected.evidence.length;
      row.tokens = reflected.tokens;
      row.answer_in = answerUsage.in - answerBefore.in;
      row.answer_out = answerUsage.out - answerBefore.out;

      const unanswerable = sample.question_id.endsWith("_abs");
      const judged = await judgeLlm.chat({
        system: JUDGE_SYSTEM,
        user: `Unanswerable: ${unanswerable}\nQuestion: ${sample.question}\nGold answer: ${sample.answer}\nAgent answer: ${reflected.answer}`,
        maxTokens: 120,
      });
      addUsage(judgeUsage, judged.usage);
      row.judge_in = judged.usage.in;
      row.judge_out = judged.usage.out;
      const verdictMatch = judged.text.match(VERDICT_RE);
      row.verdict = verdictMatch?.[1]?.toLowerCase() ?? "uncertain";
      row.reason = (judged.text.match(/REASON:\s*(.+)/i)?.[1] ?? judged.text.trim()).slice(0, 200);
    } catch (error) {
      row.verdict = "error";
      row.reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }

    row.extract_in = extractor.usage.in - extractBefore.in;
    row.extract_out = extractor.usage.out - extractBefore.out;
    row.elapsed_ms = Date.now() - startedAt;
    rows.push(row);
    memory.close();
    appendFileSync(resultsPath, JSON.stringify(row) + "\n");
    console.log(
      `${row.verdict.padEnd(22)} ${row.question_id} [${row.question_type}] evidence=${row.evidence_rows} ${row.elapsed_ms}ms`,
    );
  }

  extractionCache.flush();
  flushEmbed?.();
  const fileRows: BenchRow[] = existsSync(resultsPath)
    ? readFileSync(resultsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as BenchRow];
          } catch {
            return [];
          }
        })
    : [];
  const scored = fileRows.filter((row) => row.verdict !== "error");
  const byType = new Map<string, { correct: number; total: number; abstainedCorrect: number; abstainedWrong: number; uncertain: number }>();
  for (const row of scored) {
    const bucket = byType.get(row.question_type) ?? { correct: 0, total: 0, abstainedCorrect: 0, abstainedWrong: 0, uncertain: 0 };
    bucket.total += 1;
    if (row.verdict === "correct") bucket.correct += 1;
    else if (row.verdict === "abstained-correctly") {
      bucket.correct += 1;
      bucket.abstainedCorrect += 1;
    } else if (row.verdict === "abstained-incorrectly") bucket.abstainedWrong += 1;
    else if (row.verdict === "uncertain") bucket.uncertain += 1;
    byType.set(row.question_type, bucket);
  }
  const totalCorrect = scored.filter((row) => POSITIVE.has(row.verdict)).length;
  const usage = {
    extract: { ...extractor.usage },
    answer: { ...answerUsage },
    judge: { ...judgeUsage },
  };

  console.log("\n=== LongMemEval-S smoke (dem-memory) ===");
  console.log(
    `extract: ${extractModel} | answer: ${answerModel} (effort ${args["answer-effort"] ?? effort}) | judge: ${judgeModel} | stack: ${label} | sampler: ${sampler}`,
  );
  for (const [type, bucket] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = bucket.total === 0 ? 0 : ((bucket.correct / bucket.total) * 100).toFixed(1);
    console.log(
      `${type.padEnd(26)} ${String(bucket.correct).padStart(2)}/${String(bucket.total).padStart(3)} (${pct}%)  abstain-ok=${bucket.abstainedCorrect} abstain-miss=${bucket.abstainedWrong} uncertain=${bucket.uncertain}`,
    );
  }
  const pct = scored.length === 0 ? 0 : ((totalCorrect / scored.length) * 100).toFixed(1);
  console.log(`TOTAL                      ${totalCorrect}/${scored.length} (${pct}%)  errors=${fileRows.length - scored.length}`);
  console.log(
    `tokens: extract in=${usage.extract.in} out=${usage.extract.out} | answer in=${usage.answer.in} out=${usage.answer.out} | judge in=${usage.judge.in} out=${usage.judge.out}`,
  );
  console.log(`results: ${resultsPath}`);
  console.log(`stack used: ${label}. Full production stack additionally requires COHERE_API_KEY for the Cohere cross-encoder.`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
