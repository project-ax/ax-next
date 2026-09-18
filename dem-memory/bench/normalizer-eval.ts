/**
 * Rung 0 of the DEM-first ladder: does a deterministic, post-extraction normalizer give
 * "active" a meaning without closing true facts?
 *
 * `bench/supersession-replay.ts` shows why the question matters: DEM's supersession keys on
 * `predicate`, and `predicate` is free text — 84,561 distinct values, 86.8% singletons — so
 * exact matching finds nothing 91.8% of the time and, when it does match, closes up to 622
 * rows at once. §3.3 of `docs/plans/2026-09-18-dem-first-memory-design.md` answers that by
 * deriving a `slot` from the relation and closing only within a slot. This script measures
 * the derivation.
 *
 * It changes NOTHING about extraction. Slots are computed from cached facts pinned to one
 * fingerprint, so the prompt behind 87.4% stays pinned and the normalizer's effect is
 * measurable in isolation.
 *
 * WHAT IT REPORTS
 *  - mapping rate over DISTINCT predicates and over FACTS, swept across thresholds;
 *  - per-slot counts at the chosen threshold;
 *  - the top-200 mapped predicates by fact volume — the hand-check precision sample;
 *  - near misses just under the threshold, which is where the known-bad fixture comes from;
 *  - the known-bad list (`tests/fixtures/normalizer-known-bad.json`) as a pass/fail gate.
 *
 * THE ERROR IS ASYMMETRIC, and the threshold is chosen accordingly. A false positive
 * (`visited` -> `lives_in`) CLOSES A TRUE FACT and is unrecoverable from the read path. A
 * false negative leaves the row with no slot, which is exactly the measured baseline — the
 * 87.4% was scored with supersession effectively off. So the threshold is set where the
 * precision sample is clean, not where the mapping rate looks impressive.
 *
 *   npx tsx bench/normalizer-eval.ts --fingerprint f4752a79
 *   npx tsx bench/normalizer-eval.ts --fingerprint f4752a79 --threshold 0.72 --write
 *
 * `--write` emits `bench/cache/predicate-slots.json`, which `bench/supersession-replay.ts
 * --rule slot` reads. It is derived data and lives under the gitignored cache directory.
 *
 * COST. ~84.5k relation phrases at 5 instances per Vertex call, ~$0.07 and ~12 minutes cold.
 * The run is RESUMABLE: only the per-slot cosines are persisted (~11 MB), so re-running
 * after a crash scores only what is missing.
 *
 * ---------------------------------------------------------------------------------------
 * MEASURED 2026-09-18 over `f4752a79` (84,561 distinct predicates, 86.8% singletons).
 * THE EMBEDDING NEAREST-NEIGHBOUR DOES NOT WORK. Full write-up:
 * `docs/plans/2026-09-18-dem-rung0-report.md` §2.
 *
 *   CALIBRATION, on truth that needs no hand-labelling — the rule over the synonym table's
 *   own keys, which ARE canonical spellings of their slot:
 *     nearest slot agrees on 26 of 32.  first name -> birthday (0.834)
 *                                       last name  -> birthday (0.816)
 *                                       full name  -> birthday (0.815)
 *                                       born on    -> name     (0.719)
 *                                       goes by    -> timezone (0.658)
 *                                       works as   -> name     (0.647)
 *
 *   MAPPING RATE   0.65: 20.60% of predicates / 26.57% of facts
 *                  0.72:  1.51% / 2.17%      0.78: 0.13% / 0.44%
 *                  0.88+: 0.03% / 0.34%  <- exactly the 22 synonym entries; the embedding
 *                                           half maps NOTHING above 0.88
 *
 *   PRECISION at 0.78, hand-checked, embedding rows only (synonyms are correct by
 *   construction and excluded rather than used to inflate it):
 *     uniform random draw of 60 mapped predicates   7 of 53  = 13.2%
 *     top 60 mapped predicates by fact volume       9 of 43  = 20.9%
 *
 * WHY IT IS STRUCTURAL, not a wording accident: eight descriptions partition the whole
 * predicate space into eight nearest-neighbour cells and the threshold only decides how much
 * of each cell to admit. `birthday` became the cell for anything date- or number-shaped about
 * a person (home_address 0.811, death_date 0.813, annual_gross_income 0.799, country_of_birth
 * 0.796, college_graduation_date 0.801); `pronouns` became the cell for anything about
 * identity (grammar_characteristics 0.790, described_narrator 0.794, stated_pronunciation
 * 0.814). A slot cannot refuse a relation, only be further away than another slot.
 *
 * RECOMMENDED CONFIGURATION: the synonym table alone (threshold >= 0.88). 22 predicates, 442
 * facts (0.34%), precision 100% by construction and auditable line by line. Per-slot user-
 * subject facts — what the §4.1 profile block could render — are lives_in 175, role 118,
 * works_at 51, birthday 2, name 1, timezone 1, and ZERO for `pronouns` and `language`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVertexEmbedder } from "../src/models/embeddings.js";
// One reader for the extraction cache. `consolidation-survival.ts` already owns it and
// documents why it bypasses `ExtractionCache` (that constructor migrates and flushes, which
// would rewrite 65 MB as a side effect of a read-only analysis).
import { loadFactsByFingerprint } from "./consolidation-survival.js";
import { CACHE_DIR, parseArgs, runWithConcurrency } from "./harness.js";
import {
  SLOTS,
  SLOT_DESCRIPTIONS,
  SLOT_SYNONYMS,
  assignSlotFromScores,
  cosine,
  relationToWords,
  slotSignature,
  type Slot,
} from "../src/slots.js";

/**
 * Relation scores get their OWN cache directory, away from `bench/cache/embeddings.ndjson`.
 *
 * That file is 1.5 GB of statement and query vectors which every bench run loads into memory
 * in full; adding ~85k relation entries to it would make every future run pay for a
 * measurement it is not doing.
 */
