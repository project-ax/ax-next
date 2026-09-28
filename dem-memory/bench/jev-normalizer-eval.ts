/**
 * The Jev arm of the slot-normalizer eval: does a decision model do what the embedding
 * nearest-neighbour could not — map a relation to a single-valued profile slot, and REFUSE
 * one that is not?
 *
 * Sibling of `bench/normalizer-eval.ts`, which measured the embedding stage to death at rung 0
 * (`docs/plans/2026-09-18-dem-rung0-report.md` §2: 26/32 canonical spellings, 13.2% precision
 * uniform, 20.9% by volume). Same unit, same synonym table in front, same known-bad gate; the
 * stage behind the table is a Jev `choice` question instead of a cosine:
 *
 *   "Is this relation a single-valued profile property of its subject? If so, which one?"
 *   options: the eight slots (with `SLOT_DESCRIPTIONS`) + `none`
 *
 * Jev only ever sees what the table does not spell — exactly the production shape — except in
 * the calibration step, which deliberately asks it about the table's own keys because those
 * are the one population whose correct answer is known by construction.
 *
 * TWO PHASES, run in this order, because the second is only worth paying for if the first
 * passes (a few hundred calls vs tens of thousands):
 *
 *   npx tsx bench/jev-normalizer-eval.ts --phase gate  --banks ~/.cache/ax-memory-bench/task497-banks
 *   npx tsx bench/jev-normalizer-eval.ts --phase sweep --banks ... --mode relation --threshold 0.9 \
 *     --labels bench/jev-labels.json [--write]
 *
 *  gate   1. calibration on the synonym table's 32 keys;
 *         2. the known-bad list (`tests/fixtures/normalizer-known-bad.json`), both input modes;
 *         6. determinism — the same 200 questions three times with the cache bypassed, plus a
 *            check that batching several questions into one call answers like one per call.
 *  sweep  every distinct relation the table does not spell: mapping rate and per-slot counts
 *         across thresholds, over predicates and over facts; the two hand-check samples
 *         (uniform 60, top 60 by fact volume); precision by threshold from the hand labels in
 *         `bench/jev-labels.json` (`--labels`); latency and spend. `--write` emits
 *         `bench/cache/predicate-slots.json` for `bench/supersession-replay.ts --rule slot`,
 *         and refuses to while any known-bad entry maps.
 *
 * CORPUS. `--fingerprint <fp>` reads the bench extraction cache (the rung-0 corpus is
 * `f4752a79`); `--banks <dir>` reads every `facts.db` under a directory of product fact banks
 * (`memory_facts_v1`: about / relation / value). The second exists because the first is
 * gitignored and not on every machine — see the report for which one a number came from.
 *
 * COST. ~$0.00002 per call as billed on 2026-09-28. Spend is metered from `usage.cost` and
 * the run stops at `--cap` (default $5). Every response is cached in
 * `bench/cache/jev/decisions.ndjson`, keyed on (model, state, questions), so a re-run is free.
 *
 * ---------------------------------------------------------------------------------------
 * MEASURED 2026-09-28, `typesafe/jev-1.13-20260917`. JEV PASSES BOTH GATES AND FAILS PRECISION.
 * Full write-up: `docs/plans/2026-09-28-dem-jev-normalizer-report.md`.
 *
 * CORPUS CAVEAT, first: the rung-0 corpus (`f4752a79`, 84,561 predicates) was not on the
 * machine that ran this. The sweep ran on the product fact banks under
 * `~/.cache/ax-memory-bench/task497-banks` — 32,501 facts, 23,591 distinct relations, 87.5%
 * singletons, same head (`stated`, `listed`, `interested_in`, `provided_solution`). The gates
 * (1, 2, 6) do not depend on the corpus; the precision and coverage figures do.
 *
 *   CALIBRATION   Jev's choice agrees on 32/32 canonical spellings (embedding: 26/32).
 *                 Correct AND above the bar: 29/32 at 0.9, 24/32 at 0.95 (`based in` 0.76,
 *                 `language` 0.78, `works at` 0.80) — the table must stay in front.
 *   KNOWN-BAD     22/22 answer `none` in relation mode, 15/15 present in fact mode. BUT
 *                 `works_on` sits at p~0.5 and FLIPPED to works_at@0.55 in the sweep, so the
 *                 gate holds at >= 0.6 and not at 0.5.
 *   DETERMINISM   200 questions x 3 fresh runs, twice: choice differs on 1/200 (`works_on`,
 *                 p 0.50-0.55). The chosen option's probability jitters — spread p95 0.04,
 *                 max 0.12 — so a row within ~0.1 of the bar can gain or lose its slot on a
 *                 `reindex`. Batching 8 per call keeps the choice (200/200) but moves the
 *                 probability enough to change 4-7/200 decisions at 0.9: one per call.
 *
 *   PRECISION of the Jev half (synonym rows excluded), hand-labelled, strict / lenient:
 *                  relation mode                    fact mode (about | relation | value)
 *     0.80    31/68  45.6% / 63.2%            36/57  63.2% / 78.9%
 *     0.90    21/38  55.3% / 65.8%            25/34  73.5% / 91.2%
 *     0.95    15/20  75.0% / 80.0%            18/23  78.3% / 95.7%
 *     0.99     5/6   83.3%                     5/5  100%   <- five predicates, five facts
 *   No threshold with real coverage is clean. The errors are classes, not noise: speech acts
 *   about a role (`described_technology_role`, `clarified_role`), someone else's role
 *   (`pilates_instructor` 0.99, `tennis_instructor_is`), type-of (`is_company` -> works_at),
 *   and near-properties (`age` -> birthday, 10 facts; `located_in` -> lives_in, 12 facts).
 *
 *   COVERAGE at 0.9: 49 predicates / 166 facts (0.51%) relation mode, 45 / 161 fact mode,
 *   against the table's 11 / 106. User-subject facts 113 (relation) / 104 (fact) vs 80.
 *   `pronouns` stays at 0 user facts; `language` gains 3-4, mostly wrong or arguable.
 *
 *   COST AND LATENCY  ~$0.000022 per call; $1.14 for everything above (~48k calls).
 *   p50 206 ms / p95 351 ms per single-question call (23.4k calls).
 *
 * RECOMMENDATION: keep synonym-only in production. Jev is a good REVIEWER, not a good
 * normalizer: use it offline to propose synonym-table additions a human accepts line by line.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadFactsByFingerprint } from "./consolidation-survival.js";
import { CACHE_DIR, parseArgs, runWithConcurrency } from "./harness.js";
import {
  DecisionCache,
  JEV_MODEL,
  JevClient,
  NO_SLOT,
  SpendCapError,
  SpendMeter,
  assignSlotWithJev,
  buildSlotRequest,
  slotFromAnswer,
  type ChoiceAnswer,
  type FactTriple,
  type InputMode,
  type SlotItem,
} from "./jev.js";
import type { KnownBadEntry } from "./normalizer-eval.js";
import { SLOTS, SLOT_SYNONYMS, relationToWords, type Slot } from "../src/slots.js";

const JEV_CACHE_DIR = join(CACHE_DIR, "jev");
const SLOT_MAP_PATH = join(CACHE_DIR, "predicate-slots.json");
const KNOWN_BAD_PATH = join(import.meta.dirname, "../tests/fixtures/normalizer-known-bad.json");

const THRESHOLD_SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];
/** The rung-0 sample sizes, so the two arms' precision figures are over the same shape. */
const TAIL_SAMPLE = 60;
const VOLUME_SAMPLE = 60;
/** The determinism set: the 32 canonical keys, the 22 known-bad, and the rest drawn from the corpus. */
const DETERMINISM_SET = 200;
const DETERMINISM_REPEATS = 3;
/** Generous per-call estimate for the spend meter's reservation; the real bill is ~20x lower. */
const ESTIMATE_PER_CALL = 0.0005;

