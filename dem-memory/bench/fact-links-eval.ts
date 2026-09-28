/**
 * Fact links, measured: over real product fact banks, how often does Jev link a newer fact to
 * an older one (`updates` / `same_event`), and how often is it right?
 *
 * The rung-4 product run's knowledge-update failures were all UNLINKED pairs — both values
 * stored under different relations — and one counting failure was a single bake stored twice.
 * A hand-picked probe got 18/19. This asks the question that probe could not: on the REAL
 * pair distribution a write-time pass would see (each fact against its nearest earlier
 * same-subject facts), what is the link rate and the precision?
 *
 *   npx tsx bench/fact-links-eval.ts --phase candidates --banks ~/.cache/ax-memory-bench/task497-banks
 *   npx tsx bench/fact-links-eval.ts --phase links --banks ... [--k 5] [--min-cosine 0.6] [--labels bench/fact-link-labels.json]
 *
 *  candidates  free: vector coverage, pair counts across k / cosine floors, and whether each
 *              KNOWN failure pair is generated at all (a pair never generated is never linked).
 *  links       one Jev call per pair (cached in `bench/cache/jev/decisions.ndjson`): link rate
 *              by threshold, the known pairs' verdicts, and a seeded sample of links to label.
 *              With `--labels`, precision by threshold over the labelled links.
 *
 * Measurement only; nothing here writes to a bank (`readonly` connections).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { CACHE_DIR, parseArgs, runWithConcurrency } from "./harness.js";
import { DecisionCache, JevClient, SpendCapError, SpendMeter, parseChoiceResponse, type OptionAnswer } from "./jev.js";
import {
  LINK_OPTION_SET,
  buildLinkRequest,
  candidatePairs,
  linkFromAnswer,
  type CandidatePair,
  type LinkFact,
  type LinkOption,
} from "./fact-links.js";

const JEV_CACHE_DIR = join(CACHE_DIR, "jev");
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9];
const ESTIMATE_PER_CALL = 0.0005;

/**
 * The rung-4 failure pairs, by question and relation. `expect` is what a correct link says.
 * Located by relation + value prefix, so a re-extracted bank that lost one reports `missing`.
 */
const KNOWN_PAIRS: Array<{ qid: string; a: [string, string]; b: [string, string]; expect: LinkOption }> = [
  { qid: "ed4ddc30", a: ["egg_stock", "User has 30 dozen"], b: ["has_egg_stock", "20 dozen"], expect: "updates" },
  { qid: "a2f3aa27", a: ["has_instagram_followers", "1250"], b: ["has_follower_count", "close to 1300"], expect: "updates" },
  { qid: "6a1eabeb", a: ["achieved_personal_best", "set a personal best"], b: ["training_for_charity_5k", "User is training"], expect: "updates" },
  { qid: "eace081b", a: ["planning_trip", "Birthday trip to Hawaii (Kauai)"], b: ["planning_birthday_trip", "Birthday trip to Hawaii (Oahu)"], expect: "updates" },
  { qid: "4b24c848", a: ["bought_items", "three tops"], b: ["owns_tops_from_hm", "User already owns five"], expect: "updates" },
  { qid: "07741c44", a: ["stores_sneakers", "old sneakers stored"], b: ["plans_to_organize", "Closet this weekend"], expect: "updates" },
  { qid: "88432d0a", a: ["baked_dense_bread", "Tried a new sourdough"], b: ["baked", "a new bread recipe using sourdough"], expect: "same_event" },
  { qid: "88432d0a", a: ["baked_chocolate_cake", "Baked a chocolate cake for their sister's birthday party using"], b: ["baked_chocolate_cake", "Baked a chocolate cake for their sister's birthday party last"], expect: "same_event" },
  { qid: "0a995998", a: ["exchanged_boots_at_zara", "User bought boots"], b: ["has_pending_pickup", "Exchanged a pair"], expect: "same_event" },
];