const PREDICATE_CACHE_DIR = join(CACHE_DIR, "predicates");
const SLOT_MAP_PATH = join(CACHE_DIR, "predicate-slots.json");
const KNOWN_BAD_PATH = join(import.meta.dirname, "../tests/fixtures/normalizer-known-bad.json");

const THRESHOLD_SWEEP = [0.65, 0.7, 0.72, 0.75, 0.78, 0.8, 0.82, 0.85, 0.88, 0.9, 0.95];
const DEFAULT_THRESHOLD = 0.72;
/** Vertex takes 5 instances per call; the embedder is serial inside one call. */
const EMBED_CHUNK = 5;
/**
 * ~5 req/s at this chunk size, well inside the project's per-minute online-prediction
 * quota for the base model. 12 was not: it returned 429 and killed the job (see `scoreAll`).
 */
const EMBED_CONCURRENCY = 5;
/** The embedder retries 4 times internally; this is the outer, more patient loop. */
const EMBED_ATTEMPTS = 6;
/** Append to the cache this often, so a crash costs a batch rather than the whole job. */
const FLUSH_EVERY = 2000;
/**
 * How far below the threshold a rejection still counts as a "near miss".
 *
 * Only a reporting window — it decides what gets printed for hand-inspection, never what
 * gets mapped. Widen it to see more of what a looser bar would admit.
 */
const NEAR_MISS_BAND = 0.08;
/**
 * Size of the uniform random draw over mapped predicates.
 *
 * The volume sample covers the high-impact end; 86.8% of predicates are singletons, so a
 * uniform draw is the only thing that says anything about the tail.
 */
const TAIL_SAMPLE = 60;

export interface KnownBadEntry {
  predicate: string;
  /** The slot this predicate must NOT be assigned. `"*"` means it must get no slot at all. */
  mustNotMap: Slot | "*";
  why: string;
}

