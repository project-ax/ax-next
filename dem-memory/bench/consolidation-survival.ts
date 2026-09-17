/**
 * Answer, without any LLM calls, the question the benchmark cannot: would dem's facts
 * still be there if they had to survive a Strata-style CONSOLIDATION regime?
 *
 * dem's n=500 = 87.4% is measured on a store where `retain()` writes every fact and
 * nothing ever removes, merges or decays it. Strata's consolidator is a LOSSY compaction
 * pass — a fact is recallable later only if it survives. This replays each question's
 * haystack in chronological order through Strata's DROP predicates and reports fact-level
 * survival, which is the hard ceiling on post-consolidation accuracy.
 *
 *   npx tsx bench/consolidation-survival.ts
 *   npx tsx bench/consolidation-survival.ts --fingerprint f4752a79 --threshold 0.6
 *
 * WHAT IS MODELLED — the three rules in packages/memory-strata/src/consolidator.ts that
 * can DELETE a fact, in the order that pass applies them:
 *
 *  1. decay (DECAY_DAYS = 14) — MODELLED AS A NO-OP, DELIBERATELY. The cutoff tests
 *     `frontmatter.created`, i.e. how long an observation sat UNCONSOLIDATED IN THE INBOX
 *     (consolidator.ts `decayInbox`), not how old the remembered fact is. Strata
 *     consolidates on a debounce after `chat:end`, so an observation is promoted within
 *     minutes and decay only ever collects orphans. Reading it as "facts older than 14
 *     days are dropped" deletes essentially the whole corpus and reports a catastrophe
 *     that the real pipeline does not produce.
 *  2. the confidence gate (CONFIDENCE_THRESHOLD = 0.7, promotion.ts `decidePromotion`).
 *  3. token-set Jaccard dedup (threshold 0.6, dedup.ts `isDupe`) against the facts already
 *     in the target doc, accumulating within the pass (consolidator.ts, I12).
 *
 * WHAT IS NOT MODELLED, and why the result is a floor rather than a verdict: survivors are
 * merged into markdown docs, and Strata then RETRIEVES OVER DOCUMENTS
 * ({docId, category, slug, summary, body, headers} -> {snippet, score}), not over tuples.
 * That contract has nowhere to put a validity interval or an epistemic network, so dem's
 * `When` column — the thing behind its 90.2% on temporal-reasoning — does not survive the
 * interface even when the underlying facts do. Measuring that needs dem running as a real
 * `memory:index:*` backend, not a simulation.
 *
 * FIDELITY: the predicates below are a COPY of Strata's, because dem-memory is a standalone
 * npm project and cannot import `@ax/memory-strata`. `tests/consolidation-survival.test.ts`
 * pins them against the assertions in `packages/memory-strata/src/__tests__/dedup.test.ts`
 * so the copy cannot drift silently.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { memoryStatement } from "../src/types.js";
import { CACHE_DIR, loadCorpus, parseArgs, type LongMemEvalSample } from "./harness.js";

/** packages/memory-strata/src/promotion.ts */
export const CONFIDENCE_THRESHOLD = 0.7;
/** packages/memory-strata/src/dedup.ts */
export const DUPE_THRESHOLD = 0.6;

/** Copied verbatim from packages/memory-strata/src/dedup.ts. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "in", "is", "it", "of", "on", "or", "that", "the",
  "to", "was", "were", "with",
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0]!;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const tok of a) if (b.has(tok)) intersect += 1;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export function isDupe(candidate: string, existing: string[], threshold = DUPE_THRESHOLD): boolean {
  const candTokens = tokenize(candidate);
  for (const e of existing) {
    if (jaccard(candTokens, tokenize(e)) >= threshold) return true;
  }
  return false;
}

/** packages/memory-strata/src/slugify.ts — empty input falls back to "general". */
export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "general" : slug;
}

export interface CachedFact {
  network?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  validStart?: string;
  confidence?: number;
}

