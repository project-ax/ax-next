/**
 * Re-express a results file in the SAME metrics as the Strata e2e report
 * (`docs/plans/2026-09-14-memory-strata-e2e-report.md`) so the two can be read side by side.
 *
 * Only meaningful for a run selected with `--sampler spaced`: that reproduces Strata's
 * stratified sample, so the rows are the same questions.
 *
 *   npx tsx bench/compare-strata.ts bench/results/n100-glm/run-*.jsonl
 */
import { readFileSync } from "node:fs";

/** TASK-368 gold-quality audit: 3 LongMemEval-S rows whose gold answer is not supported. */
const KNOWN_BAD_GOLD = new Set(["7024f17c", "eaca4986", "0a995998"]);

const POSITIVE = new Set(["correct", "abstained-correctly"]);

interface Row {
  question_id: string;
  question_type: string;
  verdict: string;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function report(rows: Row[], label: string): void {
  const scored = rows.filter((row) => row.verdict !== "error");
  const correct = scored.filter((row) => POSITIVE.has(row.verdict)).length;
  const unanswerable = scored.filter((row) => row.question_id.endsWith("_abs"));
  const answerable = scored.filter((row) => !row.question_id.endsWith("_abs"));

  console.log(`\n## ${label}  (n=${scored.length})\n`);
  console.log(`| metric | value |`);
  console.log(`| :---- | :---- |`);
  console.log(`| end-to-end accuracy (correct + correct-refusal) | **${pct(correct, scored.length)}** |`);
  console.log(`| uncertain (judge couldn't tell) | ${pct(scored.filter((r) => r.verdict === "uncertain").length, scored.length)} |`);
  console.log(`| unanswerable questions | ${unanswerable.length} |`);
  console.log(`| correct-refusal rate | ${pct(unanswerable.filter((r) => r.verdict === "abstained-correctly").length, unanswerable.length)} |`);
  console.log(`| hallucination rate (answered an unanswerable) | ${pct(unanswerable.filter((r) => r.verdict !== "abstained-correctly").length, unanswerable.length)} |`);
  console.log(`| false-refusal rate (refused an answerable) | ${pct(answerable.filter((r) => r.verdict === "abstained-incorrectly").length, answerable.length)} |`);

  const byType = new Map<string, Row[]>();
  for (const row of scored) byType.set(row.question_type, [...(byType.get(row.question_type) ?? []), row]);
  console.log(`\n| question_type | n | accuracy |`);
  console.log(`| :---- | :---- | :---- |`);
  for (const [type, group] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`| ${type} | ${group.length} | ${pct(group.filter((r) => POSITIVE.has(r.verdict)).length, group.length)} |`);
  }
}

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("usage: compare-strata.ts <results.jsonl> [...]");
for (const path of paths) {
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Row];
      } catch {
        return [];
      }
    });
  report(rows, path);
  const present = rows.filter((r) => KNOWN_BAD_GOLD.has(r.question_id));
  if (present.length > 0) {
    report(
      rows.filter((r) => !KNOWN_BAD_GOLD.has(r.question_id)),
      `${path} — excluding ${present.length} known-bad-gold row(s): ${present.map((r) => r.question_id).join(", ")}`,
    );
  }
}
