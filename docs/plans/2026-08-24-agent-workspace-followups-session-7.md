# agent-workspace follow-ups — session 7 handoff

**Written:** 2026-08-24, after executing the session-6 handoff's §12 decided plan.
**Supersedes:** `docs/plans/2026-08-24-agent-workspace-followups-session-6.md` for resuming.
Session 6 remains the best statement of the *dispatch discipline* (its §5 corrections and §7 infra
notes all held up). Its §12 was the plan this session executed; **§1 of this doc records where that
plan's own premise was wrong.**

---

## 0. What shipped

`main` @ `812e3818`. **5 merged, 0 open PRs, `pnpm lint` emits NOTHING** (0 errors, 0 warnings — the
standing warning is gone), `pnpm test:scripts` **138 tests across 11 files** (was 83/9).

| Card | PR | What actually landed |
|---|---|---|
| — (§12 steps 1–2) | #479 | the `.claude/memory` path guard + the 4 rot findings it produced + 2 conventions + the §9 poller leak |
| TASK-314 | #480 | 5 prose findings corrected — and a **6th site** the card never named |
| TASK-315 | #482 | malformed id stops borrowing the rate-limit message; `hb.sh` gains a third failure class |
| TASK-317 | #481 | image resident before tests + **Ryuk disabled** + a pull-list drift guard |
| — (hygiene) | #483 | the one unused `eslint-disable`, fixed instead of carded |

§12's Step 3 order (314 → 317 → 315) was followed. Steps 1, 2, 3 and 4 are all complete.

---

## 1. ⚠ §12's own premise was partly wrong, and measurement is what caught it

§12 Step 1 said: *"a guard that asserts every symbol and path named in `.claude/memory/*.md` still
exists will, on its first red run, enumerate the existing rot"*, and claimed it *"would have caught
TASK-241 and TASK-245"*. **Measured against the real corpus, three of four check classes were
worthless or harmful:**

| Class | Result |
|---|---|
| hook-shaped names (`skills:approved-caps-list`) | **187 cited, 187 resolve** — permanently vacuous |
| SCREAMING_SNAKE constants (`DISABLED_BUILTINS`) | **146 cited, 146 resolve** — permanently vacuous |
| `@ax/<pkg>` names | 8 of 73 don't resolve and **6 of those 8 are correct prose** |
| cited line numbers in range | **0 findings corpus-wide** |
| **repo paths** | **150 checkable → 4 findings → 0 false positives** ✅ |

The `@ax/<pkg>` result is the load-bearing one and it generalises: **`decisions.md` has an
*Alternatives rejected* column, so it is structurally full of deliberate references to things that do
not exist.** "`@ax/database-sqlite` doesn't exist" is a *true sentence* that a package-existence guard
reports as rot. Any existence check over that file has an irreducible false-positive floor.

The line-range class is the §3.7 vacuity trap in a new costume: line refs rot in **content**, never
out of bounds, so the check passes while the real defect walks past.

And the justification was wrong on its own terms: **TASK-241's hook existed** (the false claim was
"no production caller") and **TASK-245 was stale advice**. Neither is a missing symbol.

**Rule for the next plan:** measure a proposed guard's *false-positive rate* before building it, not
just its finding rate. A guard is a claim, and an unmeasured guard is the same defect it exists to
catch.

---

## 2. The measurement pass now covers REMEDIES, not just diagnoses

**3 cards measured, 3 materially wrong** — consistent with the prior 7-of-8. But the new information
is *where* they were wrong: **in two of three, the fix as specified was wrong, not merely the
description.**

- **TASK-314** told the builder to replace "`waitFor` gets its first look on a later macrotask" with
  "`waitFor` runs inside React's `act()`". **Both false.** RTL's `asyncWrapper` calls
  `setReactActEnvironment(false)` for the duration; the committed-state guarantee comes from an
  awaited `setTimeout(…, 0)` at *resolution*. Writing the fix as specified would have put a **third**
  false claim into the very bullet the card exists to correct. Settled with a throwaway probe.
- **TASK-317** told the builder to pull `postgres:16`. **No test ever starts it** — all 8 occurrences
  are inert string literals in schema tests. The real set is 115 call sites, 100% `postgres:16-alpine`.
- **TASK-315** was substantially right, but one claim was **provably false**: `skip (not a
  draft-issue card)` is unreachable from a malformed id (that branch needs `gh` to exit **0** with a
  resolvable node of the wrong type). The same falsehood was committed in **two other places**.