interface PredicateStat {
  predicate: string;
  facts: number;
  /** Facts about the SPEAKER — what the §4.1 profile block could render. */
  userFacts: number;
  /** One representative fact, for `fact` mode. A user-subject fact when there is one. */
  example: FactTriple;
}

interface Corpus {
  label: string;
  factCount: number;
  stats: Map<string, PredicateStat>;
}

function isUserSubject(about: string): boolean {
  return about === "user" || about.startsWith("user:");
}

function addFact(stats: Map<string, PredicateStat>, fact: FactTriple): void {
  let stat = stats.get(fact.relation);
  if (!stat) {
    stat = { predicate: fact.relation, facts: 0, userFacts: 0, example: fact };
    stats.set(fact.relation, stat);
  }
  stat.facts += 1;
  if (isUserSubject(fact.about)) {
    // Prefer the speaker's own fact as the example: it is the case closure is for.
    if (stat.userFacts === 0) stat.example = fact;
    stat.userFacts += 1;
  }
}

function findFactDbs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...findFactDbs(path));
    else if (name === "facts.db") out.push(path);
  }
  return out;
}

function loadCorpus(args: Record<string, string>): Corpus {
  const stats = new Map<string, PredicateStat>();
  let factCount = 0;
  if (args.banks) {
    const dir = args.banks.replace(/^~(?=\/)/, homedir());
    const dbs = findFactDbs(dir);
    for (const path of dbs) {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare("SELECT about, relation, value FROM memory_facts_v1 ORDER BY id").all() as FactTriple[];
        for (const row of rows) {
          if (!row.relation) continue;
          factCount += 1;
          addFact(stats, row);
        }
      } finally {
        db.close();
      }
    }
    return { label: `banks ${dir} (${dbs.length} facts.db)`, factCount, stats };
  }
  const { fingerprint, bySession } = loadFactsByFingerprint(args["cache-dir"] ?? CACHE_DIR, args.fingerprint);
  for (const sessionId of [...bySession.keys()].sort()) {
    for (const fact of bySession.get(sessionId) ?? []) {
      if (!fact.predicate) continue;
      factCount += 1;
      addFact(stats, { about: fact.subject ?? "", relation: fact.predicate, value: fact.object ?? "" });
    }
  }
  return { label: `extraction cache, fingerprint ${fingerprint}`, factCount, stats };
}

