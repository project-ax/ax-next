// Guard: auto-ship's merge-queue review gate must compare the sha a reviewer actually
// approved against the sha it is about to merge -- over the WHOLE post-review delta --
// and the code-lane handoff must carry that sha so the comparison is possible at all.
//
// Why this exists (TASK-382). The gate used to read one field: the handoff's
// `reviewer:`. `clean` meant merge. But `reviewer: clean` is an honest answer to a
// question about the PAST, and the ordinary builder rhythm is review -> apply the
// findings -> push the fix. That fix commit becomes the PR head, and nobody has read
// it. The gate never asked, so it never noticed.
//
// SEVEN PRs across the 2026-09-16 and 2026-09-17 auto-ship runs, and the evidence is
// not uniform across them -- worth separating, since this whole card is about claims
// outrunning what was checked:
//
//   - #553, #556, #557 are the strongest: the unreviewed commit is on record AND the
//     independent pass the orchestrator ordered on it returned a named finding -- an
//     **Important** on #553, **two Majors** on #556, a **Major** on #557. On #553 and
//     #557 a wrong rule had already been committed into `.claude/memory/`, the file
//     every later agent reads as ground truth.
//   - #554 has the unreviewed head on record (20 lines of `permission-frames.ts`) with
//     no finding reported either way. It shows the gate let it through; it does not
//     show harm. (#553 and #554 were 2 of 2 in their run -- that is where this card
//     came from.)
//   - #558, #559, #560 are the ORCHESTRATOR'S ACCOUNT, not something measured here: it
//     reports all three had production code the reviewer never saw, and that their
//     builders classified their own post-review deltas correctly -- but only because it
//     asked each of them by hand. What is not in dispute is that the asking was a habit
//     living in whoever was driving.
//
// THE HEAD-COMMIT TEST IS NOT SUFFICIENT, and that is the expensive half of this
// lesson. The obvious fix -- "scope-test the head commit" -- was measured to miss:
// **#556**'s head commit was memory-only, so a head-commit scope test PASSES it, while
// three production files (`AgentConversation.tsx`, `ThreadFind.tsx`, `thread-find.ts`)
// sat unreviewed one commit below. Hence property 2 below, which pins the file scan to
// a RANGE anchored at the reviewed sha rather than to a single commit.
//
// The opposite over-correction is also a bug, and a worse one: "re-review every
// review-fix commit" makes the merge queue non-terminating. What keeps it bounded is
// the `fix:` / `new:` classification the handoff now carries -- so property 4 pins that
// vocabulary, because a gate that loses it is a gate whose handoff field is orphaned.
//
// WHAT THIS ASSERTS, AND WHY EACH PART EARNS ITS PLACE. Two files, two parses. Six
// properties, each pinned because a plausible edit breaks exactly that one and nothing
// else:
//
//   1. The gate names a two-dot git RANGE anchored at the reviewed sha -- a range, not
//      a mention of the field, because the range IS the comparison.
//   2. That range is scanned for FILES (`--name-only`), not merely listed as commits.
//      Without it the gate cannot run its own scope test; and swapping the range for a
//      single commit (`git show --name-only HEAD`) is exactly the #556 miss.
//   3. The routing is scope-based in BOTH directions: a tests/docs/`.claude/memory/`-
//      only delta may merge on the builder's `clean`, and a delta touching production
//      code orders an independent pass.
//   4. The gate still speaks the `fix:` / `new:` labels the handoff emits. This is the
//      termination bound, and the part most likely to be quietly dropped by an editor
//      tightening prose.
//   5. The code-lane handoff block declares a `reviewed-sha:` field, and
//   6. the builder-facing PROMPT (the blockquote, not the orchestrator prose above it)
//      tells the builder to produce it with its labels. 5 without 6 is a field nobody
//      is told to fill; 6 in the prose above the blockquote is an orchestrator habit,
//      which is the same shape as the defect this card fixes.
//
// MUTANTS ACTUALLY RUN (not reasoned about), all against this file as committed:
//
//   - The pre-TASK-382 text of both skill files (`main` at 07a89496): **6 of the 7
//     assertions red**. The survivor is the code-lane parse check, which should
//     survive -- that section already existed. `reviewed-sha` occurred **0 times** in
//     `.claude/skills/auto-ship/` before this card, which is the whole finding.
//   - `--name-only <range>` replaced by `git show --name-only HEAD` (the head-commit
//     test the card originally proposed): **exactly property 2 red**, everything else
//     green. This is the mutant worth having -- that variant is what PR #556 walked
//     straight through.
//   - The tests/docs/memory allowance bullet deleted ("always re-review"): **exactly
//     property 3 red**.
//   - The production-code bullet deleted ("always merge"): **exactly property 3 red** --
//     but only after the `bullets()` helper below was fixed. It was GREEN first, which
//     is documented at that helper and is the reason this file's copy differs from the
//     two sibling guards'.
//
// Lives in scripts/__tests__/, which `pnpm test:scripts` runs unconditionally -- no
// network, no build, no subprocess (same pattern as autoship-dispatch-scratch-scoping
// and autoship-dispatch-fresh-worktree-build, whose helpers this file mirrors).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'auto-ship', 'SKILL.md');
const TEMPLATES_PATH = join(REPO_ROOT, '.claude', 'skills', 'auto-ship', 'references', 'templates.md');