This extends TASK-269's lesson from descriptions to **prescriptions**. Budget it.

---

## 3. The rot loop reproduced itself inside the PR built to stop it — three times

This is the strongest evidence yet that §11's loop-3 diagnosis was right.

1. A comment cited `mistakes.md:294`. **The PR's own +2-line insertion** moved that lesson to 296.
2. A header said "157 examined / 239 skipped". **The PR's own rooting fix** moved one from skipped to
   examined, making it 158/238 before it landed.
3. A **fourth** file moved by #395 (`system-prompt.ts`) was missed by the sibling sweep because its
   citation was **unrooted** — invisible to the new guard.

**No test caught any of them.** All three were caught by a reviewer *reading prose*. That is the
whole thesis: tests pin behaviour, nothing reads prose.

**The generalised rule now in `mistakes.md`:** prose that COUNTS or LOCATES something the same commit
also edits must be written **last**, re-derived from the final tree — or expressed as a **ratio or a
name** rather than an index. Fixed here by saying "about two in five" instead of two integers, which
is the same rule as citing the file rather than the line.

---

## 4. Both guards had a structural blind spot, and both first drafts claimed completeness

Independently, in the same session:

- **The memory-path guard cannot see *unrooted* citations.** Its gate requires the containing
  directory to be git-tracked (that gate is what buys 0 false positives), so `agent-runner-core/...`
  without a leading `packages/` is invisible. Its review found a real stale one. **Only ~2 in 5 of the
  literal path citations are examined at all.**
- **TASK-317's pull-list guard cannot see what a *dependency* starts on its own initiative.**
  `testcontainers` runs the Ryuk reaper alongside every `.start()` through the same `pullImage` path,
  and Ryuk appears in **no test source**. The first draft closed the postgres vector while asserting
  in its comments that nothing was left to pull.

**Decision now recorded:** a scan-based guard must document what it cannot see **by construction, in
the guard itself**. A guard that overstates coverage is worse than a narrower honest one, because the
next reader stops looking. Both guards now say so. (Ryuk was *disabled* in CI rather than pre-pulled —
a runner is destroyed at job end, so the reaper buys nothing, and a pinned library-internal tag is
something no guard could police.)

---

## 5. TASK-315's fix reintroduced its own bug class in its detection layer

Worth its own section because it is the cleanest instance of the pattern in the whole epic.

The `hb.sh` wrapper detected the new malformed-id class by **grepping the helper's output** for
`MALFORMED-ID`. But `append_progress`'s *success* line echoes caller-supplied text — so a progress
note that merely mentioned that literal reported a **landed heartbeat** as
`HEARTBEAT-FAILED(caller)`. That is this card's exact bug — one signal borrowing another's channel —
rebuilt inside the fix, in a file auto-ship itself ships changes to.

Caught by review, reproduced against the prior commit, fixed by keying on `rc -eq 2`.

**Rule:** classify on a **return code**, never on output text that can contain caller-supplied
content. Also: **order your glob arms** — `"PVTI_a PVTI_b"` *does* start with `PVTI_`, so a prefix
test alone waves the real bug through.

---

## 6. Orchestration: agents finish and do not deliver

**4 of 4 agents** this session (two `Explore` measurements, one `ax-code-reviewer`, one `yolo-ship`
builder) completed their work and emitted **only an idle notification with no report**. All four
delivered in full on a single `SendMessage` asking for the report in a named format.

This is **distinct** from session-6 §5.2 (where `ax-code-reviewer` has no `SendMessage` so its text
routes *up* to the orchestrator instead of across to its builder). Here the text was not delivered
anywhere until asked for.

**Do:** when an agent notifies idle with no content, `SendMessage` it once with an explicit field
list, and say that an honestly-labelled partial beats a confident summary of unchecked work. **Never
re-dispatch** — the work is done, only the delivery failed. Re-dispatching here would have discarded
four complete results, one a 2-hour build.

Also: **the scratchpad directory is shared.** A builder overwrote the orchestrator's pending commit
message. Namespace what you write there.

### Infra failures this session
- **Machine sleep** killed the first TASK-314 builder with **zero commits** and a half-written
  worktree (73 files never checked out). Nothing salvageable; removed and re-dispatched cleanly.
  Session 6's "commit early and often" is why the other three survived their rebases.
