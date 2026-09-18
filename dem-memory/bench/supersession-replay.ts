/**
 * What does supersession actually DO to this corpus — under DEM's rule as coded, and under
 * the slot rule §3.3-3.4 of the DEM-first design proposes to replace it with?
 *
 * This is the committed form of Appendix A.4 of
 * `docs/plans/2026-09-18-dem-first-memory-design.md`, which was measured from the scratchpad
 * while that document was being written. No LLM calls, no embeddings, no network: it replays
 * the cached facts of ONE extraction generation through an invalidation rule and counts.
 *
 * WHY IT MATTERS. The 87.4% headline was measured with supersession effectively OFF — 140
 * rows closed out of 130,779 facts, 0.11%. That is not a system whose supersession works; it
 * is a system whose supersession never fires. Turning the same rule on over a LIFETIME bank
 * is destructive in the other direction: one `assistant | recommended` closes 68 rows.
 * `predicate` cannot be both a free-text label the reranker reads and an exact-match key
 * supersession fires on.
 *
 *   npx tsx bench/supersession-replay.ts --fingerprint f4752a79
 *   npx tsx bench/supersession-replay.ts --fingerprint f4752a79 --rule slot
 *
 * ---------------------------------------------------------------------------------------
 * RULES
 *
 * `--rule dem` (default) — DEM's invalidation exactly as `src/db/memory-repository.ts`
 *   codes it, fired only for a fact carrying `invalidatesPrevious: true`:
 *
 *     UPDATE memories SET valid_end = ?
 *      WHERE bank_id = ? AND subject = ? AND predicate = ?
 *        AND valid_end = <infinity> AND valid_start <= ?
 *
 *   Note `valid_start <= ?`, one-directional: a BACKDATED fact closes nothing and stays
 *   active beside the current one. That asymmetry is measured below as `two-sided misses`.
 *
 * `--rule slot` — the design's replacement. `invalidatesPrevious` is ignored entirely.
 *   A statement closes prior rows only when its relation maps to a SLOT (a closed list of
 *   eight single-valued profile relations, `bench/slots.ts`), and then only within
 *   `(subject, slot)`:
 *     1. close every active R with `R.when <= S.when`;
 *     2. TWO-SIDED — if an active R' has `R'.when > S.when`, close S itself at that instant;
 *     3. provenance immunity: a row closes only under equal-or-higher provenance
 *        (`human > agent > extracted`);
 *     4. equal `when`: later transaction time wins.
 *
 *   Rule 3 CANNOT BE EXERCISED BY THIS DATA. Every cached fact is `extracted`, so the
 *   provenance comparison is always equal-vs-equal. The replay implements it and says so;
 *   it is pinned by a unit test instead, not by this measurement.
 *
 * ---------------------------------------------------------------------------------------
 * SCOPES — what counts as one bank
 *
 * `prefix`   Appendix A.4's per-conversation column, reproduced as it was measured: group
 *            cache keys on the session-id prefix. It is an APPROXIMATION, and A.4 says so.
 *            `ultrachat_327634` and `ultrachat_331531` share the prefix `ultrachat` and are
 *            unrelated sessions, so this scope fuses a large artificial bank.
 * `question` The exact per-conversation scope, which A.4 did not compute: one bank per
 *            LongMemEval question, membership read from `haystack_session_ids`. This is what
 *            `bench/run.ts` actually builds (`bankId: sample.question_id`). Sessions shared
 *            across questions are counted once per question, so totals here are fact-INGESTS
 *            (the same convention `consolidation-survival.ts` uses; ~1.24 ingests per fact).
 * `lifetime` One bank, every fact — "all of one person's memory, forever". A.4's exact
 *            column, and the scope the product actually has once a user keeps talking.
 *
 * ORDERING matters and is a flag, because it decides whether rule 2 can fire at all:
 *   `--order validstart` (default) sorts by `validStart`, reproducing A.4. Nothing already
 *      active can then have a LATER `when`, so two-sided closure is vacuous BY CONSTRUCTION.
 *   `--order session` sorts by the session's own date, which is what ingestion really does.
 *      `validStart` differs from the session date on 7.0% of this generation's rows (1.9%
 *      after, 5.1% before), so backdating is real and rule 2 has something to bite on.
 *
 * ---------------------------------------------------------------------------------------
 * MEASURED 2026-09-18 over `f4752a79` — 19,195 sessions, 130,779 facts, the exact generation
 * behind the 87.4% headline. Predicate space: 84,561 distinct, 86.8% singletons. Subject is
 * `assistant` on 52.3% of rows and `user` on 37.7% — 90.0% in two values.
 *
 *                              prefix        question       lifetime      lifetime
 *                              (A.4 approx)  (exact)        (validstart)  (session order)
 *   banks                      11,140        500            1             1
 *   fact ingests               130,779       162,147        130,779       130,779
 *   flagged                    1,242 (0.95%) 1,604 (0.99%)  1,242         1,242
 *   flags with an exact prior  105           161            372           379
 *   flags that found nothing   91.55%        89.96%         70.05%        69.48%
 *   rows closed                158 (0.12%)   258 (0.16%)    5,587 (4.27%) 5,424 (4.15%)
 *   rows per closer p50/p90/max 1 / 2 / 28   1 / 3 / 6      2 / 23 / 622  2 / 26 / 447
 *   one-directional misses     0             0              0             97
 *
 * THE LIFETIME COLUMN REPRODUCES APPENDIX A.4 EXACTLY (372 / 70% / 5,587 / 4.27% /
 * p50 2 / p90 23 / max 622), and so do its cited examples: `assistant | recommended` closes
 * 360, 68 and 56 rows in its three closures (A.4 quotes the 68); `user | interested_in`
 * closes 40; `assistant | provided_solution` closes 86, 81, 67 ... 46 across 40 closures
 * (A.4 quotes 46, 30, 23).
 *
 * THE PER-CONVERSATION COLUMN DOES NOT. A.4 reports 102 flags-with-prior and 140 rows
 * closed; splitting the session id at its LAST underscore gives 105 / 158 and splitting at
 * its FIRST gives 205 / 1,218. A.4's footnote already calls that column an approximation,
 * and this is the size of the approximation: the grouping is not recoverable from the
 * published number. **Quote the `question` column instead** — it is exact, it is the scope
 * `bench/run.ts` actually builds, and it says the same thing (0.16% of rows closed).
 *
 * TWO THINGS THE LIFETIME COLUMN IS NOT. It is not one person's memory: LongMemEval-S is
 * 500 unrelated users' haystacks, and fusing them puts every speaker under one `about: user`
 * node. So `user | lives_in` closing 77 rows at once is 77 DIFFERENT PEOPLE's cities, not
 * one person moving 77 times — which is exactly the failure §3.2's speaker rewrite
 * (`about: user` -> `about: user:<userId>`) exists to prevent. Read the two scopes as a
 * bracket: `question` is what per-person keying gives you, `lifetime` is what happens when
 * one `about` value accumulates without bound. The design needs BOTH the speaker rewrite
 * (§3.2, which fixes the subject axis) and the slot key (§3.3, which fixes the relation
 * axis); neither alone gets from 4.27% to a defensible number.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadFactsByFingerprint } from "./consolidation-survival.js";
import { CACHE_DIR, loadCorpus, parseArgs, sessionDateToIso } from "./harness.js";
import type { Slot } from "../src/slots.js";

export type Scope = "prefix" | "question" | "lifetime";
export type Rule = "dem" | "slot";
export type Order = "validstart" | "session";

const SCOPES: Scope[] = ["prefix", "question", "lifetime"];
const SLOT_MAP_PATH = join(CACHE_DIR, "predicate-slots.json");

/** `human > agent > extracted`. Higher closes lower; equal closes equal. */
const PROVENANCE_RANK: Record<string, number> = { extracted: 0, agent: 1, human: 2 };