const skillText = readFileSync(SKILL_PATH, 'utf8');
const templatesText = readFileSync(TEMPLATES_PATH, 'utf8');

/**
 * The body of a `## `-level section, up to the next `## ` heading or EOF.
 *
 * Matched line by line with `startsWith('## ')`, i.e. anchored at column 0, so a `## `
 * inside a fenced block or a blockquote cannot end the section early. (The merge-queue
 * section contains a long fenced shell block whose comment lines start with a single
 * `# `; those do not match.)
 */
function sectionBody(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `## ${heading}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * The blockquote inside a section, `> ` markers stripped -- the literal prompt text a
 * builder receives. Everything NOT quoted is orchestrator-facing prose, which is what
 * property 6 needs to tell apart.
 */
function blockquote(body) {
  return body
    .split('\n')
    .filter((l) => l === '>' || l.startsWith('> '))
    .map((l) => l.slice(2))
    .join('\n');
}

/**
 * Top-level `- ` bullets, each carrying its own INDENTED continuation lines.
 *
 * Properties that must hold of ONE bullet are tested against these, not against the
 * whole text: a document that mentions a scope rule in one place and `production` in an
 * unrelated one has not stated the rule.
 *
 * A bullet ends at the first line that is blank or starts at column 0 -- which is the
 * one way this differs from the same helper in the two sibling guards, and it is not
 * cosmetic. Theirs appends EVERY non-bullet line to the last bullet seen, so in a
 * document where prose follows a list (this gate: three scope bullets, then several
 * paragraphs) the final bullet silently swallows the rest of the section. Measured
 * while mutation-testing this file: deleting the production-code bullet outright left
 * the `always-merge` mutant GREEN, because the deleted bullet's words reappeared in the
 * prose the survivor had absorbed. Their prompts are bullets end to end, so the bug is
 * unreachable there; here it made a real assertion vacuous.
 *
 * Same remaining limit as the siblings: only `- ` bullets are recognized, so a reformat
 * to `* ` would redden this even though the property still holds. Both files use `- `
 * throughout; that fails legibly rather than passing silently.
 */
function bullets(text) {
  const out = [];
  let open = false;
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) {
      out.push(line);
      open = true;
    } else if (open && /^\s+\S/.test(line)) {
      out[out.length - 1] += `\n${line}`;
    } else {
      open = false;
    }
  }
  return out;
}

/** From the first line starting with `marker` to the end of `body`. */
function fromMarker(body, marker) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.startsWith(marker));
  return start === -1 ? undefined : lines.slice(start).join('\n');
}

// The reviewed sha, in either spelling the gate may use: the handoff field name
// (`reviewed-sha`, also its `<reviewed-sha>` placeholder form) or a shell variable
// bound from it. Deliberately tolerant of naming, strict about the concept.
const REVIEWED_SHA_TOKEN = String.raw`(?:<reviewed-sha>|\$\{?REVIEWED_SHA\}?|reviewed[-_]sha)`;

// A two-dot git range anchored at the reviewed sha. `(?!\.)` rejects the three-dot
// form, and more importantly this cannot be satisfied by prose that merely names the
// field -- a range is the comparison.
const RANGE_FROM_REVIEWED = new RegExp(`${REVIEWED_SHA_TOKEN}\\.\\.(?!\\.)`);

// The same range, scanned for FILES. `git show --name-only HEAD` -- the head-commit
// test that #556 defeated -- cannot match this, because it has no range.
const FILE_SCAN_OVER_RANGE = new RegExp(`--name-only[^\\n]*${REVIEWED_SHA_TOKEN}\\.\\.(?!\\.)`);

const MEMORY_DIR = /\.claude\/memory\//;
const MERGE_ON_BUILDERS_WORD = /merge on the builder'?s?\s+`?clean/i;
const PRODUCTION = /production/i;
const INDEPENDENT_PASS = /independent pass/i;
const FIX_LABEL = /`fix:`/;
const NEW_LABEL = /`new:`/;

const mergeQueueBody = sectionBody(skillText, 'Merge queue (serialized — you own it)');
const gateBlock = mergeQueueBody === undefined ? undefined : fromMarker(mergeQueueBody, '**Review gate (blocking');
const gateBullets = gateBlock === undefined ? [] : bullets(gateBlock);

const codeLaneBody = sectionBody(templatesText, 'Code-lane dispatch prompt');
const codeLanePrompt = codeLaneBody === undefined ? undefined : blockquote(codeLaneBody);
const promptBullets = codeLanePrompt === undefined ? [] : bullets(codeLanePrompt);

describe('auto-ship merge-queue review gate compares reviewed sha to merge head (TASK-382)', () => {
  it('finds the review gate at all — a broken parse would pass everything below', () => {
    // Vacuity guard, in the house style. Every assertion below searches text this parse
    // produced, so an empty parse makes all of them trivially green.
    expect(
      mergeQueueBody,
      `no "## Merge queue (serialized — you own it)" section in ${SKILL_PATH}`,
    ).not.toBeUndefined();
    expect(
      gateBlock,
      `no "**Review gate (blocking" paragraph in the merge-queue section of ${SKILL_PATH}`,
    ).not.toBeUndefined();
    expect(
      gateBlock.length,
      'the review gate parsed to almost nothing — the marker scan broke',
    ).toBeGreaterThan(500);
    expect(
      gateBullets.length,
      'the review gate has fewer than 3 `- ` bullets — either it was reformatted (this guard needs updating) or the scope routing property 3 searches for was never written',
    ).toBeGreaterThanOrEqual(3);
  });

  it('ranges over the post-review delta, and scans it for FILES — not just the head commit', () => {
    if (gateBlock === undefined) return; // reported by the test above

    expect(
      RANGE_FROM_REVIEWED.test(gateBlock),
      `${SKILL_PATH}: the review gate never forms a git range from the reviewed sha, so it still asks the handoff's \`reviewer:\` field instead of the branch — the defect that walked 7 PRs up to the merge door, 3 of them with a named finding behind it`,
    ).toBe(true);

    expect(
      FILE_SCAN_OVER_RANGE.test(gateBlock),
      `${SKILL_PATH}: the gate names the reviewed sha but never lists the delta's FILES (\`--name-only <reviewed-sha>..<head>\`), so it cannot run its own scope test. A head-commit-only scan is what PR #556 defeated: its head commit was memory-only while three production files sat unreviewed one commit below`,
    ).toBe(true);
  });

  it('routes on scope: memory/docs/tests-only may merge, production orders a pass', () => {
    if (gateBlock === undefined) return; // reported by the test above

    const allowance = gateBullets.filter((b) => MEMORY_DIR.test(b) && MERGE_ON_BUILDERS_WORD.test(b));
    const requirement = gateBullets.filter((b) => PRODUCTION.test(b) && INDEPENDENT_PASS.test(b));

    expect(
      allowance.length,
      `${SKILL_PATH}: no bullet lets a tests/docs/\`.claude/memory/\`-only delta merge on the builder's \`clean\`. Without it the gate re-reviews every review-fix commit and the merge queue never terminates`,
    ).toBeGreaterThanOrEqual(1);

    expect(
      requirement.length,
      `${SKILL_PATH}: no bullet requires an independent pass when the post-review delta touches production code. That is the whole gate — do not weaken it to "the delta is small": the two misses whose line counts were recorded were an 18-line and a 20-line review-fix commit`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('still speaks the `fix:` / `new:` labels the handoff emits', () => {
    if (gateBlock === undefined) return; // reported by the test above

    expect(
      FIX_LABEL.test(gateBlock) && NEW_LABEL.test(gateBlock),
      `${SKILL_PATH}: the gate no longer names both the \`fix:\` and \`new:\` labels, so the handoff field that carries them routes nothing. That classification is what bounds this gate — without it the only options are "trust the builder" (the measured defect) and "re-review everything" (a non-terminating queue)`,
    ).toBe(true);
  });
});

describe('auto-ship code-lane handoff carries the reviewed sha (TASK-382)', () => {
  it('finds the code-lane dispatch prompt and its bullets — a broken parse would pass everything below', () => {
    expect(
      codeLaneBody,
      `no "## Code-lane dispatch prompt" section in ${TEMPLATES_PATH}`,
    ).not.toBeUndefined();
    expect(
      codeLanePrompt.length,
      'the code-lane section has no `> `-quoted prompt body — the blockquote scan broke',
    ).toBeGreaterThan(500);
    expect(
      promptBullets.length,
      'the code-lane prompt has no `- ` bullets — it was reformatted and this guard needs updating',
    ).toBeGreaterThanOrEqual(5);
  });

  it('declares a `reviewed-sha:` field in the handoff block', () => {
    if (codeLanePrompt === undefined) return; // reported by the test above

    expect(
      /^reviewed-sha:/m.test(codeLanePrompt),
      `${TEMPLATES_PATH}: the ≤150-word handoff has no \`reviewed-sha:\` field, so the merge gate has nothing to compare \`headSha:\` against and is back to inferring from \`reviewer: clean\``,
    ).toBe(true);
  });

  it('tells the builder, in the prompt itself, to produce it with `fix:` / `new:` labels', () => {
    if (codeLanePrompt === undefined) return; // reported by the test above

    const instructing = promptBullets.filter(
      (b) => /reviewed-sha/.test(b) && FIX_LABEL.test(b) && NEW_LABEL.test(b),
    );

    const diagnosis = (() => {
      if (promptBullets.some((b) => /reviewed-sha/.test(b))) {
        return 'a bullet names `reviewed-sha` but not the `fix:` / `new:` labels — the gate routes on those, and without them it can only trust or re-review';
      }
      if (/reviewed-sha/.test(codeLaneBody)) {
        return 'the reviewed-sha instruction sits in the orchestrator-facing prose, not in the `> `-quoted builder prompt — that is an orchestrator habit, not a fix — asking by hand is exactly what the 2026-09-17 orchestrator had to do, card by card';
      }
      return 'the builder prompt never asks which sha the reviewer approved, so the handoff field (if declared at all) is one nobody is told to fill';
    })();

    expect(instructing.length, `${TEMPLATES_PATH}: ${diagnosis}`).toBeGreaterThanOrEqual(1);
  });
});