interface PredicateStat {
  predicate: string;
  facts: number;
  /**
   * Facts whose subject is the SPEAKER (`user`).
   *
   * Tracked because §4.1's profile block renders active slot rows `about = user:<caller>`. A
   * slot that only ever attaches to `assistant` or to a third-party entity closes rows but
   * puts nothing in the profile, so the two jobs the slot list is meant to do — supersession
   * key and profile whitelist — would come apart.
   */
  userFacts: number;
  subjects: Set<string>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

/**
 * Append-only cache of per-slot COSINES, one line per relation phrase.
 *
 * Deliberately not `embedCacheWrap`: that stores the 384-dimensional vector, and nothing
 * downstream reads a vector — only the eight cosines. Storing vectors cost 7.8 KB a
 * relation, and the first full run filled the disk and died at 71%. This is ~120 bytes a
 * relation, ~10 MB for the whole predicate space.
 *
 * The file name carries `slotSignature(task)`, so a changed slot description or task type
 * starts a new cache rather than silently mixing two scales of cosine.
 */
class SlotCosineCache {
  readonly path: string;
  private readonly entries = new Map<string, number[]>();
  private readonly pending: string[] = [];

  constructor(dir: string, signature: string) {
    this.path = join(dir, `slot-cosines-${signature}.ndjson`);
    if (!existsSync(this.path)) return;
    // Buffer + per-line slice, matching `embedCacheWrap`: a whole-file utf8 read is the
    // ceiling the ndjson format exists to duck, and a line torn by a kill costs that line.
    const buffer = readFileSync(this.path);
    let start = 0;
    while (start < buffer.length) {
      let end = buffer.indexOf(0x0a, start);
      if (end === -1) end = buffer.length;
      if (end > start) {
        try {
          const record = JSON.parse(buffer.toString("utf8", start, end)) as {
            k?: string;
            c?: number[];
          };
          if (typeof record.k === "string" && Array.isArray(record.c)) {
            this.entries.set(record.k, record.c);
          }
        } catch {
          /* one unreadable line costs that relation, not the file */
        }
      }
      start = end + 1;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(phrase: string): boolean {
    return this.entries.has(phrase);
  }

  get(phrase: string): number[] | undefined {
    return this.entries.get(phrase);
  }

  put(phrase: string, scores: number[]): void {
    const rounded = scores.map((score) => Math.round(score * 1e6) / 1e6);
    this.entries.set(phrase, rounded);
    this.pending.push(JSON.stringify({ k: phrase, c: rounded }));
  }

  flush(): void {
    if (this.pending.length === 0) return;
    appendFileSync(this.path, `${this.pending.join("\n")}\n`);
    this.pending.length = 0;
  }
}

/**
 * Embed a large relation set and keep only its slot cosines — politely and resumably.
 *
 * Three things this has to get right, all learned the hard way on the first two runs:
 *
 *  - CONCURRENCY IS A QUOTA, NOT A THROUGHPUT DIAL. 12 workers over 5-instance calls is
 *    ~95 requests/s, which exceeds the project's per-minute `online_prediction_requests`
 *    quota for the base model and returns 429. The embedder's own retry gives up after 4
 *    attempts, so the job dies rather than slowing down.
 *  - FLUSH AS YOU GO. The cache is the resume mechanism, and a flush that only happens at
 *    the end means a crash at 85% loses everything — which is what run 1 did, discarding
 *    ~13k paid-for embeddings.
 *  - RETRY THE CHUNK, NOT THE JOB. A 429 late in a long job is a rate signal, not a
 *    failure; back off and re-ask for the same five texts.
 */
async function scoreAll(
  phrases: string[],
  embed: (texts: string[], task?: "document" | "query") => Promise<number[][]>,
  slotVectors: ReadonlyMap<Slot, number[]>,
  cache: SlotCosineCache,
): Promise<void> {
  if (phrases.length === 0) return;
  const chunks: string[][] = [];
  for (let i = 0; i < phrases.length; i += EMBED_CHUNK) {
    chunks.push(phrases.slice(i, i + EMBED_CHUNK));
  }

  let done = 0;
  let sinceFlush = 0;
  let lastReport = 0;
  const started = Date.now();
  await runWithConcurrency(chunks, EMBED_CONCURRENCY, async (chunk) => {
    let vectors: number[][] | null = null;
    for (let attempt = 0; attempt < EMBED_ATTEMPTS && vectors === null; attempt += 1) {
      try {
        vectors = await embed(chunk, "document");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const throttled = message.includes("(429") || message.includes("(5");
        if (!throttled || attempt === EMBED_ATTEMPTS - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      }
    }
    chunk.forEach((phrase, index) => {
      const vector = vectors?.[index];
      if (!vector || vector.length === 0) return;
      cache.put(
        phrase,
        SLOTS.map((slot) => {
          const slotVector = slotVectors.get(slot);
          return slotVector ? cosine(vector, slotVector) : Number.NEGATIVE_INFINITY;
        }),
      );
    });
    done += chunk.length;
    sinceFlush += chunk.length;
    if (sinceFlush >= FLUSH_EVERY) {
      sinceFlush = 0;
      cache.flush();
    }
    if (done - lastReport >= 5000) {
      lastReport = done;
      const rate = done / Math.max(1, (Date.now() - started) / 1000);
      const remaining = (phrases.length - done) / Math.max(1, rate);
      process.stderr.write(
        `  scoring: ${done}/${phrases.length} (${rate.toFixed(0)}/s, ~${Math.ceil(remaining / 60)}m left)\n`,
      );
    }
  });
  cache.flush();
}

function loadKnownBad(): KnownBadEntry[] {
  if (!existsSync(KNOWN_BAD_PATH)) return [];
  return JSON.parse(readFileSync(KNOWN_BAD_PATH, "utf8")) as KnownBadEntry[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cacheDir = args["cache-dir"] ?? CACHE_DIR;
  const threshold = Number(args.threshold ?? DEFAULT_THRESHOLD);
  const sampleSize = Number(args.sample ?? 200);
  const write = args.write === "true";
  const descriptionTask = (args["description-task"] ?? "document") as "document" | "query";

  const { fingerprint, bySession, available } = loadFactsByFingerprint(cacheDir, args.fingerprint);

  // ---- 1. the predicate space -------------------------------------------------------
  const stats = new Map<string, PredicateStat>();
  let factCount = 0;
  for (const facts of bySession.values()) {
    for (const fact of facts) {
      const predicate = fact.predicate ?? "";
      if (predicate === "") continue;
      factCount += 1;
      let stat = stats.get(predicate);
      if (!stat) {
        stat = { predicate, facts: 0, userFacts: 0, subjects: new Set() };
        stats.set(predicate, stat);
      }
      stat.facts += 1;
      if (fact.subject === "user") stat.userFacts += 1;
      stat.subjects.add(fact.subject ?? "");
    }
  }
  const predicates = [...stats.keys()];
  const singletons = predicates.filter((p) => (stats.get(p)?.facts ?? 0) === 1).length;

  console.log(`extraction generations in cache: ${[...available.entries()]
    .map(([fp, n]) => `${fp} (${n} sessions)`)
    .join(", ")}`);
  console.log(
    `measuring ${fingerprint}: ${bySession.size} sessions, ${factCount} facts, ` +
      `${predicates.length} distinct predicates, ${((singletons / predicates.length) * 100).toFixed(1)}% singletons\n`,
  );

  // ---- 2. score every relation against every slot -----------------------------------
  // `document` for the relation side, matching the write path exactly: the same task type
  // the statement embedding uses, so a production normalizer re-uses one embedder rather
  // than needing a second calibration.
  //
  // Vectors are NOT persisted — the eight cosines are. See `assignSlotFromScores`.
  mkdirSync(PREDICATE_CACHE_DIR, { recursive: true });
  const embed = createVertexEmbedder();
  const cache = new SlotCosineCache(PREDICATE_CACHE_DIR, slotSignature(descriptionTask));
  console.log(
    `slot-cosine cache ${cache.path}: ${cache.size} relation(s) already scored` +
      ` for signature ${slotSignature(descriptionTask)}`,
  );

  const slotVectors = new Map<Slot, number[]>();
  {
    const slotTexts = SLOTS.map((slot) => SLOT_DESCRIPTIONS[slot]);
    const vectors = await embed(slotTexts, descriptionTask);
    SLOTS.forEach((slot, index) => {
      const vector = vectors[index];
      if (!vector) throw new Error(`no embedding for slot description ${slot}`);
      slotVectors.set(slot, vector);
    });
  }

  // Everything the synonym table already answers is skipped: it never consults a vector,
  // so embedding it would be paying for a value nothing reads.
  const needsVector = predicates.filter((p) => SLOT_SYNONYMS[relationToWords(p)] === undefined);
  const words = [...new Set(needsVector.map(relationToWords))].filter((w) => w.length > 0);
  const pending = words.filter((word) => !cache.has(word));
  console.log(
    `${words.length} distinct relation phrases ` +
      `(${predicates.length - needsVector.length} answered by the synonym table); ` +
      `${pending.length} still to score`,
  );
  await scoreAll(pending, embed, slotVectors, cache);
  cache.flush();
  console.log("");

  const scoresOf = (predicate: string): number[] | undefined =>
    cache.get(relationToWords(predicate));

  // ---- 2b. calibration on known truth -----------------------------------------------
  // The cheapest honest test of the nearest-neighbour rule, and the only one that needs no
  // hand-labelling: run it over the synonym table's own keys, where the correct slot is
  // known by construction because the phrase is a canonical spelling of it. If the embedder
  // cannot place `first name`, it cannot place `assigned_role`.
  {
    const phrases = Object.keys(SLOT_SYNONYMS);
    const vectors = await embed(phrases, "document");
    let agree = 0;
    const disagreements: string[] = [];
    phrases.forEach((phrase, index) => {
      const truth = SLOT_SYNONYMS[relationToWords(phrase)];
      const vector = vectors[index];
      if (truth === undefined || !vector) return;
      let best: Slot | null = null;
      let bestScore = -Infinity;
      for (const slot of SLOTS) {
        const slotVector = slotVectors.get(slot);
        if (!slotVector) continue;
        const score = cosine(vector, slotVector);
        if (score > bestScore) {
          bestScore = score;
          best = slot;
        }
      }
      if (best === truth) agree += 1;
      else disagreements.push(`${phrase} -> ${String(best)} (${bestScore.toFixed(3)}), not ${truth}`);
    });
    console.log(
      `calibration: the nearest slot agrees with the hand-assigned slot on ` +
        `${agree}/${phrases.length} CANONICAL spellings`,
    );
    for (const line of disagreements) console.log(`  MISPLACED  ${line}`);
    console.log("");
  }

  // ---- 3. threshold sweep -----------------------------------------------------------
  console.log(`threshold sweep (description task: ${descriptionTask})`);
  console.log("  thr   mapped-predicates        mapped-facts");
  for (const candidate of THRESHOLD_SWEEP) {
    let mappedPredicates = 0;
    let mappedFacts = 0;
    for (const predicate of predicates) {
      const result = assignSlotFromScores(predicate, scoresOf(predicate), candidate);
      if (result.slot !== null) {
        mappedPredicates += 1;
        mappedFacts += stats.get(predicate)?.facts ?? 0;
      }
    }
    console.log(
      `  ${candidate.toFixed(2)}  ${String(mappedPredicates).padStart(7)} ` +
        `(${((mappedPredicates / predicates.length) * 100).toFixed(2)}%)   ` +
        `${String(mappedFacts).padStart(8)} (${((mappedFacts / factCount) * 100).toFixed(2)}%)`,
    );
  }
  console.log("");

  // ---- 4. the chosen threshold ------------------------------------------------------
  const assigned = new Map<string, { slot: Slot; via: string; score: number; facts: number }>();
  const nearMisses: Array<{ predicate: string; slot: Slot; score: number; facts: number }> = [];
  const perSlot = new Map<Slot, { predicates: number; facts: number; userFacts: number }>();
  for (const slot of SLOTS) perSlot.set(slot, { predicates: 0, facts: 0, userFacts: 0 });

  for (const predicate of predicates) {
    const facts = stats.get(predicate)?.facts ?? 0;
    const result = assignSlotFromScores(predicate, scoresOf(predicate), threshold);
    if (result.slot !== null) {
      assigned.set(predicate, { slot: result.slot, via: result.via, score: result.score, facts });
      const bucket = perSlot.get(result.slot);
      if (bucket) {
        bucket.predicates += 1;
        bucket.facts += facts;
        bucket.userFacts += stats.get(predicate)?.userFacts ?? 0;
      }
      continue;
    }
    // A near miss is a relation the embedder ranked nearest to a slot but that did not
    // clear the bar. This is the population a looser threshold admits next, so it is where
    // the known-bad fixture comes from.
    if (result.nearest !== null && result.score >= threshold - NEAR_MISS_BAND) {
      nearMisses.push({ predicate, slot: result.nearest, score: result.score, facts });
    }
  }

  const mappedFacts = [...assigned.values()].reduce((sum, entry) => sum + entry.facts, 0);
  console.log(`=== threshold ${threshold} ===`);
  console.log(
    `mapped: ${assigned.size}/${predicates.length} predicates (${((assigned.size / predicates.length) * 100).toFixed(2)}%), ` +
      `${mappedFacts}/${factCount} facts (${((mappedFacts / factCount) * 100).toFixed(2)}%)`,
  );
  console.log("\nper slot (userFacts = what the \u00a74.1 profile block could actually render):");
  console.log("  slot          predicates      facts  userFacts");
  for (const slot of SLOTS) {
    const bucket = perSlot.get(slot) ?? { predicates: 0, facts: 0, userFacts: 0 };
    console.log(
      `  ${slot.padEnd(12)}${String(bucket.predicates).padStart(10)}${String(bucket.facts).padStart(11)}` +
        `${String(bucket.userFacts).padStart(11)}`,
    );
  }

  // ---- 5. the precision sample ------------------------------------------------------
  const sample = [...assigned.entries()]
    .sort((a, b) => b[1].facts - a[1].facts || a[0].localeCompare(b[0]))
    .slice(0, sampleSize);
  console.log(`\n=== top ${sample.length} mapped predicates by fact volume (hand-check sample) ===`);
  console.log("  facts  score  via       slot          predicate");
  for (const [predicate, entry] of sample) {
    console.log(
      `  ${String(entry.facts).padStart(5)}  ${entry.score.toFixed(3)}  ${entry.via.padEnd(9)} ` +
        `${entry.slot.padEnd(12)}  ${predicate}`,
    );
  }

  // The volume sample is the high-impact end, but 86.8% of predicates are singletons, so it
  // says nothing about the tail — and the tail is where a false positive hides. A uniform
  // draw over the mapped set, with a fixed seed so the hand-check is reproducible.
  const mappedKeys = [...assigned.keys()].sort();
  const tail: Array<[string, { slot: Slot; via: string; score: number; facts: number }]> = [];
  let seed = 0x2f6e2b1;
  const seen = new Set<number>();
  while (tail.length < Math.min(TAIL_SAMPLE, mappedKeys.length)) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const index = seed % mappedKeys.length;
    if (seen.has(index)) continue;
    seen.add(index);
    const key = mappedKeys[index];
    const entry = key === undefined ? undefined : assigned.get(key);
    if (key !== undefined && entry !== undefined) tail.push([key, entry]);
  }
  console.log(`\n=== uniform random sample of ${tail.length} mapped predicates (tail hand-check) ===`);
  console.log("  facts  score  via       slot          predicate");
  for (const [predicate, entry] of tail.sort((a, b) => b[1].score - a[1].score)) {
    console.log(
      `  ${String(entry.facts).padStart(5)}  ${entry.score.toFixed(3)}  ${entry.via.padEnd(9)} ` +
        `${entry.slot.padEnd(12)}  ${predicate}`,
    );
  }

  const nearSorted = nearMisses.sort((a, b) => b.score - a.score).slice(0, 60);
  console.log(`\n=== nearest misses under ${threshold} (what a looser bar admits next) ===`);
  console.log("  facts  score  would-be slot  predicate");
  for (const miss of nearSorted) {
    console.log(
      `  ${String(miss.facts).padStart(5)}  ${miss.score.toFixed(3)}  ${miss.slot.padEnd(13)}  ${miss.predicate}`,
    );
  }

  // ---- 6. the known-bad gate --------------------------------------------------------
  const knownBad = loadKnownBad();
  let knownBadFailures = 0;
  if (knownBad.length > 0) {
    console.log(`\n=== known-bad list (${knownBad.length} entries) ===`);
    for (const entry of knownBad) {
      const result = assignSlotFromScores(entry.predicate, scoresOf(entry.predicate), threshold);
      const bad =
        entry.mustNotMap === "*" ? result.slot !== null : result.slot === entry.mustNotMap;
      if (bad) knownBadFailures += 1;
      console.log(
        `  ${bad ? "FAIL" : "ok  "}  ${entry.predicate.padEnd(28)} -> ${String(result.slot).padEnd(12)}` +
          ` (${result.score.toFixed(3)}, nearest ${String(result.nearest)}, must not be ${entry.mustNotMap})`,
      );
    }
    console.log(
      knownBadFailures === 0
        ? `\nknown-bad: all ${knownBad.length} refused at threshold ${threshold}`
        : `\nknown-bad: ${knownBadFailures}/${knownBad.length} MAPPED — threshold ${threshold} is too loose`,
    );
    if (knownBadFailures > 0) process.exitCode = 1;
  }

  // ---- 7. emit the map --------------------------------------------------------------
  // A gate that still hands you the artifact is not a gate: `--rule slot` would then replay a
  // mapping the known-bad list has already rejected, and the replay's numbers would describe a
  // normalizer nobody would ship.
  if (write && knownBadFailures > 0) {
    console.log(
      `\nREFUSING to write ${SLOT_MAP_PATH}: ${knownBadFailures} known-bad predicate(s) map at` +
        ` threshold ${threshold}. Raise the threshold, or fix the slot descriptions, and re-run.`,
    );
  } else if (write) {
    const payload = {
      fingerprint,
      threshold,
      descriptionTask,
      generatedAt: new Date().toISOString(),
      slots: Object.fromEntries(
        [...assigned.entries()].map(([predicate, entry]) => [predicate, entry.slot]),
      ),
    };
    writeFileSync(SLOT_MAP_PATH, JSON.stringify(payload));
    console.log(`\nwrote ${assigned.size} predicate -> slot assignments to ${SLOT_MAP_PATH}`);
  } else {
    console.log(`\n(--write not passed; no slot map emitted)`);
  }

  const factCounts = [...stats.values()].map((s) => s.facts).sort((a, b) => a - b);
  console.log(
    `\npredicate frequency: p50 ${percentile(factCounts, 50)}, p90 ${percentile(factCounts, 90)}, ` +
      `max ${factCounts[factCounts.length - 1] ?? 0}`,
  );
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