- **CodeQL caught a real bug in my own guard** — `POLLER.replace(/\./g, '\\.')` is incomplete regex
  escaping (`-` and `$` survive). Fixed with a literal pattern. Treat a CodeQL failure on a
  markdown-and-tests PR as real, not as noise.
- The aggregate `CodeQL` check can fail while every `Analyze (*)` job succeeds — that is code
  scanning reporting an **alert**, not a build failure. Read `code-scanning/alerts?pr=N`.

---

## 7. §12 Step 4 — the tally, and the recommendation

**Merged this session: 5. Filed this session: 4** (TASK-319, 320, 321, 322).

**Ratio: 4 filed : 5 merged = 0.8 : 1 — below 1:1 for the first time in four sessions.**

Read honestly, it is better than that:
- **TASK-319** came from a *human ruling*, not a drain defect — it was the session-6 open question
  being closed. Excluding it, the drain generated **3** cards while merging **5**: **0.6 : 1**.
- One follow-up (the lint warning) was **fixed rather than filed**, deliberately — see §8.
- None of the four is a defect the drain *created*; all four are real, and three came from builders
  hitting them while doing carded work (exactly §11's loop 2, "the system working").

**Per §12 Step 4, that means: keep going.** The epic is converging on the metric the last plan chose.

**But two cautions before anyone declares victory:**

1. **One session below 1:1 is n=1.** Sessions 4, 5 and 6 were all above it. The honest move is to
   re-measure after the *next* session before concluding the trend changed — §12's own warning that
   "the next wave is the last one" has been wrong four sessions running applies to optimism too.
2. **This session was deliberately loaded with the cheapest-converging work.** §12 sequenced rot
   remediation and two small infra cards precisely because they were small. The remaining To Do lane
   (302, 313, 318, 321) is *not* that shape — 302 and 318 both explicitly need a measured wall-clock
   cost before a remedy can be chosen, and 318's remedy risks making CI slower. A 0.8:1 session on
   easy cards does not predict a 0.8:1 session on those.

**My recommendation: run one more session on the current queue, then decide.** If it also lands below
1:1 on the *harder* cards, the epic is genuinely converging and should simply be finished. If it does
not, take §11(c) and **time-box it** — close the epic and let the remainder compete with everything
else on the board. Do not run a fifth session on the assumption that the next wave is the last one.

---

## 8. What survived from session 6, unchanged

Every one of these was exercised and held:

- **`reviewer: clean` is the merge gate.** Held on all 5. Two builders ran multiple review rounds.
- **`git merge-tree --write-tree origin/main HEAD`, not `gh`'s `mergeable`.** Used on every merge.
  Zero bad merges. Two builders hit genuine `decisions.md` append-vs-append conflicts on rebase and
  resolved them correctly.
- **Re-read CI at the head the handoff names.** I verified `headRefOid` against the claimed SHA on
  every PR before merging. All matched.
- **Drop `--delete-branch`; push-delete separately.** Worked on all 5.
- **Dispatch reviewers STRICTLY READ-ONLY** (§5.3). Every dispatch carried the verbatim sentence. **No
  reviewer touched a builder's tree this session** — the damage class from #476 did not recur.
- **Hand every agent its card body as a local file path.** Done for all three; no board queries.
- **`pnpm install` then `pnpm build` before any package test in a fresh worktree.** No spurious
  `channel-web` failures occurred.
- **The `--limit` trap is real:** `gh project item-list --limit 200` silently truncated at exactly 200
  on a 346-item board. Use ≥ 700.

### Two new mechanical notes
- **`gh project item-create` has no `--body-file`.** Use `--body "$(cat file)"`. And it will print a
  success-shaped result while creating nothing if you get the flags wrong — assert on the returned id.
- **Editing a draft card's body needs the `DI_` content id, not the `PVTI_` item id.** Resolve it with
  `node(id:)  { ... on ProjectV2Item { content { ... on DraftIssue { id } } } }`.

---

## 9. Loose ends

- **Branch residue is much larger than §9 estimated.** Measured: **170** remote `auto-ship/*`, **18**
  local `auto-ship/*`, and **101** local `worktree-agent-*` branches. §9 said ~168 remote and 15
  local. All 5 of this session's branches were push-deleted on merge (verified 0 remain). This is
  still **a human's call** — it is ~290 deletions and an orchestrator should not do it unilaterally.
- **Three agent worktrees are harness-locked and still on disk** (`.claude/worktrees/agent-*`) with
  their agents completed. `git worktree remove --force` refuses; `-f -f` would override. They are
  **harmless** — TASK-309's two ignore globs hold, and `pnpm lint` is silent — so I left them for the
  harness rather than fighting it.
- **Still deferred, from TASK-316 and still not carded:**
  `deploy/charts/ax-next/tsconfig.json` is not in the root `tsc --build` graph, so `pnpm typecheck`
  never type-checks the chart test sources; and the 4-line `findHelm` helper is duplicated across
  three chart test files.
- **Cosmetic, from TASK-315:** the `hb.sh` wrapper comment reads "check it FIRST. Two reasons. (1)
  First, because…" — doubled "First". Both builder and reviewer judged it not worth a CI cycle. Fold
  into any later edit of that block.
- **TASK-317's unconditional pre-pull** costs ~4s on a PR that selects no container package. Gating it
  would mean duplicating the affected-package selection logic inside the test step — a worse trade at
  4s, but revisit if the image list ever grows.
- **The `@ax/auth-better` / `@ax/mcp-client` contention flake** now has real evidence appended to
  **TASK-318**, including the distinction that matters: the `auth-better` case presents as an
  **assertion** failure (which project memory reads as a real product race) but is actually a
  **fixed-iteration poll budget** (200 × 10ms) giving up on slow-but-correct DB work. That is a third
  category and TASK-318 should record it.
- **Local runs do not set `TESTCONTAINERS_RYUK_DISABLED`** (only CI does), so anyone reproducing
  TASK-318 locally runs ~2× the container count that card estimates. Say which mode you measured in.

---

## 10. How to resume

> Resume the agent-workspace follow-ups. Read
> `docs/plans/2026-08-24-agent-workspace-followups-session-7.md` first — it is the current handoff.
> **§1 records where the previous plan's own premise was wrong**, and §2 is the one change to the
> method: **the measurement pass must cover a card's proposed FIX, not just its diagnosis** — in 2 of
> 3 cards last session the remedy as specified was wrong. Session 6's dispatch discipline (its §5 and
> §7) all held and is summarised in §8 here; follow it. §6 adds one new failure mode: **an agent that
> notifies idle with no report has a delivery failure — ask once, never re-dispatch.**
> **Before draining further, read §7** — the file:merge ratio went below 1:1 for the first time, but
> on deliberately easy cards, and the remaining lane is not that shape.