export interface ReplayFact {
  subject: string;
  predicate: string;
  object: string;
  validStart: string;
  invalidatesPrevious: boolean;
  provenance: string;
  /** Ingest position within the bank — the stand-in for transaction time. */
  seq: number;
}

interface Row extends ReplayFact {
  id: number;
  validEnd: string | null;
  closedBy: number | null;
}

export interface ReplayStats {
  scope: Scope;
  rule: Rule;
  order: Order;
  banks: number;
  ingests: number;
  /** dem only: facts carrying `invalidatesPrevious: true`. */
  flagged: number;
  /** dem only: flags that found at least one exact `(subject, predicate)` active prior. */
  flagsWithPrior: number;
  /** slot only: ingests whose relation mapped to a slot. */
  slotted: number;
  /** Statements that closed at least one prior row. */
  closers: number;
  rowsClosed: number;
  /** slot rule 2: statements closed by an already-active LATER row. */
  selfClosed: number;
  /**
   * dem only: flags whose exact prior exists but sits at a LATER `validStart`, so
   * `valid_start <= ?` skips it and both rows stay active. The one-directional miss.
   */
  twoSidedMisses: number;
  closedPerCloser: number[];
  /** `subject|key` -> rows closed, for the worst-offender table. */
  byKey: Map<string, { closers: number; rowsClosed: number; max: number }>;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function emptyStats(scope: Scope, rule: Rule, order: Order): ReplayStats {
  return {
    scope,
    rule,
    order,
    banks: 0,
    ingests: 0,
    flagged: 0,
    flagsWithPrior: 0,
    slotted: 0,
    closers: 0,
    rowsClosed: 0,
    selfClosed: 0,
    twoSidedMisses: 0,
    closedPerCloser: [],
    byKey: new Map(),
  };
}

function bump(stats: ReplayStats, key: string, closed: number): void {
  const bucket = stats.byKey.get(key) ?? { closers: 0, rowsClosed: 0, max: 0 };
  bucket.closers += 1;
  bucket.rowsClosed += closed;
  bucket.max = Math.max(bucket.max, closed);
  stats.byKey.set(key, bucket);
}

/**
 * Replay one bank.
 *
 * `slotOf` returns the slot for a relation, or null. Under `--rule dem` it is never called.
 */
export function replayBank(
  facts: readonly ReplayFact[],
  rule: Rule,
  stats: ReplayStats,
  slotOf: (predicate: string) => Slot | null,
): void {
  stats.banks += 1;
  const rows: Row[] = [];
  /** Active rows indexed by the key the rule matches on. */
  const active = new Map<string, Row[]>();

  // Prune closed rows out of the index as they are found, rather than filtering a
  // never-shrinking list on every lookup. Without this the lifetime bank is quadratic in the
  // hottest key — `assistant | recommended` alone reaches the thousands.
  //
  // Only the DEM rule may use this: that rule matches `valid_end = infinity` in SQL, so a
  // closed row is genuinely out of its reach forever. The slot rule needs `peersOf`.
  const activeOf = (key: string): Row[] => {
    const list = active.get(key);
    if (!list) return [];
    if (list.some((row) => row.validEnd !== null)) {
      const live = list.filter((row) => row.validEnd === null);
      active.set(key, live);
      return live;
    }
    return list;
  };

  /** Every row of a key, closed ones included — see the comment where this is called. */
  const peersOf = (key: string): Row[] => active.get(key) ?? [];

  for (const fact of facts) {
    stats.ingests += 1;
    const row: Row = { ...fact, id: rows.length, validEnd: null, closedBy: null };
    rows.push(row);

    if (rule === "dem") {
      if (!fact.invalidatesPrevious) {
        pushActive(active, `${fact.subject}\u0000${fact.predicate}`, row);
        continue;
      }
      stats.flagged += 1;
      const key = `${fact.subject}\u0000${fact.predicate}`;
      const priors = activeOf(key);
      if (priors.length > 0) stats.flagsWithPrior += 1;

      // DEM's SQL: `valid_start <= ?`. Priors dated LATER are skipped, and both stay active.
      const closeable = priors.filter((prior) => prior.validStart <= fact.validStart);
      const skippedLater = priors.length - closeable.length;
      if (skippedLater > 0) stats.twoSidedMisses += 1;
      for (const prior of closeable) {
        prior.validEnd = fact.validStart;
        prior.closedBy = row.id;
      }
      if (closeable.length > 0) {
        stats.closers += 1;
        stats.rowsClosed += closeable.length;
        stats.closedPerCloser.push(closeable.length);
        bump(stats, `${fact.subject} | ${fact.predicate}`, closeable.length);
      }
      pushActive(active, key, row);
      continue;
    }

    // ---- slot rule -----------------------------------------------------------------
    const slot = slotOf(fact.predicate);
    if (slot === null) {
      // No slot: the row is stored, retrievable, and closes nothing. This is the safe
      // direction and it is most of the corpus by design.
      continue;
    }
    stats.slotted += 1;
    const key = `${fact.subject}\u0000${slot}`;
    // EVERY row of this key, not only the active ones. A row already bounded by a later
    // successor can still span the instant this statement claims, and leaving it alone puts
    // two overlapping assertions in the history. See `insertWithSlotClosure` in
    // `src/db/memory-repository.ts`, which this mirrors.
    const priors = peersOf(key);

    const rank = PROVENANCE_RANK[fact.provenance] ?? 0;
    // Rule 3: only rows of EQUAL-OR-LOWER provenance interact with this one, in either
    // direction — it cannot close them and they cannot bound it.
    const reachable = priors.filter((prior) => (PROVENANCE_RANK[prior.provenance] ?? 0) <= rank);

    // Rules 1 + 4: end every row still OPEN AT this statement's start.
    const spanning = reachable.filter(
      (prior) =>
        prior.validStart <= fact.validStart &&
        (prior.validEnd === null || prior.validEnd > fact.validStart),
    );
    for (const prior of spanning) {
      prior.validEnd = fact.validStart;
      prior.closedBy = row.id;
    }
    if (spanning.length > 0) {
      stats.closers += 1;
      stats.rowsClosed += spanning.length;
      stats.closedPerCloser.push(spanning.length);
      bump(stats, `${fact.subject} | ${slot}`, spanning.length);
    }

    // Rule 2, two-sided: a row dated LATER than this one bounds it, at the EARLIEST such
    // instant. Under `--order validstart` this set is always empty.
    const newer = reachable
      .filter((prior) => prior.validStart > fact.validStart)
      .sort((a, b) => a.validStart.localeCompare(b.validStart));
    const bound = newer[0];
    if (bound !== undefined) {
      row.validEnd = bound.validStart;
      row.closedBy = bound.id;
      stats.selfClosed += 1;
    }
    pushActive(active, key, row);
  }
}

function pushActive(active: Map<string, Row[]>, key: string, row: Row): void {
  const list = active.get(key);
  if (list) list.push(row);
  else active.set(key, [row]);
}

/** `94bc18df_3` -> `94bc18df`; `f10be626` -> `f10be626`; `ultrachat_327634` -> `ultrachat`. */
export function sessionPrefix(sessionId: string): string {
  const cut = sessionId.lastIndexOf("_");
  return cut > 0 ? sessionId.slice(0, cut) : sessionId;
}

function toReplayFacts(
  sessions: readonly string[],
  bySession: ReadonlyMap<string, Array<{ subject?: string; predicate?: string; object?: string; validStart?: string; invalidatesPrevious?: boolean }>>,
  sessionDate: ReadonlyMap<string, string>,
  order: Order,
): ReplayFact[] {
  const out: Array<ReplayFact & { sortKey: string }> = [];
  for (const sessionId of sessions) {
    const facts = bySession.get(sessionId);
    if (!facts) continue;
    const date = sessionDate.get(sessionId);
    for (const fact of facts) {
      const validStart = fact.validStart ?? "";
      if (validStart === "") continue;
      out.push({
        subject: fact.subject ?? "",
        predicate: fact.predicate ?? "",
        object: fact.object ?? "",
        validStart,
        invalidatesPrevious: fact.invalidatesPrevious === true,
        // Everything in the extraction cache came from the observer. A human or agent write
        // has no representation here — see the header on rule 3.
        provenance: "extracted",
        seq: 0,
        sortKey: order === "session" ? (date ?? validStart) : validStart,
      });
    }
  }
  out.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return out.map((fact, index) => {
    const { sortKey: _sortKey, ...rest } = fact;
    return { ...rest, seq: index };
  });
}

interface SlotMapFile {
  fingerprint: string;
  threshold: number;
  slots: Record<string, Slot>;
}

function loadSlotMap(): { map: Map<string, Slot>; meta: SlotMapFile } {
  if (!existsSync(SLOT_MAP_PATH)) {
    throw new Error(
      `--rule slot needs ${SLOT_MAP_PATH}; produce it with\n` +
        `  npx tsx bench/normalizer-eval.ts --fingerprint f4752a79 --write`,
    );
  }
  const meta = JSON.parse(readFileSync(SLOT_MAP_PATH, "utf8")) as SlotMapFile;
  return { map: new Map(Object.entries(meta.slots)), meta };
}

function report(stats: ReplayStats): void {
  const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(2)}%`);
  console.log(`=== scope: ${stats.scope} | rule: ${stats.rule} | order: ${stats.order} ===`);
  console.log(`  banks                       ${stats.banks}`);
  console.log(`  fact ingests                ${stats.ingests}`);
  if (stats.rule === "dem") {
    console.log(
      `  flagged invalidatesPrevious ${stats.flagged} (${pct(stats.flagged, stats.ingests)})`,
    );
    console.log(
      `  flags with an exact prior   ${stats.flagsWithPrior}` +
        ` — found NOTHING: ${pct(stats.flagged - stats.flagsWithPrior, stats.flagged)}`,
    );
    console.log(
      `  one-directional misses      ${stats.twoSidedMisses}` +
        `  (exact prior exists but is dated later, so valid_start <= ? skips it)`,
    );
  } else {
    console.log(
      `  ingests with a slot         ${stats.slotted} (${pct(stats.slotted, stats.ingests)})`,
    );
    console.log(`  self-closed (two-sided)     ${stats.selfClosed}`);
  }
  console.log(
    `  statements that closed >0   ${stats.closers}` +
      `\n  rows closed                 ${stats.rowsClosed} (${pct(stats.rowsClosed, stats.ingests)} of ingests)`,
  );
  console.log(
    `  rows closed per closer      p50 ${percentile(stats.closedPerCloser, 50)}, ` +
      `p90 ${percentile(stats.closedPerCloser, 90)}, max ${percentile(stats.closedPerCloser, 100)}`,
  );

  const worst = [...stats.byKey.entries()]
    .sort((a, b) => b[1].rowsClosed - a[1].rowsClosed || a[0].localeCompare(b[0]))
    .slice(0, 12);
  if (worst.length > 0) {
    console.log(`  worst keys by rows closed:`);
    for (const [key, bucket] of worst) {
      console.log(
        `    ${String(bucket.rowsClosed).padStart(6)} rows over ${String(bucket.closers).padStart(4)}` +
          ` closures (max ${bucket.max} at once)   ${key}`,
      );
    }
  }
  console.log("");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cacheDir = args["cache-dir"] ?? CACHE_DIR;
  const rule = (args.rule ?? "dem") as Rule;
  const order = (args.order ?? "validstart") as Order;
  const scopes: Scope[] = args.scope ? [args.scope as Scope] : SCOPES;

  const { fingerprint, bySession, available } = loadFactsByFingerprint(cacheDir, args.fingerprint);
  const factCount = [...bySession.values()].reduce((n, facts) => n + facts.length, 0);

  console.log(`extraction generations in cache: ${[...available.entries()]
    .map(([fp, n]) => `${fp} (${n} sessions)`)
    .join(", ")}`);
  console.log(`measuring ${fingerprint}: ${bySession.size} sessions, ${factCount} facts`);

  // ---- predicate space (the reason the whole design change exists) --------------------
  const predicateFacts = new Map<string, number>();
  const subjectFacts = new Map<string, number>();
  for (const facts of bySession.values()) {
    for (const fact of facts) {
      const predicate = fact.predicate ?? "";
      predicateFacts.set(predicate, (predicateFacts.get(predicate) ?? 0) + 1);
      const subject = fact.subject ?? "";
      subjectFacts.set(subject, (subjectFacts.get(subject) ?? 0) + 1);
    }
  }
  const singletons = [...predicateFacts.values()].filter((n) => n === 1).length;
  console.log(
    `predicate space: ${predicateFacts.size} distinct, ` +
      `${((singletons / predicateFacts.size) * 100).toFixed(1)}% singletons`,
  );
  const topSubjects = [...subjectFacts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(
    `top subjects: ${topSubjects
      .map(([s, n]) => `${s} ${((n / factCount) * 100).toFixed(1)}%`)
      .join(", ")}`,
  );
  const topPredicates = [...predicateFacts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`top predicates: ${topPredicates.map(([p, n]) => `${p} (${n})`).join(", ")}\n`);

  let slotOf: (predicate: string) => Slot | null = () => null;
  if (rule === "slot") {
    const { map, meta } = loadSlotMap();
    if (meta.fingerprint !== fingerprint) {
      throw new Error(
        `slot map was built for ${meta.fingerprint} but this replay is measuring ${fingerprint}`,
      );
    }
    console.log(
      `slot map: ${map.size} predicates mapped at threshold ${meta.threshold} (${SLOT_MAP_PATH})\n`,
    );
    slotOf = (predicate) => map.get(predicate) ?? null;
  }

  // Session dates, for `--order session`. Read from the corpus, not from `validStart`:
  // `validStart` is model output and is the thing being tested.
  const corpus = loadCorpus();
  const sessionDate = new Map<string, string>();
  for (const sample of corpus) {
    sample.haystack_session_ids.forEach((id, index) => {
      const raw = sample.haystack_dates?.[index];
      if (raw === undefined || sessionDate.has(id)) return;
      try {
        sessionDate.set(id, sessionDateToIso(raw));
      } catch {
        /* an unparseable corpus date falls back to validStart ordering for that session */
      }
    });
  }

  for (const scope of scopes) {
    const stats = emptyStats(scope, rule, order);
    if (scope === "lifetime") {
      replayBank(toReplayFacts([...bySession.keys()], bySession, sessionDate, order), rule, stats, slotOf);
    } else if (scope === "prefix") {
      const groups = new Map<string, string[]>();
      for (const sessionId of bySession.keys()) {
        const key = sessionPrefix(sessionId);
        const bucket = groups.get(key);
        if (bucket) bucket.push(sessionId);
        else groups.set(key, [sessionId]);
      }
      for (const sessions of groups.values()) {
        replayBank(toReplayFacts(sessions, bySession, sessionDate, order), rule, stats, slotOf);
      }
    } else {
      for (const sample of corpus) {
        replayBank(
          toReplayFacts(sample.haystack_session_ids, bySession, sessionDate, order),
          rule,
          stats,
          slotOf,
        );
      }
    }
    report(stats);
  }

  if (rule === "slot" && order === "validstart") {
    console.log(
      "NOTE: `--order validstart` sorts every bank by `when`, so no already-active row can be\n" +
        "dated later than the row being written and two-sided closure (rule 2) is vacuous BY\n" +
        "CONSTRUCTION — a 0 above is arithmetic, not evidence. Re-run with `--order session`\n" +
        "for the ingest order the product has, where backdating is real (7.0% of this\n" +
        "generation's rows carry a `validStart` that is not their session date).",
    );
  }
  if (rule === "slot") {
    console.log(
      "NOTE: every cached fact is `provenance: extracted`, so rule 3 (provenance immunity) is\n" +
        "always equal-vs-equal here and this replay cannot exercise it. It is pinned by unit\n" +
        "test, not by this number.",
    );
  }
}

// Only run when executed directly — tests and sibling scripts import from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