function loadKnownBad(): KnownBadEntry[] {
  return JSON.parse(readFileSync(KNOWN_BAD_PATH, "utf8")) as KnownBadEntry[];
}

interface Label {
  correct: boolean;
  arguable: boolean;
}

/** `bench/jev-labels.json`: `[predicate, slot, correct, arguable]` rows, keyed predicate+slot. */
function loadLabels(path: string | undefined): Map<string, Label> | null {
  if (!path) return null;
  const file = JSON.parse(readFileSync(path, "utf8")) as { labels: Array<[string, string, boolean, boolean]> };
  return new Map(file.labels.map(([p, slot, correct, arguable]) => [`${p}\u0000${slot}`, { correct, arguable }]));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/** Seeded LCG draw — the same generator `normalizer-eval.ts` uses, so a sample is reproducible. */
function seededDraw<T>(items: T[], count: number, seed0 = 0x2f6e2b1): T[] {
  const out: T[] = [];
  const seen = new Set<number>();
  let seed = seed0;
  while (out.length < Math.min(count, items.length)) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const index = seed % items.length;
    if (seen.has(index)) continue;
    seen.add(index);
    const item = items[index];
    if (item !== undefined) out.push(item);
  }
  return out;
}

const fmtP = (answer: ChoiceAnswer | undefined): string =>
  answer === undefined ? "  -  " : Number.isNaN(answer.p) ? " NaN " : answer.p.toFixed(3);

interface Asker {
  /** Ask each item once (batched `batch` per call). Returns answers in item order. */
  ask(items: SlotItem[], mode: InputMode, options?: { batch?: number; bypassCache?: boolean }): Promise<Array<ChoiceAnswer | undefined>>;
  latencies: number[];
  freshCalls: number;
  cachedCalls: number;
  meter: SpendMeter;
}

function makeAsker(apiKey: string, cap: number, concurrency: number): Asker {
  const cache = new DecisionCache(join(JEV_CACHE_DIR, "decisions.ndjson"));
  const meter = new SpendMeter(cap, ESTIMATE_PER_CALL);
  const client = new JevClient({ apiKey, cache, meter });
  const asker: Asker = {
    latencies: [],
    freshCalls: 0,
    cachedCalls: 0,
    meter,
    async ask(items, mode, options = {}) {
      const batch = Math.max(1, options.batch ?? 1);
      const chunks: Array<{ start: number; items: SlotItem[] }> = [];
      for (let i = 0; i < items.length; i += batch) chunks.push({ start: i, items: items.slice(i, i + batch) });
      const out: Array<ChoiceAnswer | undefined> = new Array(items.length).fill(undefined);
      let done = 0;
      let capped: unknown = null;
      await runWithConcurrency(chunks, concurrency, async (chunk) => {
        if (capped) return;
        try {
          const result = await client.decide(buildSlotRequest(chunk.items, mode), options.bypassCache === true);
          chunk.items.forEach((_, index) => {
            out[chunk.start + index] = result.parsed.answers.get(`q${index}`);
          });
          if (result.cached) asker.cachedCalls += 1;
          else {
            asker.freshCalls += 1;
            asker.latencies.push(result.latencyMs);
          }
        } catch (error) {
          if (error instanceof SpendCapError) {
            capped = error;
            return;
          }
          process.stderr.write(`  call failed (${chunk.items.map((i) => i.relation).join(", ")}): ${String(error)}\n`);
        }
        done += 1;
        if (done % 2000 === 0) {
          process.stderr.write(`  ${done}/${chunks.length} calls, $${meter.spent.toFixed(4)} spent\n`);
        }
      });
      if (capped) throw capped;
      return out;
    },
  };
  return asker;
}

