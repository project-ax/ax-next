# agent-workspace follow-ups — session 3 handoff

**Written:** 2026-08-23, end of the Wave-2 run.
**Supersedes:** `docs/plans/2026-08-22-agent-workspace-followups-session-2.md` for resuming.
That document remains accurate about what Wave 1 shipped and why; its §4 wave list is still
the best map, with the corrections in §4 below.
**Still the base map for Waves 3–7:** `docs/plans/2026-08-22-agent-workspace-followups.md` —
trust it on **wave membership**, not on **card detail**. See §2.

**Repo state at handoff:** `main` @ `b1653b0e`, CI green, **0 open PRs**, every lane
**empty**, 0 in flight, 0 parked. Fully quiesced — safe to resume cold.

---

## 1. What shipped this session

The epic is **acceptance-complete** and **Wave 2 is drained 6/6**. Nine PRs.

| Card | PR | What landed |
|---|---|---|
| TASK-277 | #444 | Approve routes on a **live session lookup**, not stored attendance; `deliverResolution`'s return is read, not discarded |
| TASK-279 | #445 | `decisions:executed` **deleted**; the Activity receipt is *derived* from the decision row |
| TASK-268 | #446 | The reviewer was never hung — dispatch shape pinned; retrieval before re-dispatch |
| TASK-264 | #447 | A failed grants read no longer renders as "nothing granted" |
| TASK-253 | #448 | Stranded in-flight replays are reclaimed; a refused re-approval is loud |
| TASK-254 | #449 | One question per held call — the duplicate collapses at the gate |
| TASK-267 + TASK-284 | #450 | Ask the table, not the evaluator; a failed catalog read reports `failed` |
| TASK-265 | #451 | The rail publishes only counters it can back — and the guard now says so |
| TASK-266 | #452 | `decisions:count` over a window; 7 expiry sweeps per render → 0 |

Both acceptance walks (**TASK-236**, **TASK-237**) re-ran on `kind-ax-next-dev` and **PASS**.
TASK-237's last unmet criterion — *"an undone execution removes its Activity receipt"* —
passes with **no removal logic at all**: undo restores the row to `pending`, so a derived
receipt stops being derivable. `0 → 1 → undo → 0`, driven through the real `decisions:undo`.

---

## 2. Read this before you trust any card

**Three of six Wave-2 cards were wrong about their own bug**, and in two cases the real defect
was materially worse than the filed one. **Measure the premise before you build.**

### 2.1 TASK-254 understated a live double execution
Filed as *"approving the second absorbs a unique violation"*. Measured on `main`, unattended
path: **the executor ran twice**, both rows `executed`, nothing refused. The partial index
`decisions_v1_authorised_unconsumed` carries `replayed_at IS NULL`, so the first replay
**frees the slot**. The "absorb" only ever applied to paths where the call had not gone out.