/**
 * Which doc a fact is routed to, and therefore which facts it is deduped against.
 *
 * Strata clusters by `slugify(observation.subject)`, where `subject` is a free-text TOPIC
 * the observer picks. dem's `subject` is the grammatical subject of a triple — 90% of its
 * facts are `user` or `assistant` — so the literal mapping lands almost everything in two
 * docs. That is harsher than Strata would ever be in practice, which is the point of
 * running all three: `global` is the worst case the rule could possibly do, and
 * `subject_predicate` approximates a finer topic routing dem does not currently carry.
 */
export type Scope = "global" | "subject" | "subject_predicate";
export const SCOPES: Scope[] = ["global", "subject", "subject_predicate"];

function docKey(scope: Scope, fact: CachedFact): string {
  if (scope === "global") return "_";
  if (scope === "subject") return slugify(fact.subject ?? "");
  return slugify(`${fact.subject ?? ""}-${fact.predicate ?? ""}`);
}

export interface Tally {
  kept: number;
  droppedDupe: number;
  droppedConfidence: number;
}

export interface NearThresholdDrop {
  similarity: number;
  dropped: string;
  survivor: string;
}

export interface ScopeResult {
  scope: Scope;
  all: Tally;
  gold: Tally;
  byType: Map<string, Tally>;
  questionsLosingAllGold: string[];
  questionsLosingSomeGold: number;
  worstQuestionGoldLoss: number;
  /**
   * Of the dupe drops, how many discard a fact whose validStart is NEWER than the survivor's.
   * NOT the same as "all of them": the survivor is always earlier in INGEST order by
   * construction, but facts extracted from one session share that session's date, so most
   * drops are same-dated rather than an update losing to the value it corrects.
   */
  droppedNewerThanSurvivor: number;
  droppedComparable: number;
  /** Similarity histogram of dupe drops, bucketed to 0.1. 1.0 is a verbatim restatement
   *  (no information lost); the 0.6-0.7 band is where two DIFFERENT facts collapse. */
  dropHistogram: Map<number, number>;
  goldDropHistogram: Map<number, number>;
  examples: NearThresholdDrop[];
}

const emptyTally = (): Tally => ({ kept: 0, droppedDupe: 0, droppedConfidence: 0 });
const total = (t: Tally): number => t.kept + t.droppedDupe + t.droppedConfidence;
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

interface IngestRow {
  sessionId: string;
  isGold: boolean;
  fact: CachedFact;
  statement: string;
}