// ---------------------------------------------------------------------------------------
// gate: 1 (calibration), 2 (known-bad), 6 (determinism + batching)
// ---------------------------------------------------------------------------------------

async function gate(corpus: Corpus, asker: Asker, summary: Record<string, unknown>): Promise<void> {
  // ---- 1. calibration on the canonical spellings -------------------------------------
  const canonical = [...Object.entries(SLOT_SYNONYMS)] as Array<[string, Slot]>;
  const calAnswers = await asker.ask(canonical.map(([phrase]) => ({ relation: phrase })), "relation");
  let agree = 0;
  const calRows: Array<{ phrase: string; truth: Slot; choice: string; p: number }> = [];
  console.log(`=== 1. calibration: Jev over the synonym table's own ${canonical.length} keys ===`);
  canonical.forEach(([phrase, truth], index) => {
    const answer = calAnswers[index];
    const ok = answer?.choice === truth;
    if (ok) agree += 1;
    calRows.push({ phrase, truth, choice: answer?.choice ?? "ERROR", p: answer?.p ?? Number.NaN });
    console.log(`  ${ok ? "ok  " : "MISS"}  ${phrase.padEnd(20)} -> ${String(answer?.choice).padEnd(9)} ${fmtP(answer)}  (truth ${truth})`);
  });
  const agreeAt = Object.fromEntries(
    THRESHOLD_SWEEP.map((thr) => [
      thr,
      canonical.filter(([, truth], index) => slotFromAnswer(calAnswers[index], thr) === truth).length,
    ]),
  );
  console.log(`\ncalibration: Jev's choice agrees on ${agree}/${canonical.length} canonical spellings (embedding: 26/32)`);
  console.log(`  correct AND above threshold: ${THRESHOLD_SWEEP.map((t) => `${t}: ${agreeAt[t]}`).join("  ")}\n`);
  summary.calibration = { agree, of: canonical.length, agreeAt, rows: calRows };

  // ---- 2. known-bad gate, both modes -------------------------------------------------
  const knownBad = loadKnownBad();
  const kbItems = (mode: InputMode): SlotItem[] =>
    knownBad.map((entry) => {
      const example = corpus.stats.get(entry.predicate)?.example;
      return { relation: entry.predicate, fact: mode === "fact" ? example : undefined };
    });
  const kbResults: Record<string, unknown> = {};
  for (const mode of ["relation", "fact"] as const) {
    // In fact mode, only entries that occur in the corpus have a real fact to show; the rest
    // would be a synthetic triple, which measures nothing about context.
    const items = kbItems(mode);
    const present = items.map((item) => mode === "relation" || item.fact !== undefined);
    const answers = await asker.ask(items.filter((_, i) => present[i]), mode);
    const byIndex: Array<ChoiceAnswer | undefined> = [];
    let cursor = 0;
    for (const isPresent of present) byIndex.push(isPresent ? answers[cursor++] : undefined);

    console.log(`=== 2. known-bad (${mode} mode) ===`);
    const failsAt = Object.fromEntries(THRESHOLD_SWEEP.map((t) => [t, 0]));
    const rows: Array<Record<string, unknown>> = [];
    let refusedOutright = 0;
    let asked = 0;
    knownBad.forEach((entry, index) => {
      const answer = byIndex[index];
      if (!present[index]) {
        console.log(`  --    ${entry.predicate.padEnd(20)} not in corpus; no fact to show`);
        return;
      }
      asked += 1;
      if (answer?.choice === NO_SLOT) refusedOutright += 1;
      for (const thr of THRESHOLD_SWEEP) {
        const slot = slotFromAnswer(answer, thr);
        const bad = entry.mustNotMap === "*" ? slot !== null : slot === entry.mustNotMap;
        if (bad) failsAt[thr] = (failsAt[thr] ?? 0) + 1;
      }
      const slotAt90 = slotFromAnswer(answer, 0.9);
      const badAt90 = entry.mustNotMap === "*" ? slotAt90 !== null : slotAt90 === entry.mustNotMap;
      const fact = items[index]?.fact;
      rows.push({ predicate: entry.predicate, mustNotMap: entry.mustNotMap, choice: answer?.choice, p: answer?.p, fact });
      console.log(
        `  ${badAt90 ? "FAIL" : answer?.choice === NO_SLOT ? "none" : "ok  "}  ${entry.predicate.padEnd(20)} -> ` +
          `${String(answer?.choice).padEnd(9)} ${fmtP(answer)}  must not be ${entry.mustNotMap}` +
          (fact ? `   [${fact.about} | ${fact.relation} | ${fact.value.slice(0, 50)}]` : ""),
      );
    });
    console.log(`  refused outright (chose none): ${refusedOutright}/${asked}`);
    console.log(`  known-bad that MAP, by threshold: ${THRESHOLD_SWEEP.map((t) => `${t}: ${failsAt[t]}`).join("  ")}\n`);
    kbResults[mode] = { asked, refusedOutright, failsAt, rows };
  }
  summary.knownBad = kbResults;

  // ---- 6. determinism ----------------------------------------------------------------
  // The set: every canonical key and every known-bad relation (the two populations where a
  // flip matters most), topped up with a seeded draw of corpus relations the table does not
  // spell — the population Jev would actually see in production.
  const fixed = [...canonical.map(([phrase]) => phrase), ...knownBad.map((entry) => entry.predicate)];
  const fixedWords = new Set(fixed.map(relationToWords));
  const pool = [...corpus.stats.keys()]
    .filter((p) => SLOT_SYNONYMS[relationToWords(p)] === undefined && !fixedWords.has(relationToWords(p)))
    .sort();
  const relations = [...fixed, ...seededDraw(pool, DETERMINISM_SET - fixed.length)];
  const items = relations.map((relation) => ({ relation }));
  const runs: Array<Array<ChoiceAnswer | undefined>> = [];
  const latencyStart = asker.latencies.length;
  for (let run = 0; run < DETERMINISM_REPEATS; run += 1) {
    runs.push(await asker.ask(items, "relation", { bypassCache: true }));
  }
  const freshLatencies = asker.latencies.slice(latencyStart);

  let choiceFlips = 0;
  let maxDeltaP = 0;
  const deltas: number[] = [];
  const decisionFlipsAt = Object.fromEntries(THRESHOLD_SWEEP.map((t) => [t, 0]));
  const flipped: string[] = [];
  const decisionFlips: string[] = [];
  relations.forEach((relation, index) => {
    const answers = runs.map((run) => run[index]);
    const choices = new Set(answers.map((a) => a?.choice ?? "ERROR"));
    if (choices.size > 1) {
      choiceFlips += 1;
      flipped.push(`${relation}: ${answers.map((a) => `${a?.choice}@${fmtP(a)}`).join(" / ")}`);
    }
    // Spread of the probability each run gave the option run 1 chose.
    const option = answers[0]?.choice;
    if (option !== undefined) {
      const ps = answers.map((a) => a?.probabilities[option] ?? (a?.choice === option ? a.p : 0));
      const spread = Math.max(...ps) - Math.min(...ps);
      deltas.push(spread);
      maxDeltaP = Math.max(maxDeltaP, spread);
    }
    for (const thr of THRESHOLD_SWEEP) {
      const decisions = new Set(answers.map((a) => String(slotFromAnswer(a, thr))));
      if (decisions.size > 1) {
        decisionFlipsAt[thr] = (decisionFlipsAt[thr] ?? 0) + 1;
        // A decision flip with a STABLE choice is probability jitter across the bar — the
        // case `reindex` would turn into a row gaining or losing its slot between passes.
        decisionFlips.push(`@${thr} ${relation}: ${answers.map((a) => `${a?.choice}@${fmtP(a)}`).join(" / ")}`);
      }
    }
  });
  console.log(`=== 6. determinism: ${relations.length} questions x ${DETERMINISM_REPEATS} fresh runs (cache bypassed) ===`);
  console.log(`  choice differs across runs:          ${choiceFlips}/${relations.length}`);
  console.log(`  chosen-option probability spread:    p50 ${percentile(deltas, 50).toFixed(3)}, p95 ${percentile(deltas, 95).toFixed(3)}, max ${maxDeltaP.toFixed(3)}`);
  console.log(`  slot DECISION differs, by threshold: ${THRESHOLD_SWEEP.map((t) => `${t}: ${decisionFlipsAt[t]}`).join("  ")}`);
  for (const line of flipped.slice(0, 30)) console.log(`    choice flip   ${line}`);
  for (const line of decisionFlips.slice(0, 30)) console.log(`    decision flip ${line}`);

  // Batching: one more pass, 8 questions per call, against run 1's one-per-call answers.
  const batched = await asker.ask(items, "relation", { batch: 8, bypassCache: true });
  let batchChoiceAgree = 0;
  const batchDecisionDiffAt = Object.fromEntries(THRESHOLD_SWEEP.map((t) => [t, 0]));
  relations.forEach((_, index) => {
    const single = runs[0]?.[index];
    const multi = batched[index];
    if (single?.choice === multi?.choice) batchChoiceAgree += 1;
    for (const thr of THRESHOLD_SWEEP) {
      if (slotFromAnswer(single, thr) !== slotFromAnswer(multi, thr)) batchDecisionDiffAt[thr] = (batchDecisionDiffAt[thr] ?? 0) + 1;
    }
  });
  console.log(`\n  batching (8 per call) vs one per call: choice agrees ${batchChoiceAgree}/${relations.length}; ` +
    `decision differs ${THRESHOLD_SWEEP.map((t) => `${t}: ${batchDecisionDiffAt[t]}`).join("  ")}`);
  console.log(`\n  latency per call (fresh, one question): p50 ${percentile(freshLatencies, 50).toFixed(0)} ms, ` +
    `p95 ${percentile(freshLatencies, 95).toFixed(0)} ms over ${freshLatencies.length} calls`);

  summary.determinism = {
    questions: relations.length,
    repeats: DETERMINISM_REPEATS,
    choiceFlips,
    spread: { p50: percentile(deltas, 50), p95: percentile(deltas, 95), max: maxDeltaP },
    decisionFlipsAt,
    flipped,
    decisionFlips,
    batching: { batch: 8, choiceAgree: batchChoiceAgree, decisionDiffAt: batchDecisionDiffAt },
    latencyMs: { p50: percentile(freshLatencies, 50), p95: percentile(freshLatencies, 95), n: freshLatencies.length },
  };
}

