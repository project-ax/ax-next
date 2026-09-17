/**
 * Compare two scored arms on the SAME questions, the way this bench's error budget requires.
 *
 *   npx tsx bench/compare-arms.ts bench/results/n500-glm-ctrl1 bench/results/n500-glm-treat1
 *
 * Why not just diff the totals: at n=100 this bench's measured noise floor is +/-4-6pp on
 * IDENTICAL code, with 21 of 100 questions flipping across eight repeats. An unpaired
 * comparison of two totals cannot see a targeted effect through that. The runs are PAIRED --
 * same questions, same judge -- so the signal lives in the DISCORDANT rows, and McNemar's
 * exact test on those is the right statistic.
 *
 * Abstention is reported beside accuracy and is not optional. Every directive that raises
 * willingness to answer buys accuracy on answerable questions with hallucination on
 * unanswerable ones (`_abs`), and a change that trades one for the other is an overfit, not
 * an improvement. Reporting the two together is what makes that visible in one glance.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Row {
  question_id: string;
  question_type?: string;
  verdict: string;
  answer?: string;
  reason?: string;
}

const CORRECT = new Set(["correct", "abstained-correctly"]);
const isCorrect = (row: Row): boolean => CORRECT.has(row.verdict);
const isUnanswerable = (id: string): boolean => id.endsWith("_abs");

function loadArm(path: string): Map<string, Row> {
  const file = path.endsWith(".jsonl")
    ? path
    : join(path, readdirSync(path).filter((f) => f.endsWith(".jsonl")).sort().at(-1) ?? "");
  const rows = new Map<string, Row>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as Row;
    rows.set(row.question_id, row);
  }
  return rows;
}

/**
 * Two-sided exact binomial p under H0: a discordant pair is equally likely to fall either way.
 * Exact rather than the chi-square approximation because the discordant counts here are small
 * (single digits per type), which is where the approximation is worst.
 */
function mcnemarExact(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const logC = (a: number, b: number): number => {
    let out = 0;
    for (let i = 0; i < b; i += 1) out += Math.log(a - i) - Math.log(i + 1);
    return out;
  };
  let tail = 0;
  const extreme = Math.min(wins, losses);
  for (let k = 0; k <= extreme; k += 1) tail += Math.exp(logC(n, k) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

const pct = (n: number, d: number): string => (d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1)}%`);

function main(): void {
  const [aPath, bPath] = process.argv.slice(2);
  if (!aPath || !bPath) throw new Error("usage: compare-arms.ts <control-dir> <treatment-dir>");
  const a = loadArm(aPath);
  const b = loadArm(bPath);

  const ids = [...a.keys()].filter((id) => b.has(id));
  const onlyA = [...a.keys()].filter((id) => !b.has(id));
  const onlyB = [...b.keys()].filter((id) => !a.has(id));
  console.log(`control  : ${aPath}  (${a.size} rows)`);
  console.log(`treatment: ${bPath}  (${b.size} rows)`);
  console.log(`paired on ${ids.length} questions` +
    (onlyA.length + onlyB.length > 0 ? `  [unpaired: ${onlyA.length} + ${onlyB.length}]` : ""));

  const errors = ids.filter((id) => a.get(id)!.verdict === "error" || b.get(id)!.verdict === "error");
  if (errors.length > 0) console.log(`WARNING: ${errors.length} row(s) scored 'error': ${errors.slice(0, 5).join(", ")}`);

  const types = [...new Set(ids.map((id) => a.get(id)!.question_type ?? "unknown"))].sort();
  console.log(`\n${"type".padEnd(28)}${"n".padStart(5)}${"control".padStart(10)}${"treat".padStart(10)}${"delta".padStart(9)}   W/L   p(McNemar)`);
  const line = (label: string, subset: string[]): void => {
    const ac = subset.filter((id) => isCorrect(a.get(id)!)).length;
    const bc = subset.filter((id) => isCorrect(b.get(id)!)).length;
    const wins = subset.filter((id) => !isCorrect(a.get(id)!) && isCorrect(b.get(id)!)).length;
    const losses = subset.filter((id) => isCorrect(a.get(id)!) && !isCorrect(b.get(id)!)).length;
    const delta = (100 * bc) / subset.length - (100 * ac) / subset.length;
    console.log(
      `${label.padEnd(28)}${String(subset.length).padStart(5)}${pct(ac, subset.length).padStart(10)}` +
        `${pct(bc, subset.length).padStart(10)}${`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`.padStart(9)}` +
        `${`${wins}/${losses}`.padStart(8)}   ${mcnemarExact(wins, losses).toFixed(3)}`,
    );
  };
  for (const type of types) line(type, ids.filter((id) => (a.get(id)!.question_type ?? "unknown") === type));
  console.log("-".repeat(80));
  line("TOTAL", ids);

  // Abstention, split the way the failure modes differ: inventing an answer to an
  // unanswerable question is a different (and worse) defect than refusing an answerable one.
  const unanswerable = ids.filter((id) => isUnanswerable(id));
  const answerable = ids.filter((id) => !isUnanswerable(id));
  console.log(`\nabstention (unanswerable n=${unanswerable.length}, answerable n=${answerable.length})`);
  console.log(`${"".padEnd(28)}${"control".padStart(10)}${"treat".padStart(10)}`);
  const halluc = (arm: Map<string, Row>): number =>
    unanswerable.filter((id) => arm.get(id)!.verdict !== "abstained-correctly").length;
  const refuse = (arm: Map<string, Row>): number =>
    answerable.filter((id) => arm.get(id)!.verdict === "abstained-incorrectly").length;
  console.log(
    `${"hallucination (worse=up)".padEnd(28)}${pct(halluc(a), unanswerable.length).padStart(10)}` +
      `${pct(halluc(b), unanswerable.length).padStart(10)}`,
  );
  console.log(
    `${"false refusal (worse=up)".padEnd(28)}${pct(refuse(a), answerable.length).padStart(10)}` +
      `${pct(refuse(b), answerable.length).padStart(10)}`,
  );

  const flippedTo = ids.filter((id) => !isCorrect(a.get(id)!) && isCorrect(b.get(id)!));
  const flippedFrom = ids.filter((id) => isCorrect(a.get(id)!) && !isCorrect(b.get(id)!));
  console.log(`\nWINS  (${flippedTo.length}): ${flippedTo.join(", ") || "(none)"}`);
  console.log(`LOSSES(${flippedFrom.length}): ${flippedFrom.join(", ") || "(none)"}`);
}

main();