Journal: `.claude/auto-ship-log.md` (gitignored).

---

## 11. Board state at handoff

**To Do (7, all deps `none` — every one ready):**

| Card | Note |
|---|---|
| TASK-302 | hook budgets — **needs a measured wall-clock cost first**; a budget change fixes none of the three observed failures, and the card says so |
| TASK-313 | `FireNowOutput.fireId` → `conversationId`. **Spec, not a question** — ruling folded in. Wants `ux-design` for copy, `shadcn` if it adds a link |
| TASK-318 | concurrency bound — **needs measurement first**; the wrong instrument (global `fileParallelism:false`) adds ~15 min to a 8–9.5 min job. Now carries this session's evidence |
| TASK-319 | reach digest omits pinned OAuth endpoints — **Important**, on the human ruling |
| TASK-320 | two `patterns.md` "deleting X reddens Y" claims never executed — rot-track work |
| TASK-321 | postgres tag hardcoded 115× + the CI pull list is a 116th copy. **"Do nothing" is a legitimate outcome** if the boundary cost exceeds the bump cost |
| TASK-322 | `mkdtempSync` without cleanup across `scripts/__tests__` — **premise measured FALSE**: every `mkdtempSync` under `scripts/` already cleans up, and an isolated-`TMPDIR` run leaks nothing. The real leak was one its grep could not see: the linked worktree in `memory-write-target.test.js` was created **outside** the dir the suite removes, cleaned only by a swallowed `git worktree remove`. Fixed there instead |

**Waves 6/7 remain in Backlog:** 246, 248, 249, 250, 257, 258, 273, 242, 244, 263, 286.

Suggested order, by §11(b) value class (machinery that throttles the drain first): **320** (rot track,
continues steps 1–2), then **319** (Important, security-relevant), then **322** (trivial), then
**302 / 318** as a measured pair, then **313**, then **321** (which may close as analysed-not-built).