// ---------------------------------------------------------------------------------------
// sweep: 3 (precision samples), 4 (threshold sweep), 5 (per-slot counts), 7 (latency, cost)
// ---------------------------------------------------------------------------------------

async function sweep(
  corpus: Corpus,
  asker: Asker,
  mode: InputMode,
  threshold: number,
  batch: number,
  write: boolean,
  summary: Record<string, unknown>,
  args: Record<string, string>,
): Promise<void> {
  const predicates = [...corpus.stats.keys()].sort();
  const asked = predicates.filter((p) => SLOT_SYNONYMS[relationToWords(p)] === undefined);
  console.log(
    `${predicates.length} distinct predicates, ${predicates.length - asked.length} answered by the synonym table; ` +
      `asking Jev about ${asked.length} (${mode} mode, ${batch} per call)`,
  );
  const answers = await asker.ask(
    asked.map((relation) => ({ relation, fact: corpus.stats.get(relation)?.example })),
    mode,
    { batch },
  );
  const answerOf = new Map<string, ChoiceAnswer | undefined>();
  asked.forEach((relation, index) => answerOf.set(relation, answers[index]));
  const unanswered = asked.filter((p) => answerOf.get(p) === undefined).length;
  if (unanswered > 0) console.log(`  WARNING: ${unanswered} predicate(s) got no answer (failed calls); counted as no slot`);

  // ---- 4. threshold sweep ------------------------------------------------------------
  console.log(`\n=== threshold sweep (${mode} mode) ===`);
  console.log("  thr    mapped-predicates        mapped-facts     user-facts");
  const sweepRows: Array<Record<string, number>> = [];
  for (const thr of THRESHOLD_SWEEP) {
    let mp = 0;
    let mf = 0;
    let mu = 0;
    for (const p of predicates) {
      if (assignSlotWithJev(p, answerOf.get(p), thr).slot === null) continue;
      const stat = corpus.stats.get(p);
      mp += 1;
      mf += stat?.facts ?? 0;
      mu += stat?.userFacts ?? 0;
    }
    sweepRows.push({ threshold: thr, predicates: mp, facts: mf, userFacts: mu });
    console.log(
      `  ${thr.toFixed(2)}  ${String(mp).padStart(7)} (${((mp / predicates.length) * 100).toFixed(2)}%)   ` +
        `${String(mf).padStart(8)} (${((mf / corpus.factCount) * 100).toFixed(2)}%)   ${String(mu).padStart(7)}`,
    );
  }

  // ---- 3/4. precision by threshold, from hand labels ---------------------------------
  // Jev rows only: synonym rows are correct by construction and are excluded rather than
  // used to inflate the figure — the rung-0 counting rule. `lenient` counts the labels
  // marked arguable as correct; a mapping to a slot nobody labelled is reported, not guessed.
  const labels = loadLabels(args.labels);
  let precisionRows: Array<Record<string, number>> = [];
  if (labels) {
    console.log(`\n=== precision of the Jev half, by threshold (labels: ${args.labels}) ===`);
    console.log("  thr    jev-preds  strict            lenient           unlabelled   jev-facts  strict-by-facts");
    precisionRows = THRESHOLD_SWEEP.map((thr) => {
      let n = 0;
      let strict = 0;
      let lenient = 0;
      let unlabelled = 0;
      let facts = 0;
      let strictFacts = 0;
      for (const p of asked) {
        const slot = slotFromAnswer(answerOf.get(p), thr);
        if (slot === null) continue;
        const label = labels.get(`${p}\u0000${slot}`);
        const f = corpus.stats.get(p)?.facts ?? 0;
        if (!label) {
          unlabelled += 1;
          continue;
        }
        n += 1;
        facts += f;
        if (label.correct) {
          strict += 1;
          strictFacts += f;
        }
        if (label.correct || label.arguable) lenient += 1;
      }
      const pct = (a: number, b: number): string => (b === 0 ? "   n/a" : `${((a / b) * 100).toFixed(1)}%`.padStart(6));
      console.log(
        `  ${thr.toFixed(2)}  ${String(n).padStart(8)}  ${String(strict).padStart(4)} ${pct(strict, n)}     ` +
          `${String(lenient).padStart(4)} ${pct(lenient, n)}     ${String(unlabelled).padStart(6)}   ${String(facts).padStart(8)}  ${pct(strictFacts, facts)}`,
      );
      return { threshold: thr, labelled: n, strict, lenient, unlabelled, facts, strictFacts };
    });
  }

  // ---- 5. per-slot counts at the chosen threshold ------------------------------------
  const assigned = new Map<string, { slot: Slot; via: string; p: number; facts: number }>();
  const perSlot = new Map<Slot, { predicates: number; facts: number; userFacts: number }>();
  for (const slot of SLOTS) perSlot.set(slot, { predicates: 0, facts: 0, userFacts: 0 });
  for (const p of predicates) {
    const answer = answerOf.get(p);
    const result = assignSlotWithJev(p, answer, threshold);
    if (result.slot === null) continue;
    const stat = corpus.stats.get(p);
    assigned.set(p, { slot: result.slot, via: result.via, p: result.via === "synonym" ? 1 : (answer?.p ?? 0), facts: stat?.facts ?? 0 });
    const bucket = perSlot.get(result.slot);
    if (bucket) {
      bucket.predicates += 1;
      bucket.facts += stat?.facts ?? 0;
      bucket.userFacts += stat?.userFacts ?? 0;
    }
  }
  console.log(`\n=== per slot at threshold ${threshold} (userFacts = what the §4.1 profile block could render) ===`);
  console.log("  slot          predicates      facts  userFacts");
  for (const slot of SLOTS) {
    const b = perSlot.get(slot) ?? { predicates: 0, facts: 0, userFacts: 0 };
    console.log(`  ${slot.padEnd(12)}${String(b.predicates).padStart(10)}${String(b.facts).padStart(11)}${String(b.userFacts).padStart(11)}`);
  }

  // ---- 3. the two hand-check samples -------------------------------------------------
  const row = (p: string): Record<string, unknown> => {
    const entry = assigned.get(p);
    const ex = corpus.stats.get(p)?.example;
    return { predicate: p, slot: entry?.slot, via: entry?.via, p: entry?.p, facts: entry?.facts, example: ex };
  };
  const print = (title: string, keys: string[]): void => {
    console.log(`\n=== ${title} ===`);
    console.log("  facts      p  via       slot        predicate   [example]");
    for (const key of keys) {
      const entry = assigned.get(key);
      const ex = corpus.stats.get(key)?.example;
      if (!entry) continue;
      console.log(
        `  ${String(entry.facts).padStart(5)}  ${entry.p.toFixed(3)}  ${entry.via.padEnd(8)}  ${entry.slot.padEnd(10)}  ${key}` +
          (ex ? `   [${ex.about} | ${ex.value.slice(0, 60)}]` : ""),
      );
    }
  };
  const mappedKeys = [...assigned.keys()].sort();
  const uniform = seededDraw(mappedKeys, TAIL_SAMPLE);
  const volume = [...assigned.entries()]
    .sort((a, b) => b[1].facts - a[1].facts || a[0].localeCompare(b[0]))
    .slice(0, VOLUME_SAMPLE)
    .map(([key]) => key);
  print(`uniform random sample of ${uniform.length} mapped predicates`, uniform);
  print(`top ${volume.length} mapped predicates by fact volume`, volume);

  // Everything Jev mapped at a looser bar, for labelling beyond the two samples.
  const loose = asked
    .filter((p) => slotFromAnswer(answerOf.get(p), THRESHOLD_SWEEP[0] ?? 0.5) !== null)
    .map((p) => ({ ...row(p), choice: answerOf.get(p)?.choice, p: answerOf.get(p)?.p }));

  // ---- 2 again, on the sweep's own answers -------------------------------------------
  const knownBad = loadKnownBad();
  let knownBadFailures = 0;
  for (const entry of knownBad) {
    const inCorpus = corpus.stats.has(entry.predicate);
    if (!inCorpus) continue;
    const slot = assignSlotWithJev(entry.predicate, answerOf.get(entry.predicate), threshold).slot;
    const bad = entry.mustNotMap === "*" ? slot !== null : slot === entry.mustNotMap;
    if (bad) {
      knownBadFailures += 1;
      console.log(`  KNOWN-BAD FAIL  ${entry.predicate} -> ${slot}`);
    }
  }
  console.log(`\nknown-bad in corpus that map at ${threshold}: ${knownBadFailures}`);

  // ---- 7. latency and cost -----------------------------------------------------------
  const lat = asker.latencies;
  console.log(
    `\ncalls: ${asker.freshCalls} fresh, ${asker.cachedCalls} cached; latency p50 ${percentile(lat, 50).toFixed(0)} ms, ` +
      `p95 ${percentile(lat, 95).toFixed(0)} ms (fresh calls, ${batch} question(s) each); spend this run $${asker.meter.spent.toFixed(4)}`,
  );

  summary.sweep = {
    mode,
    threshold,
    batch,
    predicates: predicates.length,
    askedJev: asked.length,
    unanswered,
    facts: corpus.factCount,
    sweep: sweepRows,
    perSlot: Object.fromEntries(perSlot),
    uniformSample: uniform.map(row),
    volumeSample: volume.map(row),
    looseMapped: loose,
    knownBadFailures,
    precision: precisionRows,
  };

  if (write && knownBadFailures > 0) {
    console.log(`\nREFUSING to write ${SLOT_MAP_PATH}: ${knownBadFailures} known-bad predicate(s) map at ${threshold}.`);
  } else if (write) {
    writeFileSync(
      SLOT_MAP_PATH,
      JSON.stringify({
        fingerprint: corpus.label,
        threshold,
        normalizer: `jev:${JEV_MODEL}:${mode}`,
        generatedAt: new Date().toISOString(),
        slots: Object.fromEntries([...assigned.entries()].map(([p, entry]) => [p, entry.slot])),
      }),
    );
    console.log(`\nwrote ${assigned.size} predicate -> slot assignments to ${SLOT_MAP_PATH}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be in the environment");
  const phase = args.phase ?? "gate";
  const cap = Number(args.cap ?? 5);
  const concurrency = Number(args.concurrency ?? 16);
  mkdirSync(JEV_CACHE_DIR, { recursive: true });

  const corpus = loadCorpus(args);
  const singletons = [...corpus.stats.values()].filter((s) => s.facts === 1).length;
  console.log(
    `corpus: ${corpus.label}\n  ${corpus.factCount} facts, ${corpus.stats.size} distinct predicates, ` +
      `${((singletons / Math.max(1, corpus.stats.size)) * 100).toFixed(1)}% singletons\n`,
  );

  const asker = makeAsker(apiKey, cap, concurrency);
  const summary: Record<string, unknown> = { phase, corpus: corpus.label, model: JEV_MODEL, at: new Date().toISOString() };
  try {
    if (phase === "gate") await gate(corpus, asker, summary);
    else if (phase === "sweep") {
      const mode = (args.mode ?? "relation") as InputMode;
      await sweep(corpus, asker, mode, Number(args.threshold ?? 0.9), Number(args.batch ?? 1), args.write === "true", summary, args);
    } else throw new Error(`unknown --phase ${phase}`);
  } finally {
    summary.spend = asker.meter.spent;
    summary.calls = { fresh: asker.freshCalls, cached: asker.cachedCalls };
    const suffix = phase === "sweep" ? `-${args.mode ?? "relation"}` : "";
    const out = join(JEV_CACHE_DIR, `summary-${phase}${suffix}.json`);
    if (existsSync(JEV_CACHE_DIR)) writeFileSync(out, JSON.stringify(summary, null, 2));
    console.log(`\nspend this run: $${asker.meter.spent.toFixed(5)} (cap $${cap}); summary -> ${out}`);
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