interface Bank {
  qid: string;
  facts: LinkFact[];
  vectors: Map<string, Float32Array>;
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

function loadBanks(dir: string, completeOnly = false): Bank[] {
  const banks: Bank[] = [];
  for (const path of findFactDbs(dir)) {
    const bankDir = join(path, "..", "..");
    // A bank still being built has no question.json yet; its pairs would change under us.
    if (completeOnly && !existsSync(join(bankDir, "question.json"))) continue;
    let qid = bankDir;
    // Rung-4 banks name their question in the answer capture; banks built by
    // `scripts/memory-bench-build-banks.mjs` write `question.json`.
    for (const file of ["question.json", "answer-sonnet.json"]) {
      try {
        qid = (JSON.parse(readFileSync(join(bankDir, file), "utf8")) as { questionId: string }).questionId;
        break;
      } catch {
        /* try the next; a bank with neither keeps its directory name */
      }
    }
    const db = new Database(path, { readonly: true, fileMustExist: true });
    sqliteVec.load(db);
    try {
      const facts = db
        .prepare(
          "SELECT id, about, relation, value, valid_start AS \"when\" FROM memory_facts_v1 " +
            "WHERE valid_end LIKE '9999%' ORDER BY valid_start, transaction_time, id",
        )
        .all() as LinkFact[];
      const vectors = new Map<string, Float32Array>();
      for (const row of db.prepare("SELECT id, embedding FROM memory_facts_v1_vec").all() as Array<{ id: string; embedding: Buffer }>) {
        vectors.set(row.id, new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
      }
      banks.push({ qid, facts, vectors });
    } finally {
      db.close();
    }
  }
  return banks;
}

const isUser = (about: string): boolean => about === "user" || about.startsWith("user:");

function locateKnown(banks: Bank[]): Array<{ known: (typeof KNOWN_PAIRS)[number]; a?: LinkFact; b?: LinkFact; bank?: Bank }> {
  return KNOWN_PAIRS.map((known) => {
    const bank = banks.find((b) => b.qid === known.qid);
    const find = ([relation, prefix]: [string, string]): LinkFact | undefined =>
      bank?.facts.find((f) => f.relation === relation && f.value.startsWith(prefix));
    return { known, bank, a: find(known.a), b: find(known.b) };
  });
}

function pairsFor(bank: Bank, k: number, minCosine: number, subjects: string, lexicalK = 0): CandidatePair[] {
  return candidatePairs(bank.facts, bank.vectors, {
    k,
    minCosine,
    lexicalK,
    about: subjects === "all" ? undefined : isUser,
  });
}

function candidatesPhase(banks: Bank[], subjects: string): void {
  const facts = banks.reduce((n, b) => n + b.facts.length, 0);
  const withVec = banks.reduce((n, b) => n + b.facts.filter((f) => b.vectors.has(f.id)).length, 0);
  const userFacts = banks.reduce((n, b) => n + b.facts.filter((f) => isUser(f.about)).length, 0);
  console.log(`${banks.length} banks, ${facts} active facts (${userFacts} about the user), ${withVec} with a vector (${((withVec / facts) * 100).toFixed(1)}%)\n`);
  console.log(`pair counts (${subjects} subjects):`);
  console.log("  k   min-cos    pairs   per-fact");
  for (const k of [3, 5]) {
    for (const minCosine of [0.5, 0.6, 0.7, 0.8]) {
      const n = banks.reduce((sum, b) => sum + pairsFor(b, k, minCosine, subjects).length, 0);
      console.log(`  ${k}   ${minCosine.toFixed(2)}   ${String(n).padStart(7)}   ${(n / Math.max(1, subjects === "all" ? facts : userFacts)).toFixed(2)}`);
    }
  }
  console.log("\nknown failure pairs — generated as candidates? (rank = position among B's earlier same-subject neighbours)");
  for (const { known, a, b, bank } of locateKnown(banks)) {
    if (!bank || !a || !b) {
      console.log(`  missing  ${known.qid} ${known.a[0]} -> ${known.b[0]}`);
      continue;
    }
    // Facts sharing a date are ordered by the store, so a pair can come out either way round.
    const all = pairsFor(bank, 1000, -1, subjects);
    const forward = all.filter((p) => p.b === b.id);
    const backward = all.filter((p) => p.b === a.id);
    let index = forward.findIndex((p) => p.a === a.id);
    let hit = forward[index];
    let of = forward.length;
    if (!hit) {
      index = backward.findIndex((p) => p.a === b.id);
      hit = backward[index];
      of = backward.length;
    }
    console.log(
      `  ${known.qid}  ${known.a[0]} -> ${known.b[0]}: ` +
        (hit ? `cosine ${hit.cosine.toFixed(3)}, rank ${index + 1} of ${of}` : `NOT a candidate (vector a:${bank.vectors.has(a.id)} b:${bank.vectors.has(b.id)}, order?)`),
    );
  }
}

interface Label {
  correct: boolean;
  arguable: boolean;
}

async function linksPhase(banks: Bank[], args: Record<string, string>, subjects: string): Promise<void> {
  const k = Number(args.k ?? 5);
  const minCosine = Number(args["min-cosine"] ?? 0.6);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be in the environment");
  mkdirSync(JEV_CACHE_DIR, { recursive: true });
  const meter = new SpendMeter(Number(args.cap ?? 3), ESTIMATE_PER_CALL);
  const client = new JevClient({ apiKey, cache: new DecisionCache(join(JEV_CACHE_DIR, "decisions.ndjson")), meter });

  type Job = { bank: Bank; pair: CandidatePair; a: LinkFact; b: LinkFact };
  const samePair = (j: Job, a: LinkFact, b: LinkFact): boolean =>
    (j.a.id === a.id && j.b.id === b.id) || (j.a.id === b.id && j.b.id === a.id);
  const jobs: Job[] = [];
  for (const bank of banks) {
    const byId = new Map(bank.facts.map((f) => [f.id, f]));
    for (const pair of pairsFor(bank, k, minCosine, subjects, Number(args["lexical-k"] ?? 0))) {
      const a = byId.get(pair.a);
      const b = byId.get(pair.b);
      if (a && b) jobs.push({ bank, pair, a, b });
    }
  }
  // The known pairs are always asked, even when the candidate rule would not generate them —
  // their verdict is reported separately from the realistic distribution.
  const known = locateKnown(banks);
  for (const { a, b, bank } of known) {
    if (a && b && bank && !jobs.some((j) => samePair(j, a, b))) {
      jobs.push({ bank, pair: { a: a.id, b: b.id, cosine: Number.NaN }, a, b });
    }
  }
  console.log(`asking Jev about ${jobs.length} pairs (k ${k}, min cosine ${minCosine}, ${subjects} subjects)`);

  const answers = new Map<Job, OptionAnswer<LinkOption>>();
  const latencies: number[] = [];
  let fresh = 0;
  let capped: unknown = null;
  let done = 0;
  await runWithConcurrency(jobs, Number(args.concurrency ?? 16), async (job) => {
    if (capped) return;
    try {
      const result = await client.decideWith(
        buildLinkRequest(job.a, job.b),
        (body, ids) => parseChoiceResponse(body, ids, LINK_OPTION_SET),
      );
      const answer = result.parsed.answers.get("rel");
      if (answer) answers.set(job, answer);
      if (!result.cached) {
        fresh += 1;
        latencies.push(result.latencyMs);
      }
    } catch (error) {
      if (error instanceof SpendCapError) capped = error;
      else process.stderr.write(`  call failed: ${String(error)}\n`);
    }
    done += 1;
    if (done % 2000 === 0) process.stderr.write(`  ${done}/${jobs.length}, $${meter.spent.toFixed(4)}\n`);
  });
  if (capped) console.log(`STOPPED AT THE SPEND CAP: ${String(capped)}`);

  const realistic = jobs.filter((j) => !Number.isNaN(j.pair.cosine));
  const userFacts = banks.reduce((n, b) => n + b.facts.filter((f) => subjects === "all" || isUser(f.about)).length, 0);
  console.log(`\n=== link rate over ${realistic.length} candidate pairs (${userFacts} facts in scope) ===`);
  console.log("  thr    updates   same_event   facts-with-any-link");
  for (const thr of THRESHOLDS) {
    let updates = 0;
    let same = 0;
    const linkedB = new Set<string>();
    for (const job of realistic) {
      const link = linkFromAnswer(answers.get(job), thr);
      if (link === "updates") updates += 1;
      if (link === "same_event") same += 1;
      if (link) linkedB.add(job.b.id);
    }
    console.log(`  ${thr.toFixed(2)}  ${String(updates).padStart(8)}  ${String(same).padStart(10)}   ${String(linkedB.size).padStart(6)} (${((linkedB.size / userFacts) * 100).toFixed(1)}%)`);
  }

  console.log("\n=== known failure pairs ===");
  for (const { known: kp, a, b } of known) {
    const job = a && b ? jobs.find((j) => samePair(j, a, b)) : undefined;
    const answer = job ? answers.get(job) : undefined;
    const generated = job && !Number.isNaN(job.pair.cosine);
    console.log(
      `  ${answer?.choice === kp.expect ? "ok  " : "MISS"}  ${kp.qid} ${kp.a[0]} -> ${kp.b[0]}: ${answer?.choice ?? "-"} ${answer?.p?.toFixed(2) ?? ""}` +
        `  (expect ${kp.expect}; ${generated ? "generated" : "NOT generated by the candidate rule"})`,
    );
  }

  // The link set an answer-level arm reads (`scripts/memory-fact-links-e2e.mjs`): every
  // candidate pair Jev linked at or above `--links-threshold`, with both facts spelled out.
  if (args["write-links"]) {
    const bar = Number(args["links-threshold"] ?? 0.8);
    const links = realistic.flatMap((job) => {
      const answer = answers.get(job);
      const link = linkFromAnswer(answer, bar);
      return link ? [{ qid: job.bank.qid, link, p: answer?.p, a: job.a, b: job.b }] : [];
    });
    writeFileSync(args["write-links"], JSON.stringify({ threshold: bar, k, minCosine, links }, null, 1));
    console.log(`\nwrote ${links.length} links at p >= ${bar} to ${args["write-links"]}`);
  }

  // A seeded sample of links at the lowest reported bar, for hand-labelling.
  const linked = realistic
    .filter((job) => linkFromAnswer(answers.get(job), THRESHOLDS[0] ?? 0.5) !== null)
    .sort((x, y) => `${x.a.id}${x.b.id}`.localeCompare(`${y.a.id}${y.b.id}`));
  let seed = 0x5eed;
  const sample: typeof linked = [];
  const pool = [...linked];
  const size = Number(args.sample ?? 120);
  while (sample.length < Math.min(size, linked.length)) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const [pick] = pool.splice(seed % pool.length, 1);
    if (pick) sample.push(pick);
  }
  const key = (job: Job): string => `${job.a.id}|${job.b.id}`;
  const samplePath = join(JEV_CACHE_DIR, "fact-link-sample.json");
  writeFileSync(
    samplePath,
    JSON.stringify(
      sample.map((job) => {
        const answer = answers.get(job);
        return { key: key(job), qid: job.bank.qid, choice: answer?.choice, p: answer?.p, cosine: job.pair.cosine, a: job.a, b: job.b };
      }),
      null,
      1,
    ),
  );
  console.log(`\nwrote ${sample.length} of ${linked.length} links (p >= ${THRESHOLDS[0]}) to ${samplePath} for labelling`);

  if (args.labels) {
    const labels = new Map(
      (JSON.parse(readFileSync(args.labels, "utf8")) as { labels: Array<[string, string, boolean, boolean]> }).labels.map(
        ([k2, choice, correct, arguable]) => [`${k2}|${choice}`, { correct, arguable } as Label],
      ),
    );
    console.log(`\n=== precision of links in the labelled sample (labels: ${args.labels}) ===`);
    console.log("  thr    labelled   correct   strict          lenient         | updates (strict) | same_event (strict)");
    for (const thr of THRESHOLDS) {
      const tally = { all: [0, 0], updates: [0, 0], same_event: [0, 0] } as Record<string, [number, number]>;
      let lenient = 0;
      for (const job of sample) {
        const link = linkFromAnswer(answers.get(job), thr);
        if (!link) continue;
        const label = labels.get(`${key(job)}|${link}`);
        if (!label) continue;
        if (label.correct || label.arguable) lenient += 1;
        for (const bucket of ["all", link]) {
          const t = tally[bucket]!;
          t[0] += 1;
          if (label.correct) t[1] += 1;
        }
      }
      const pct = ([n, c]: [number, number]): string => (n === 0 ? "   n/a" : `${c}/${n} ${((c / n) * 100).toFixed(1)}%`);
      console.log(`  ${thr.toFixed(2)}  ${String(tally.all![0]).padStart(8)}  ${String(tally.all![1]).padStart(8)}   ${pct(tally.all!).padStart(14)}  ${pct([tally.all![0], lenient]).padStart(14)}  | ${pct(tally.updates!).padStart(16)} | ${pct(tally.same_event!)}`);
    }
  }

  const sorted = [...latencies].sort((x, y) => x - y);
  const pctl = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  console.log(`\n${fresh} fresh calls, latency p50 ${pctl(50).toFixed(0)} ms / p95 ${pctl(95).toFixed(0)} ms; spend this run $${meter.spent.toFixed(4)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.banks) throw new Error("--banks <dir> is required");
  const subjects = args.subjects ?? "user";
  const banks = loadBanks(args.banks.replace(/^~(?=\/)/, homedir()), args["complete-only"] === "true");
  if ((args.phase ?? "candidates") === "candidates") candidatesPhase(banks, subjects);
  else await linksPhase(banks, args, subjects);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