### 2.2 TASK-265's premise was already dead; the guard was the defect
Neither counter had rendered since TASK-235 (#439). What was broken was the test meant to
keep them out — it asserted on counter **ids**, so re-injecting under a different id stayed
**green** while the rail told a person they had overruled their agent once.

### 2.3 TASK-277's root cause was broader than "stale liveness"
`Decision.attendance` never meant "an agent is warm". `attendance.ts` computes it as
`origin === 'web' ? attended : unattended` — a property of **which channel opened the
conversation**, so a web thread is `attended` *forever*, not merely until the idle floor
expires.

### 2.4 TASK-279's own acceptance was ruled against
Its card said "wire a subscriber that writes a receipt". Ruled the other way: **derive the
receipt and delete the fire.** Invariant #3 satisfied by removal, which the Half-Wired Code
Policy prefers over a speculative consumer. The fire had **three** sites, not the one the card
named — two hid behind the `emitExecuted` helper, including undo's own `retracted` receipt.

### 2.5 TASK-268's card gives a prescription that would break the reviewer
It cites `isolation: "worktree"` as the shape that returns normally. True — and **wrong for a
reviewer**, which would then get a *fresh* worktree and review the wrong tree. The variable is
`name`, not isolation.

### 2.6 TASK-253's surface grew mid-session
PR #444 added `store.claimReplayFlight`, creating a **third** way to strand a row that did not
exist when the card was written.

### 2.7 Stale in the session-2 doc
Its Wave 6 line says "fix 257 and TASK-234 together". **TASK-234 is already Done.** Also
**TASK-255 is not tagged `epic: agent-workspace`**, so it will not appear in an epic-filtered
board query even though the wave list names it.

---

## 3. Cards filed this session

| Card | Status | Why |
|---|---|---|
| **TASK-286** | Backlog | **A live double execution.** `restore` takes no collapse lock and never checks for a colliding open row, so *dismiss → agent re-asks → undo* leaves two open rows, and the free-the-slot mechanism runs a reversible unattended call twice. **Pinned by a test that asserts the silence** (both errors null), deliberately not closed — closing it changes what Undo means. **Needs a human ruling.** |
| **TASK-285** | Backlog | A **timed-out** replay still says *"Nothing was completed"* — the same lie TASK-253 removed for crashes, pointed at timeouts. A timeout means only that we stopped waiting; the email may have sent. |
| **TASK-283** | Backlog | The Activity feed's exclusive instant cursor drops the second of two rows sharing a millisecond across a page boundary. Pre-existing; merging two independent streams retired the old "fires are seconds apart" rationale. Fix named: a composite `(instant, id)` cursor. |
| **TASK-282** | Backlog | The **aisdk** agent told the user *"I've automatically filed a request with your admin"* having run only `search_catalog`. No decision row, no catalog row. claude-sdk is correct on the identical prompt. |
| TASK-281 | **Done** | Obviated with zero work by TASK-279 — confirmed by grep on merged `main` plus a regression test, not assumed. |
| TASK-284 | **Done** | Merged with TASK-267 in #450. |

---

## 4. The remaining waves

**Wave 3 — silent failures and honesty (do next).** `TASK-239, TASK-240, TASK-238, TASK-252,
TASK-256`, folding in **TASK-272, TASK-276, TASK-274** — same defect family, and 272/276 will
share a test harness with the others. All eight are dep-free.

`TASK-282` is the same family but is **agent-prompt** work with an eval, not a code fix —
schedule it on its own.

**Wave 4 — infrastructure:** `TASK-255` (see §2.7 — untagged), `TASK-246`, `TASK-248`.
TASK-266 is Done. Note TASK-266 **did not** fix TASK-246: `decisions:list`'s inline sweep is
untouched, it merely stopped being multiplied by seven.

**Wave 5 — one-source-of-truth / boundary hygiene:** `TASK-245, TASK-251, TASK-241, TASK-243,
TASK-262, TASK-269`.

**Wave 6 — gates the preview flag ON:** `TASK-249, TASK-250, TASK-258, TASK-257`, plus
**TASK-273** (no ErrorBoundary anywhere in `channel-web` — any render throw blanks the chat).
TASK-234 is Done; ignore the pairing instruction.

**Wave 7 — deferred design questions:** `TASK-242, TASK-263, TASK-244`, plus **TASK-286**
(needs a ruling on undo semantics).

**Ready to build now, rulings already on the cards:** `TASK-275`, `TASK-280`.

---

## 5. Human rulings made this session

Recorded on the cards themselves; they replace those cards' original acceptance.

- **Spawn cap: removed.** File every finding.
- **TASK-280 — intended.** Undo is a grace period *before* the agent acts, never a reversal.
  So `approved-pending-agent` is the only undoable state, and host-replayed calls must not
  offer the control at all. Verified on cluster: `undoable:false`, zero Undo buttons rendered.
- **TASK-275 — both halves.** Keep the polite live-region announcement, do **not** move focus
  (the card appears because the *agent* hit a hold, not because the user did anything).
  Send-during-hold is **blocked with an explanation** — dimming alone is not acceptable;
  queueing was considered and rejected.
- **TASK-265 — hide, don't build.** Both unbacked counters stay hidden until each has a real
  producer. Building an undo trace was **rejected outright**: it would make `decisions:undo`
  leave a durable record that a person changed their mind — a schema change and a privacy
  question — to fill a counter nobody asked for.

---

## 6. What this run actually taught — the durable part

**Eleven false comments** have now been found across this epic, several *inside fixes for that
same class*, three written and self-caught in one session. In every case the comment framed
the question and the reader answered *that* instead of checking the code. Treat any comment
you touch as load-bearing.

Three test-discipline findings that outlast the cards:

1. **Vacuity-checking is necessary but NOT sufficient.** A test can go red on revert and still
   pin the **wrong contract** — TASK-267's `toHaveLength(1)` pinned an H4 silence its own
   design doc explicitly rejected. The bar is: **read the assertion back as a sentence about
   the product** and ask whether that sentence is what we want to be true. Every
   "green test pinning the wrong contract" on this epic passes a vacuity check, including the
   canary that let TASK-277 reach a walk.
2. **A guard must pin the CLAIM, not a representation of it.** TASK-265's original guard
   checked *ids*; its first replacement checked *labels*; a synonym walked through both. Only
   naming the backed set works.
3. **A mutation that reports green is itself a claim.** One was a silent no-op
   (`[] as never[] && [...]` — an empty array is truthy), caught only because a *passing*
   mutation is the wrong answer. And reverting **one** copy of a re-stated predicate proves
   nothing: TASK-254 showed 33 fake-backed tests staying green while the real store was broken.

---

## 7. New traps — all first-hand this run

**CI**
- **A conflicting PR silently SKIPS `test` and `docker-build`.** `gh pr checks` then reports
  *"no failures"* with **4** checks instead of 9, which reads as green. **"No failures" is not
  "it ran" — count the checks.** #450 nearly merged that way.

**Agents**
- Dispatch `ax-code-reviewer` with **no `name`**. A named teammate cannot hand its findings
  back — that was every past "hang". Never `isolation: "worktree"` for a reviewer; it gets a
  *fresh* worktree. If one goes silent, `SendMessage` it for its findings **before**
  re-dispatching. (7/7 dispatches returned normally this run using the plain shape.)

**Refactoring**
- After a rename that **narrows** a meaning, grepping the symbol is not enough — **grep the
  prose that paraphrases it**. Two sentences carrying the old contract survived a clean symbol
  grep; one was in production code.

**Board** (carried forward, still true)
- `gh project item-list` needs `--limit 600` — the board has 308 items and 300 truncates.
- `gh project item-create` leaves `Status` null and invisible to every lane query. Set it
  explicitly, then **re-read the board to verify**.

**Shell** (carried forward)
- Absolute `cd` at the front of **every** Bash call; the tool keeps cwd between calls and this
  repo has been damaged by an inherited one. `pnpm --filter` goes **before** the script name.

**Cluster** (only if a walk is queued — none are)
- Rebuild the image from merged `main` and **verify the fix is baked in the running pod**
  (grep the compiled `dist` inside the pod), not just that the image is recent. The SPA bundle
  hash is **not** a staleness signal: in-image and local builds of identical source differ.

---

## 8. How to resume

Paste this:

> Resume the agent-workspace follow-ups: drain Wave 3. Read
> `docs/plans/2026-08-23-agent-workspace-followups-session-3.md` first — it is the current
> handoff. Wave 3 is §4's list. **Read §2 before trusting any card**: three of six Wave-2
> cards were wrong about their own bug, so measure the premise before building. §5 has the
> rulings, §6–7 the process that earned its keep. TASK-286 needs a ruling from me, not a fix.

Journal: `.claude/auto-ship-log.md` (gitignored) has the minute-by-minute timeline.
Project memory: `.claude/memory/patterns.md`, `mistakes.md`, `decisions.md` all gained rows
this run; the user-level note is `project_agent_workspace_acceptance_complete.md`.