export function simulate(
  questions: LongMemEvalSample[],
  factsBySession: Map<string, CachedFact[]>,
  scope: Scope,
  threshold = DUPE_THRESHOLD,
  exampleLimit = 500,
): ScopeResult {
  const result: ScopeResult = {
    scope,
    all: emptyTally(),
    gold: emptyTally(),
    byType: new Map(),
    questionsLosingAllGold: [],
    questionsLosingSomeGold: 0,
    worstQuestionGoldLoss: 0,
    droppedNewerThanSurvivor: 0,
    droppedComparable: 0,
    dropHistogram: new Map(),
    goldDropHistogram: new Map(),
    examples: [],
  };
  // Sessions are shared between questions, so the same statement is tokenized many times.
  const tokenCache = new Map<string, Set<string>>();
  const tokensOf = (statement: string): Set<string> => {
    let t = tokenCache.get(statement);
    if (t === undefined) {
      t = tokenize(statement);
      tokenCache.set(statement, t);
    }
    return t;
  };

  for (const question of questions) {
    const type = question.question_type ?? "unknown";
    let typeTally = result.byType.get(type);
    if (typeTally === undefined) {
      typeTally = emptyTally();
      result.byType.set(type, typeTally);
    }
    const goldSessions = new Set(answerSessionIds(question));

    // Consolidation runs as sessions arrive, so replay in date order. This is what makes
    // the survivor of a dupe pair the EARLIER fact — see droppedNewerThanSurvivor.
    const indices = question.haystack_session_ids.map((_, i) => i);
    const dates = question.haystack_dates;
    if (dates !== undefined) {
      indices.sort((a, b) => (dates[a] ?? "").localeCompare(dates[b] ?? ""));
    }

    const rows: IngestRow[] = [];
    for (const i of indices) {
      const sessionId = question.haystack_session_ids[i]!;
      for (const fact of factsBySession.get(sessionId) ?? []) {
        rows.push({
          sessionId,
          isGold: goldSessions.has(sessionId),
          fact,
          statement: memoryStatement(fact.subject ?? "", fact.predicate ?? "", fact.object ?? ""),
        });
      }
    }

    const docs = new Map<string, { tokens: Set<string>; fact: CachedFact; statement: string }[]>();
    let goldSeen = 0;
    let goldKept = 0;
    let goldDropped = 0;

    for (const row of rows) {
      if (row.isGold) goldSeen += 1;
      if ((row.fact.confidence ?? 0) < CONFIDENCE_THRESHOLD) {
        result.all.droppedConfidence += 1;
        typeTally.droppedConfidence += 1;
        if (row.isGold) result.gold.droppedConfidence += 1;
        continue;
      }
      const key = docKey(scope, row.fact);
      const doc = docs.get(key) ?? [];
      const tokens = tokensOf(row.statement);
      let best = 0;
      let survivor: (typeof doc)[number] | undefined;
      for (const entry of doc) {
        const score = jaccard(tokens, entry.tokens);
        if (score > best) {
          best = score;
          survivor = entry;
        }
      }
      if (best >= threshold && survivor !== undefined) {
        result.all.droppedDupe += 1;
        typeTally.droppedDupe += 1;
        const bucket = Math.round(best * 10) / 10;
        result.dropHistogram.set(bucket, (result.dropHistogram.get(bucket) ?? 0) + 1);
        if (row.isGold) {
          result.goldDropHistogram.set(bucket, (result.goldDropHistogram.get(bucket) ?? 0) + 1);
          result.gold.droppedDupe += 1;
          goldDropped += 1;
        }
        const dropped = row.fact.validStart;
        const kept = survivor.fact.validStart;
        if (dropped !== undefined && kept !== undefined) {
          result.droppedComparable += 1;
          if (dropped > kept) result.droppedNewerThanSurvivor += 1;
        }
        if (result.examples.length < exampleLimit) {
          result.examples.push({ similarity: best, dropped: row.statement, survivor: survivor.statement });
        }
        continue;
      }
      doc.push({ tokens, fact: row.fact, statement: row.statement });
      docs.set(key, doc);
      result.all.kept += 1;
      typeTally.kept += 1;
      if (row.isGold) {
        result.gold.kept += 1;
        goldKept += 1;
      }
    }

    if (goldSeen > 0 && goldKept === 0) result.questionsLosingAllGold.push(question.question_id);
    if (goldDropped > 0) result.questionsLosingSomeGold += 1;
    if (goldDropped > result.worstQuestionGoldLoss) result.worstQuestionGoldLoss = goldDropped;
  }
  return result;
}

/** `answer_session_ids` is not on LongMemEvalSample, but every corpus row carries it. */
function answerSessionIds(sample: LongMemEvalSample): string[] {
  const raw = (sample as unknown as { answer_session_ids?: unknown }).answer_session_ids;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Load facts keyed by session for ONE extraction generation.
 *
 * Read directly rather than through `ExtractionCache`: its constructor migrates legacy keys
 * and flushes, which would rewrite a 65 MB file as a side effect of a read-only analysis.
 * Cache keys are `sessionId:fingerprint:contentHash`, and the fingerprint covers the
 * extraction prompt and model — so a generation is exactly "the facts one prompt produced",
 * and comparing a survival number across generations is comparing two different fact stores.
 */
export function loadFactsByFingerprint(
  cacheDir: string,
  fingerprint?: string,
): { fingerprint: string; bySession: Map<string, CachedFact[]>; available: Map<string, number> } {
  const path = join(cacheDir, "extraction.json");
  if (!existsSync(path)) throw new Error(`no extraction cache at ${path}`);
  const entries = JSON.parse(readFileSync(path, "utf8")) as Record<string, CachedFact[]>;

  const available = new Map<string, number>();
  for (const key of Object.keys(entries)) {
    const fp = key.split(":")[1] ?? "";
    available.set(fp, (available.get(fp) ?? 0) + 1);
  }
  // Default to the widest generation rather than a hard-coded id: the fingerprint moves
  // whenever the extraction prompt changes, and the one worth measuring is whichever
  // actually covers the corpus.
  const chosen =
    fingerprint ??
    [...available.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (chosen === undefined) throw new Error("extraction cache is empty");
  if (!available.has(chosen)) {
    throw new Error(`no entries for fingerprint ${chosen}; have ${[...available.keys()].join(", ")}`);
  }

  const bySession = new Map<string, CachedFact[]>();
  for (const [key, facts] of Object.entries(entries)) {
    const parts = key.split(":");
    if (parts[1] !== chosen) continue;
    bySession.set(parts[0]!, facts);
  }
  return { fingerprint: chosen, bySession, available };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cacheDir = args["cache-dir"] ?? CACHE_DIR;
  const threshold = Number(args.threshold ?? DUPE_THRESHOLD);
  const scopes: Scope[] = args.scope ? [args.scope as Scope] : SCOPES;

  const { fingerprint, bySession, available } = loadFactsByFingerprint(cacheDir, args.fingerprint);
  const factCount = [...bySession.values()].reduce((n, facts) => n + facts.length, 0);
  console.log(`extraction generations in cache: ${[...available.entries()]
    .map(([fp, n]) => `${fp} (${n} sessions)`)
    .join(", ")}`);
  console.log(`measuring ${fingerprint}: ${bySession.size} sessions, ${factCount} facts`);

  const corpus = loadCorpus();
  const missing = corpus.filter((q) =>
    q.haystack_session_ids.some((id) => !bySession.has(id)),
  ).length;
  console.log(`questions: ${corpus.length} (with at least one unextracted session: ${missing})`);
  console.log(`dedup threshold ${threshold}, confidence gate ${CONFIDENCE_THRESHOLD}, decay: no-op (see header)\n`);

  for (const scope of scopes) {
    const r = simulate(corpus, bySession, scope, threshold);
    console.log(`=== scope: ${scope} ===`);
    console.log(
      `  ALL facts    : ${r.all.kept}/${total(r.all)} survive = ${pct(r.all.kept, total(r.all))}` +
        `  (dupe ${r.all.droppedDupe}, low-confidence ${r.all.droppedConfidence})`,
    );
    console.log(
      `  GOLD-session : ${r.gold.kept}/${total(r.gold)} survive = ${pct(r.gold.kept, total(r.gold))}` +
        `  (dupe ${r.gold.droppedDupe}, low-confidence ${r.gold.droppedConfidence})`,
    );
    console.log(`  questions losing ALL gold facts : ${r.questionsLosingAllGold.length}/${corpus.length}`);
    console.log(
      `  questions losing SOME gold facts: ${r.questionsLosingSomeGold}/${corpus.length}` +
        ` (worst single question: ${r.worstQuestionGoldLoss})`,
    );
    console.log(
      `  dupe drops discarding the NEWER fact: ${r.droppedNewerThanSurvivor}/${r.droppedComparable}` +
        ` — the survivor is always earlier in INGEST order, but only this many are earlier by` +
        ` validStart (facts from one session share its date). This is the population where an` +
        ` UPDATE dies as a restatement of the value it corrects.`,
    );
    for (const [type, t] of [...r.byType.entries()].sort()) {
      console.log(`    ${type.padEnd(28)} ${pct(t.kept, total(t))} of all its facts survive`);
    }
    const hist = (m: Map<number, number>): string =>
      [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k.toFixed(1)}:${v}`).join("  ");
    console.log(`  drop similarity  all: ${hist(r.dropHistogram)}`);
    console.log(`  drop similarity gold: ${hist(r.goldDropHistogram)}`);
    if (r.examples.length > 0) {
      // Ascending: the marginal drops are the ones worth eyeballing. A 1.0 is a verbatim
      // restatement and loses nothing; a 0.6 is two different facts collapsing into one.
      console.log(`  most marginal drops:`);
      for (const ex of [...r.examples].sort((a, b) => a.similarity - b.similarity).slice(0, 6)) {
        console.log(`    J=${ex.similarity.toFixed(3)} DROPPED: ${ex.dropped.slice(0, 100)}`);
        console.log(`              AGAINST: ${ex.survivor.slice(0, 100)}`);
      }
    }
    console.log("");
  }
}

// Only run when executed directly — tests import the predicates from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
